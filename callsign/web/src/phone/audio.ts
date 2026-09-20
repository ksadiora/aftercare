/**
 * Everything that makes noise, listens for loudness, or keeps the screen on,
 * for the phone app.
 *
 *   unlockAudio()      call inside the pairing tap: iOS only lets a page play
 *                      sound after a gesture, so we create the AudioContext,
 *                      the shared <audio> element (wired through an analyser
 *                      so the orb can see it) and prime speechSynthesis there.
 *   startRinging()     marimba-style ringtone from the Web Audio API + vibration
 *   speak(text, url)   ElevenLabs mp3 through /api/phone/tts when the server
 *                      has a key, otherwise the browser's own speechSynthesis
 *                      (chunked at sentence boundaries, voices awaited)
 *   readLevel(kind)    0..1 loudness of what's playing or of the microphone,
 *                      for the orb; undefined when there is no real signal
 *   primeMic()/startMicMonitor()   mic permission + an analyser on the stream
 *   keepAwake()        screen wake lock while paired
 *   haptic(kind)       short vibration ticks (Android; iOS has no web vibration)
 *
 * Nothing in here throws: every failure degrades to silence and resolves.
 */

import { plog, pwarn } from "./log.ts";

let ctx: AudioContext | undefined;
let player: HTMLAudioElement | undefined;
let playbackAnalyser: AnalyserNode | undefined;
let wantAudio = false;

// A 1-sample silent WAV. Playing it inside the pairing tap "unlocks" the element.
const SILENT_WAV = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
export const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const IS_ANDROID = /Android/i.test(UA);
export const IS_SAFARI = /Safari/i.test(UA) && !/Chrome|CriOS|Chromium|Edg|Android/i.test(UA);
/** In-app browsers (Instagram, LinkedIn, Facebook, Twitter…) lack SpeechRecognition and often the mic. */
export const IS_WEBVIEW = /FBAN|FBAV|Instagram|LinkedIn|Twitter|Line\/|MicroMessenger|Snapchat|; wv\)/i.test(UA);
/** `?nomic=1` keeps the orb off the microphone stream (troubleshooting aid for iOS audio routing). */
const NO_MIC = typeof location !== "undefined" && /[?&]nomic\b/.test(location.search);

const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export function prefersReducedMotion(): boolean {
  return REDUCED_MOTION;
}

function audioContext(): AudioContext | undefined {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctx && AC) {
      ctx = new AC();
      ctx.onstatechange = () => {
        // iOS parks the context in "interrupted"/"suspended" after a phone call,
        // a lock-screen visit or a mic session; bring it back whenever we can.
        if (wantAudio && ctx && ctx.state !== "running") void ctx.resume().catch(() => undefined);
        for (const cb of stateListeners) cb(audioState());
      };
    }
    if (ctx?.state !== "running") void ctx?.resume().catch(() => undefined);
  } catch {
    /* no audio */
  }
  return ctx;
}

export type AudioState = "running" | "suspended" | "interrupted" | "closed" | "none";
const stateListeners = new Set<(s: AudioState) => void>();

/** Whether the ringtone and TTS can actually be heard right now. */
export function audioState(): AudioState {
  if (!ctx) return "none";
  return (ctx.state as AudioState) ?? "none";
}

export function onAudioState(cb: (s: AudioState) => void): () => void {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}

/** Try to get the context running without a gesture (works after one unlock on most platforms). */
export async function resumeAudio(): Promise<boolean> {
  try {
    const c = audioContext();
    if (!c) return false;
    if (c.state !== "running") await c.resume();
    return c.state === "running";
  } catch {
    return false;
  }
}

/** Must run synchronously inside a user gesture (the "Pair this phone" tap, "Accept", "Enable sound"). */
export function unlockAudio(): void {
  wantAudio = true;
  try {
    const c = audioContext();
    if (c) {
      // A silent blip keeps iOS from suspending the context again.
      const o = c.createOscillator();
      const g = c.createGain();
      g.gain.value = 0;
      o.connect(g).connect(c.destination);
      o.start();
      o.stop(c.currentTime + 0.02);
    }
  } catch {
    /* ignore */
  }
  try {
    if (!player) {
      player = new Audio();
      player.setAttribute("playsinline", "");
      player.preload = "auto";
      player.crossOrigin = "anonymous";
    }
    player.src = SILENT_WAV;
    void player.play().catch(() => undefined);
    wirePlaybackAnalyser();
    // Safari reports "suspended" until resume() settles; wire the analyser then.
    if (!playbackAnalyser && ctx) void ctx.resume().then(wirePlaybackAnalyser, () => undefined);
  } catch {
    /* ignore */
  }
  try {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
      void loadVoices();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Route the shared <audio> element through an AnalyserNode so the orb can
 * follow the agent's voice. Once an element is attached to a context it only
 * sounds through that context, so this happens exactly once, inside the
 * unlock gesture, and only when the context is actually running.
 */
function wirePlaybackAnalyser(): void {
  if (playbackAnalyser || !player) return;
  const c = ctx;
  if (!c || c.state !== "running") return;
  try {
    const src = c.createMediaElementSource(player);
    const an = c.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.6;
    src.connect(an);
    an.connect(c.destination);
    playbackAnalyser = an;
  } catch {
    playbackAnalyser = undefined;
  }
}

// ---------------------------------------------------------------------------
// Loudness for the orb
// ---------------------------------------------------------------------------

export type LevelKind = "playback" | "mic";

let timeBuf: Uint8Array<ArrayBuffer> | undefined;
function rms(an: AnalyserNode, gain: number): number {
  if (!timeBuf || timeBuf.length !== an.fftSize) timeBuf = new Uint8Array(new ArrayBuffer(an.fftSize));
  an.getByteTimeDomainData(timeBuf);
  let sum = 0;
  for (let i = 0; i < timeBuf.length; i++) {
    const v = (timeBuf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / timeBuf.length) * gain);
}

/** What is producing sound right now, so readLevel knows where to look. */
type PlaybackSource = "none" | "element" | "synth";
let playbackSource: PlaybackSource = "none";

// Synthetic envelope for speechSynthesis: word boundaries (when the platform
// fires them) become little pulses; otherwise the orb breathes on its own.
let boundarySeen = false;
let lastBoundaryAt = 0;
let synthStartedAt = 0;

/** External level source, e.g. the ElevenLabs real-time engine. */
let externalLevel: ((kind: LevelKind) => number | undefined) | undefined;
export function setExternalLevelSource(fn?: (kind: LevelKind) => number | undefined): void {
  externalLevel = fn;
}

/**
 * 0..1 loudness for the orb. `undefined` means there is no real signal (no
 * analyser, synth without boundary events, mic denied): animate a breath.
 */
export function readLevel(kind: LevelKind): number | undefined {
  if (externalLevel) return externalLevel(kind);
  try {
    if (kind === "mic") return micAnalyser ? rms(micAnalyser, 5.5) : undefined;
    if (playbackSource === "element") return playbackAnalyser ? rms(playbackAnalyser, 3.2) : undefined;
    if (playbackSource === "synth") {
      const now = performance.now();
      if (!boundarySeen) return now - synthStartedAt < 250 ? 0.2 : undefined;
      // A pulse that decays over ~220 ms after each word.
      const dt = now - lastBoundaryAt;
      return 0.18 + 0.72 * Math.exp(-dt / 220);
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------
//
// SpeechRecognition captures on its own; the stream here only feeds the orb
// and the level meter. On a desktop browser the stream opened by the Start
// tap is HELD for the whole session (primeMic(true)): getUserMedia then runs
// exactly once, inside a gesture, and the mic indicator in the tab stays on
// as a visible "Mic: allowed". On iOS it is released at once, because an
// open capture there routes playback to the quiet earpiece.

export type MicPermission = "granted" | "denied" | "unavailable";
/** What the Permissions API (or, failing that, our own last request) says. */
export type MicPermissionState = "granted" | "denied" | "prompt" | "unknown";

let micStream: MediaStream | undefined;
let micAnalyser: AnalyserNode | undefined;
let micSource: MediaStreamAudioSourceNode | undefined;
let micWanted = false;
let micHeld = false;
let lastMicResult: MicPermission | undefined;

/** The outcome of the last getUserMedia we made, for browsers without the Permissions API. */
export function lastMicPermission(): MicPermission | undefined {
  return lastMicResult;
}

async function getMic(): Promise<MediaStream | MicPermission> {
  if (NO_MIC) return "unavailable";
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      pwarn("getUserMedia is not available here (insecure origin or in-app browser)");
      lastMicResult = "unavailable";
      return "unavailable";
    }
    plog("getUserMedia: asking for the microphone…");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    plog("getUserMedia: granted", stream.getAudioTracks()[0]?.label || "(unnamed device)");
    lastMicResult = "granted";
    return stream;
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    const denied = name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError";
    pwarn("getUserMedia failed:", name || e, denied ? "→ blocked for this page" : "→ no usable microphone");
    lastMicResult = denied ? "denied" : "unavailable";
    return lastMicResult;
  }
}

function attachMicAnalyser(stream: MediaStream): boolean {
  try {
    const c = audioContext();
    if (!c) return false;
    micSource = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.5;
    micSource.connect(an); // never to the destination: no feedback
    micAnalyser = an;
    if (c.state !== "running") void c.resume().catch(() => undefined);
    return true;
  } catch (e) {
    pwarn("mic analyser failed", e);
    return false;
  }
}

/**
 * Ask for the microphone once, inside the pairing tap, so the permission
 * prompt happens now instead of mid-call. With `hold`, the stream stays open
 * for the session (see above) and feeds the level meter; otherwise it is
 * released at once.
 */
export async function primeMic(hold = false): Promise<MicPermission> {
  if (micHeld && micStream) return "granted";
  const out = await getMic();
  if (typeof out === "string") return out;
  if (hold) {
    micStream = out;
    micHeld = true;
    attachMicAnalyser(out);
    plog("mic held open for the session (level meter live)");
    for (const t of out.getTracks()) {
      t.onended = () => {
        pwarn("mic track ended (device unplugged or permission revoked)");
        releaseMic();
      };
    }
    return "granted";
  }
  for (const t of out.getTracks()) t.stop();
  return "granted";
}

/** Open the mic and hang an analyser on it for the orb. Idempotent; free when the stream is held. */
export async function startMicMonitor(): Promise<MicPermission> {
  if (micAnalyser) return "granted";
  micWanted = true;
  const out = await getMic();
  if (typeof out === "string") return out;
  if (!micWanted) {
    // Listening ended before the stream arrived: never leave the mic open.
    for (const t of out.getTracks()) t.stop();
    return "granted";
  }
  micStream = out;
  if (!attachMicAnalyser(out)) {
    stopMicMonitor();
    return "unavailable";
  }
  return "granted";
}

export function stopMicMonitor(): void {
  micWanted = false;
  if (micHeld) return; // the held stream lives until releaseMic()
  releaseMic();
}

/** Close the microphone for good (unpair, device lost). */
export function releaseMic(): void {
  micHeld = false;
  try {
    micSource?.disconnect();
  } catch {
    /* ignore */
  }
  micSource = undefined;
  micAnalyser = undefined;
  for (const t of micStream?.getTracks() ?? []) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
  if (micStream) plog("mic released");
  micStream = undefined;
}

/** True while an analyser is reading the microphone (the level meter has data). */
export function micLive(): boolean {
  return Boolean(micAnalyser);
}

/**
 * Follow the browser's microphone permission for this page. Chrome and Edge
 * report it live (and fire a change when the camera icon in the address bar
 * is used); Safari and Firefox throw on the query, which yields "unknown" and
 * the app falls back to lastMicPermission().
 */
export function watchMicPermission(cb: (s: MicPermissionState) => void): () => void {
  let status: PermissionStatus | undefined;
  let off = false;
  void (async () => {
    try {
      if (!navigator.permissions?.query) return cb("unknown");
      status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (off) return;
      plog("mic permission:", status.state);
      cb(status.state as MicPermissionState);
      status.onchange = () => {
        if (!status) return;
        plog("mic permission changed →", status.state);
        cb(status.state as MicPermissionState);
      };
    } catch {
      cb("unknown");
    }
  })();
  return () => {
    off = true;
    if (status) status.onchange = null;
  };
}

// ---------------------------------------------------------------------------
// Vibration (Android Chrome; iOS Safari has no Vibration API)
// ---------------------------------------------------------------------------

export function haptic(kind: "accept" | "hangup" | "tick"): void {
  try {
    navigator.vibrate?.(0);
    navigator.vibrate?.(kind === "accept" ? [35] : kind === "hangup" ? [25, 70, 25] : [12]);
  } catch {
    /* unsupported */
  }
}

// ---------------------------------------------------------------------------
// Ringtone
// ---------------------------------------------------------------------------

// A bright marimba figure, twice, then a pause: E5 G#5 B5 E6 · B5 G#5 E5 — loops every 2.4 s.
const RING_NOTES: Array<[number, number]> = [
  [659.25, 0], [830.61, 0.14], [987.77, 0.28], [1318.5, 0.42],
  [987.77, 0.64], [830.61, 0.78], [659.25, 0.92],
];
const RING_PERIOD_MS = 2400;
// Two firm buzzes per ring, like a handset: buzz · gap · buzz · rest (sums to under one period).
const RING_VIBRATION = [320, 140, 320, 1200];

let ringTimer: number | undefined;
let vibrateTimer: number | undefined;
let ringNodes: Array<{ osc: OscillatorNode; gain: GainNode }> = [];
let ringingNow = false;
let vibrated = false;

function pluck(c: AudioContext, freq: number, at: number) {
  const gain = c.createGain();
  gain.connect(c.destination);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.5, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const overtone = c.createOscillator();
  overtone.type = "triangle";
  overtone.frequency.value = freq * 2;
  const og = c.createGain();
  og.gain.value = 0.12;
  osc.connect(gain);
  overtone.connect(og).connect(gain);
  osc.start(at);
  overtone.start(at);
  osc.stop(at + 0.6);
  overtone.stop(at + 0.6);
  ringNodes.push({ osc, gain }, { osc: overtone, gain });
  osc.onended = () => {
    ringNodes = ringNodes.filter((n) => n.osc !== osc && n.osc !== overtone);
  };
}

function ringOnce() {
  const c = audioContext();
  if (!c) return;
  const t0 = c.currentTime + 0.02;
  for (const [f, dt] of RING_NOTES) pluck(c, f, t0 + dt);
}

function vibrateOnce() {
  try {
    vibrated = Boolean(navigator.vibrate?.(RING_VIBRATION));
  } catch {
    /* unsupported */
  }
}

export function startRinging(): void {
  if (ringingNow) return;
  ringingNow = true;
  plog("ringtone start, audio context:", audioState());
  ringOnce();
  vibrateOnce();
  ringTimer = window.setInterval(ringOnce, RING_PERIOD_MS);
  vibrateTimer = window.setInterval(vibrateOnce, RING_PERIOD_MS);
}

export function stopRinging(): void {
  ringingNow = false;
  window.clearInterval(ringTimer);
  window.clearInterval(vibrateTimer);
  ringTimer = vibrateTimer = undefined;
  for (const n of ringNodes) {
    try {
      n.gain.gain.cancelScheduledValues(0);
      n.gain.gain.value = 0;
      n.osc.stop();
    } catch {
      /* already stopped */
    }
  }
  ringNodes = [];
  if (vibrated) {
    vibrated = false;
    try {
      navigator.vibrate?.(0);
    } catch {
      /* unsupported */
    }
  }
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

let cancelCurrent: (() => void) | undefined;

/** Stop whatever is playing and resolve its promise. */
export function cancelSpeech(): void {
  cancelCurrent?.();
  cancelCurrent = undefined;
  playbackSource = "none";
}

/**
 * Say `text`. Tries the server TTS URL first (200 audio/mpeg → play it through
 * the unlocked <audio>); a 204 or any failure falls back to speechSynthesis.
 * Resolves when playback has finished or was cancelled.
 */
export async function speak(text: string, ttsUrl: string, onStart?: () => void): Promise<void> {
  cancelSpeech();
  const clean = text.trim();
  if (!clean) return;
  let cancelledEarly = false;
  cancelCurrent = () => {
    cancelledEarly = true;
  };
  const t0 = performance.now();
  const started = () => {
    plog(`audio started after ${Math.round(performance.now() - t0)} ms`);
    onStart?.();
  };
  const played = await playServerTts(ttsUrl, () => cancelledEarly, started).catch((e) => {
    pwarn("server TTS failed, using the browser voice", e);
    return false;
  });
  if (played || cancelledEarly) return;
  await speakSynth(clean, started);
}

async function playServerTts(url: string, cancelled: () => boolean, onStart: () => void): Promise<boolean> {
  const el = player;
  if (!el) return false;
  const r = await fetch(url, { headers: { accept: "audio/mpeg" } });
  if (r.status !== 200 || !(r.headers.get("content-type") ?? "").includes("audio")) return false;
  const blob = await r.blob();
  if (!blob.size || cancelled()) return cancelled();
  const c = ctx;
  if (c && c.state !== "running") await c.resume().catch(() => undefined);
  const src = URL.createObjectURL(blob);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      el.onended = el.onerror = el.onplaying = null;
      URL.revokeObjectURL(src);
      cancelCurrent = undefined;
      playbackSource = "none";
      resolve(ok);
    };
    cancelCurrent = () => {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      finish(true);
    };
    el.onended = () => finish(true);
    el.onerror = () => finish(false);
    el.onplaying = () => onStart();
    el.src = src;
    playbackSource = "element";
    el.play().catch(() => finish(false));
  });
}

let voicesCache: SpeechSynthesisVoice[] = [];
const VOICES_TIMEOUT_MS = 1500;
/** Voices arrive asynchronously on iOS and Chrome; wait for them once, briefly. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    try {
      const v = window.speechSynthesis.getVoices();
      if (v.length) {
        voicesCache = v;
        return resolve(v);
      }
      const timer = window.setTimeout(() => resolve(voicesCache), VOICES_TIMEOUT_MS);
      window.speechSynthesis.addEventListener(
        "voiceschanged",
        () => {
          window.clearTimeout(timer);
          voicesCache = window.speechSynthesis.getVoices();
          resolve(voicesCache);
        },
        { once: true },
      );
    } catch {
      resolve([]);
    }
  });
}

const PREFERRED = ["Samantha", "Karen", "Google US English", "Microsoft Aria", "Aria", "Natural", "Online", "Moira", "Daniel"];

export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const en = voices.filter((v) => /^en[-_]?/i.test(v.lang));
  for (const p of PREFERRED) {
    const hit = en.find((v) => v.name.includes(p)) ?? voices.find((v) => v.name.includes(p));
    if (hit) return hit;
  }
  return en.find((v) => /US/i.test(v.lang)) ?? en[0] ?? voices[0];
}

/** Split at sentence boundaries; Chrome cuts utterances longer than ~15 s. */
export function chunkForSpeech(text: string, max = 200): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}

// Chrome garbage-collects an unreferenced utterance mid-speech (its onend never fires); hold it.
let currentUtterance: SpeechSynthesisUtterance | undefined;

async function speakSynth(text: string, onStart: () => void): Promise<void> {
  if (!("speechSynthesis" in window)) {
    // No voice at all: give the judge time to read the caption instead.
    onStart();
    playbackSource = "synth";
    boundarySeen = false;
    synthStartedAt = performance.now();
    await new Promise<void>((r) => {
      const t = setTimeout(r, Math.min(9000, 800 + text.length * 45));
      cancelCurrent = () => {
        clearTimeout(t);
        r();
      };
    });
    playbackSource = "none";
    return;
  }
  const synth = window.speechSynthesis;
  const voices = await loadVoices();
  const voice = pickVoice(voices);
  let cancelled = false;
  let abortChunk: (() => void) | undefined;
  cancelCurrent = () => {
    cancelled = true;
    try {
      synth.cancel();
    } catch {
      /* ignore */
    }
    abortChunk?.(); // resolve now; some engines never fire onend for a cancelled utterance
  };
  playbackSource = "synth";
  boundarySeen = false;
  synthStartedAt = performance.now();
  try {
    if (synth.speaking || synth.pending) {
      synth.cancel(); // clear anything queued, then let the engine settle: speak() right after cancel() drops the line on some builds
      await new Promise((r) => setTimeout(r, 60));
    }
  } catch {
    /* ignore */
  }
  let first = true;
  for (const part of chunkForSpeech(text)) {
    if (cancelled) break;
    await speakChunk(synth, part, voice, () => cancelled, (abort) => (abortChunk = abort), first ? onStart : undefined);
    first = false;
  }
  abortChunk = undefined;
  if (cancelCurrent && !cancelled) cancelCurrent = undefined;
  playbackSource = "none";
}

function speakChunk(
  synth: SpeechSynthesis,
  text: string,
  voice: SpeechSynthesisVoice | undefined,
  cancelled: () => boolean,
  onAbortable: (abort: () => void) => void,
  onStart?: () => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let keepAlive: number | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearInterval(keepAlive);
      window.clearTimeout(guard);
      if (currentUtterance === u) currentUtterance = undefined;
      resolve();
    };
    onAbortable(finish);
    const u = new SpeechSynthesisUtterance(text);
    currentUtterance = u;
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else u.lang = "en-US";
    u.rate = 1.0;
    u.pitch = 1.0;
    u.onstart = () => {
      synthStartedAt = performance.now();
      onStart?.();
    };
    u.onboundary = () => {
      boundarySeen = true;
      lastBoundaryAt = performance.now();
    };
    u.onend = finish;
    u.onerror = finish;
    // Chrome on Android sometimes never fires onend; never hang the call on it.
    const guard = window.setTimeout(finish, 2500 + text.length * 95);
    try {
      if (cancelled()) return finish();
      synth.speak(u);
      // Desktop Chrome stops long utterances after ~15 s unless nudged (chunks keep us under, this is belt and braces).
      if (!IS_IOS && !IS_ANDROID && !IS_SAFARI) {
        keepAlive = window.setInterval(() => {
          if (synth.speaking && !synth.paused) {
            synth.pause();
            synth.resume();
          }
        }, 10_000);
      }
    } catch {
      finish();
    }
  });
}

// ---------------------------------------------------------------------------
// Wake lock
// ---------------------------------------------------------------------------

type WakeLockSentinelLike = { release(): Promise<void>; released?: boolean };
let sentinel: WakeLockSentinelLike | undefined;
let wantAwake = false;

async function requestLock() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wl) return;
    if (sentinel && !sentinel.released) return;
    sentinel = await wl.request("screen");
  } catch {
    sentinel = undefined;
  }
}

export function keepAwake(): void {
  wantAwake = true;
  void requestLock();
}

export function releaseAwake(): void {
  wantAwake = false;
  void sentinel?.release().catch(() => undefined);
  sentinel = undefined;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (wantAwake) void requestLock();
    if (wantAudio) void resumeAudio();
  });
}
