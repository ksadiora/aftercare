/**
 * Sound for the caller page (/call): a ringback tone while Dr. Patel's agent
 * checks the caller and while her phone rings, a low three-beep "rejected"
 * tone, a tick when the call connects, her lines read aloud with the
 * browser's own voice, and one-shot dictation for the Talk button.
 *
 * Everything is synthesized on the spot; no audio files. Browsers only let
 * audio start after a user gesture, so `unlockAudio` runs from the Call
 * button's click handler.
 */

let ctx: AudioContext | undefined;

function audio(): AudioContext | undefined {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return undefined;
  }
}

/** Call from a click handler so the tones that follow are allowed to play. */
export function unlockAudio() {
  audio();
  try {
    // Prime speechSynthesis too: some browsers need a gesture-bound utterance before they will speak later.
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch {
    /* no speech */
  }
}

function note(c: AudioContext, freq: number, at: number, dur: number, peak: number, type: OscillatorType = "sine") {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

/**
 * North American ringback: 440 Hz + 480 Hz, 2 s on, 4 s off. Returns a stop
 * function. Soft, so it sits under the presenter's voice.
 */
export function startRingback(): () => void {
  const c = audio();
  if (!c) return () => undefined;
  const g = c.createGain();
  g.gain.value = 0;
  g.connect(c.destination);
  const oscs = [440, 480].map((f) => {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    o.connect(g);
    o.start();
    return o;
  });
  const burst = () => {
    const t = c.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.04);
    g.gain.setValueAtTime(0.05, t + 1.94);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
  };
  burst();
  const iv = window.setInterval(burst, 6000);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(iv);
    const t = c.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0, t, 0.02);
    for (const o of oscs) o.stop(t + 0.15);
  };
}

/** Three descending beeps: the call did not go through. */
export function playRejected() {
  const c = audio();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.01;
  note(c, 392, t, 0.16, 0.14, "triangle");
  note(c, 330, t + 0.2, 0.16, 0.14, "triangle");
  note(c, 262, t + 0.4, 0.3, 0.14, "triangle");
}

/** One soft mid note: verified, but held. */
export function playHeld() {
  const c = audio();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.01;
  note(c, 440, t, 0.22, 0.1);
  note(c, 440, t + 0.28, 0.22, 0.08);
}

/** A short rising tick: she picked up. */
export function playConnected() {
  const c = audio();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.01;
  note(c, 659.25, t, 0.1, 0.08);
  note(c, 987.77, t + 0.09, 0.18, 0.08);
}

// ---------------------------------------------------------------------------
// Her voice on this page
// ---------------------------------------------------------------------------

const PREFERRED = ["Samantha", "Karen", "Google US English", "Microsoft Aria", "Aria", "Natural", "Online", "Moira", "Daniel"];
let voicesCache: SpeechSynthesisVoice[] = [];

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    try {
      const v = window.speechSynthesis.getVoices();
      if (v.length) {
        voicesCache = v;
        return resolve(v);
      }
      const timer = window.setTimeout(() => resolve(voicesCache), 1200);
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

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const en = voices.filter((v) => /^en[-_]?/i.test(v.lang));
  for (const p of PREFERRED) {
    const hit = en.find((v) => v.name.includes(p)) ?? voices.find((v) => v.name.includes(p));
    if (hit) return hit;
  }
  return en.find((v) => /US/i.test(v.lang)) ?? en[0] ?? voices[0];
}

/** Read one of Dr. Patel's lines aloud. Resolves when it is done (or at once when speech is unavailable). */
export async function speak(text: string): Promise<void> {
  if (!("speechSynthesis" in window) || !text.trim()) return;
  const voices = await loadVoices();
  await new Promise<void>((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(voices);
      if (v) u.voice = v;
      u.rate = 1.0;
      u.pitch = 1.0;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

export function stopSpeaking() {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// The Talk button: one utterance, dictated
// ---------------------------------------------------------------------------

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function recognitionCtor(): (new () => RecognitionLike) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function canDictate(): boolean {
  return Boolean(recognitionCtor());
}

/**
 * Listen for one utterance. Resolves with the text, or with an empty string
 * when nothing was heard, permission was refused, or dictation is missing.
 * Returns a handle so the caller can cancel.
 */
export function dictateOnce(): { done: Promise<string>; cancel: () => void } {
  const Ctor = recognitionCtor();
  if (!Ctor) return { done: Promise.resolve(""), cancel: () => undefined };
  let rec: RecognitionLike | undefined;
  const done = new Promise<string>((resolve) => {
    try {
      rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      let text = "";
      rec.onresult = (e) => {
        const r = e.results[0]?.[0];
        if (r?.transcript) text = r.transcript.trim();
      };
      rec.onerror = () => resolve(text);
      rec.onend = () => resolve(text);
      rec.start();
    } catch {
      resolve("");
    }
  });
  return {
    done,
    cancel: () => {
      try {
        rec?.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
