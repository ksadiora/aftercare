import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CallState, Negotiation } from "@callsign/shared";
import { useCallsign } from "../useCallsign.ts";
import {
  audioState,
  haptic,
  IS_ANDROID,
  IS_IOS,
  keepAwake,
  lastMicPermission,
  onAudioState,
  primeMic,
  releaseAwake,
  releaseMic,
  resumeAudio,
  startMicMonitor,
  startRinging,
  stopMicMonitor,
  stopRinging,
  unlockAudio,
  watchMicPermission,
  type MicPermission,
  type MicPermissionState,
} from "./audio.ts";
import { BrowserEngine, EMPTY_VIEW, type CallView } from "./engine.ts";
import { startElevenLabs, type ElevenLabsHandle } from "./elevenlabs.ts";
import { HangupGlyph, KeyboardGlyph, MicGlyph, PhoneGlyph, ShieldDrawGlyph, ShieldGlyph, SpeakerGlyph } from "./glyphs.tsx";
import { plog, pwarn } from "./log.ts";
import { Orb } from "./Orb.tsx";
import { speechSupported, warmUpSpeech } from "./speech.ts";
import "./phone.css";

/**
 * THE DOCTOR'S PHONE  (owner: Phone lane)
 *
 * A judge opens /phone on their own device over the venue Wi-Fi, taps once
 * to pair (the tap also unlocks audio and asks for the mic, so nothing
 * prompts mid-call), and waits. When the verified brand agent calls, the
 * page rings like an incoming call. Accept → the agent speaks, the judge
 * talks back (or taps the orb to interrupt), a turn at a time, until someone
 * hangs up. A summary card closes the call.
 *
 *   pair → idle → ringing → incall → ended → idle
 *
 * Everything server-side goes through `phone.*` from useCallsign(); the
 * ringing/in-progress call arrives as `liveCall` over the WebSocket.
 */

type Stage = "pair" | "idle" | "ringing" | "incall" | "ended";
type EndReason = "hangup" | "agent" | "declined" | "missed" | "error";

interface EndedCall {
  id?: string;
  callerName: string;
  callerAgent: string;
  reason: EndReason;
  duration?: number;
}

const HEARTBEAT_MS = 15_000;
const ENDED_LINGER_MS = 6_000;
/** Show "Tap the orb to interrupt" during the agent's first lines, until the judge has done it once. */
const INTERRUPT_HINT_LINES = 2;
/**
 * The mic-level monitor for the orb runs only while listening, and not on
 * iOS by default: an open capture there routes speech to the quiet earpiece.
 * `?mic=1` forces it on, `?nomic=1` (see audio.ts) forces it off.
 */
const MIC_MONITOR = /[?&]mic\b/.test(location.search) || !IS_IOS;
/**
 * Desktop browsers keep the microphone stream from the Start tap open for the
 * whole session: getUserMedia runs exactly once, inside that tap, and the
 * level meter always has a signal. iOS releases it (earpiece routing).
 */
const HOLD_MIC = MIC_MONITOR && !IS_IOS;
/**
 * `?embedded=1`: the phone lives in a 360×720 iframe inside the console on
 * the same computer. No device-name field (it comes from `?device=`), no
 * safe-area padding, one big Start button.
 */
const EMBEDDED = /[?&]embedded\b/.test(location.search);

/** Presenter-facing microphone status, merged from the Permissions API and our own last request. */
type MicStatus = "granted" | "denied" | "prompt" | "unknown";
function micStatus(api: MicPermissionState, own: MicPermission | undefined): MicStatus {
  if (api === "granted" || api === "denied") return api;
  if (own === "granted") return "granted";
  if (own === "denied") return "denied";
  if (api === "prompt") return "prompt";
  return own === "unavailable" ? "denied" : "unknown";
}

function defaultDeviceName(): string {
  const fromQuery = new URLSearchParams(location.search).get("device");
  if (fromQuery?.trim()) return fromQuery.trim().slice(0, 40);
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua) || IS_IOS) return "iPad";
  if (IS_ANDROID) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  return "Phone";
}

/** Make the page behave like a full-screen app without touching index.html. */
function useAppChrome() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Callsign · Phone";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const prevViewport = meta?.content;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    meta.content = "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
    const capable = document.createElement("meta");
    capable.name = "apple-mobile-web-app-capable";
    capable.content = "yes";
    document.head.appendChild(capable);
    const theme = document.createElement("meta");
    theme.name = "theme-color";
    theme.content = "#000000";
    document.head.appendChild(theme);
    return () => {
      document.title = prevTitle;
      if (meta && prevViewport !== undefined) meta.content = prevViewport;
      link.remove();
      capable.remove();
      theme.remove();
    };
  }, []);
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** What the call achieved, for the summary card: a headline and, when agents signed, a sub-line. */
function outcomeLine(ended: EndedCall, negotiations: Negotiation[]): { head: string; sub?: string; signed: boolean } {
  const agreed = negotiations
    .filter((n) => n.callId && n.callId === ended.id && n.status === "agreed")
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  if (agreed) {
    const t = agreed.terms;
    const when = (w?: string) => (!w ? "" : /^(by|in|within|next|today|tomorrow)\b/i.test(w) ? ` ${w}` : ` for ${w}`);
    const head =
      agreed.kind === "samples" ? `Samples confirmed${when(t.deliverBy)}` : agreed.kind === "rep_visit" ? `Rep visit booked${when(t.when)}` : `Follow-up set${when(t.when)}`;
    return { head, sub: "Signed by both agents", signed: true };
  }
  return { head: "Update sent to inbox", signed: false };
}

const ENDED_TITLE: Record<EndReason, string> = {
  hangup: "Call ended",
  agent: "Call ended",
  declined: "Declined",
  missed: "Missed call",
  error: "Call dropped",
};

export function PhoneApp() {
  useAppChrome();
  const { connected, snapshot, liveCall, phone } = useCallsign();
  const [stage, setStage] = useState<Stage>("pair");
  const [name, setName] = useState(defaultDeviceName);
  const [pairing, setPairing] = useState(false);
  const [view, setView] = useState<CallView>(EMPTY_VIEW);
  const [caller, setCaller] = useState<Pick<CallState, "callerName" | "callerAgent">>({});
  const [answeredAt, setAnsweredAt] = useState<number | undefined>();
  const [ended, setEnded] = useState<EndedCall | undefined>();
  const [draft, setDraft] = useState("");
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [showInterruptHint, setShowInterruptHint] = useState(false);
  const [micApi, setMicApi] = useState<MicPermissionState>("unknown");
  const [micOwn, setMicOwn] = useState<MicPermission | undefined>(lastMicPermission);
  const [autoListen, setAutoListen] = useState(true);
  /** Bumped when a BrowserEngine is created, so the transcript observer picks up lines that arrived before it. */
  const [engineGen, setEngineGen] = useState(0);
  const mic = micStatus(micApi, micOwn);
  const micRef = useRef(mic);
  micRef.current = mic;

  const stageRef = useRef<Stage>("pair");
  const callIdRef = useRef<string | undefined>();
  const engineRef = useRef<BrowserEngine | undefined>();
  const elevenRef = useRef<ElevenLabsHandle | undefined>();
  const answeredRef = useRef<number | undefined>();
  const endedTimer = useRef<number | undefined>();
  const nameRef = useRef(name);
  nameRef.current = name;
  const callerRef = useRef(caller);
  callerRef.current = caller;
  const agentLines = useRef(0);
  const interrupted = useRef(false);
  /** How many transcript lines of the live call the engine has been shown. */
  const observedRef = useRef(0);
  const holdingRef = useRef(false);

  const go = useCallback((s: Stage) => {
    plog("stage →", s);
    stageRef.current = s;
    setStage(s);
  }, []);

  // Follow the browser's microphone permission (Chrome/Edge report it live).
  useEffect(() => watchMicPermission(setMicApi), []);
  /** Read the live stage (a function so TypeScript doesn't narrow the ref across awaits). */
  const stageNow = (): Stage => stageRef.current;

  const patchView = useCallback((patch: Partial<CallView>) => setView((v) => ({ ...v, ...patch })), []);

  /** Tear down audio, recogniser and engines. Idempotent. */
  const teardown = useCallback(() => {
    stopRinging();
    stopMicMonitor();
    engineRef.current?.stop();
    engineRef.current = undefined;
    const el = elevenRef.current;
    elevenRef.current = undefined;
    void el?.stop();
  }, []);

  /** Leave the call screen: the summary card for a moment, then back to idle. */
  const finish = useCallback(
    (reason: EndReason) => {
      teardown();
      const started = answeredRef.current;
      const id = callIdRef.current;
      answeredRef.current = undefined;
      setAnsweredAt(undefined);
      callIdRef.current = undefined;
      const c = callerRef.current;
      setEnded((prev) => ({
        id,
        callerName: c.callerName ?? prev?.callerName ?? "Stelazio",
        callerAgent: c.callerAgent ?? prev?.callerAgent ?? "",
        reason,
        duration: started ? Date.now() - started : undefined,
      }));
      go("ended");
      window.clearTimeout(endedTimer.current);
      endedTimer.current = window.setTimeout(() => {
        if (stageRef.current === "ended") {
          setView(EMPTY_VIEW);
          go("idle");
        }
      }, ENDED_LINGER_MS);
    },
    [go, teardown],
  );

  const done = () => {
    window.clearTimeout(endedTimer.current);
    if (stageRef.current === "ended") {
      setView(EMPTY_VIEW);
      go("idle");
    }
  };

  // -- Pairing ---------------------------------------------------------------

  /** getUserMedia, inside a click. The only place the phone ever asks for the microphone. */
  const askMic = useCallback((why: string): Promise<MicPermission> => {
    plog(`mic request (${why}); status before:`, micRef.current, "· speech recognition:", speechSupported() ? "available" : "missing");
    return primeMic(HOLD_MIC).then((r) => {
      plog("mic request result:", r);
      setMicOwn(r);
      return r;
    });
  }, []);

  const pair = async (e?: FormEvent) => {
    e?.preventDefault();
    // All synchronously, inside the tap: iOS ties sound, the mic prompt and the
    // speech-recognition prompt to the gesture. Both permissions happen here,
    // once, so nothing pops up mid-call.
    plog("Start tapped", EMBEDDED ? "(embedded in the console)" : "", { ua: navigator.userAgent });
    unlockAudio();
    keepAwake();
    void askMic("Start tap");
    warmUpSpeech(); // iOS: its separate "Speech Recognition" prompt, also now
    setPairing(true);
    try {
      await phone.register(name.trim() || defaultDeviceName());
      go("idle");
    } catch {
      /* the WebSocket may still be connecting; the re-register effect below retries */
      go("idle");
    } finally {
      setPairing(false);
    }
  };

  const unpair = async () => {
    releaseAwake();
    releaseMic();
    try {
      await phone.unregister();
    } catch {
      /* ignore */
    }
    go("pair");
  };

  /** "Try mic again": re-request inside a click; back to voice when it works. */
  const retryMic = async () => {
    const r = await askMic("Try mic again");
    if (r === "granted" && engineRef.current?.textMode) engineRef.current.setTextMode(false);
  };

  // Heartbeat while paired.
  useEffect(() => {
    if (stage === "pair") return;
    const t = window.setInterval(() => void phone.heartbeat().catch(() => undefined), HEARTBEAT_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage === "pair"]);

  // If the server forgot us (restart, another phone paired), pair again.
  const serverPaired = snapshot?.phone?.paired;
  const serverDevice = snapshot?.phone?.deviceName;
  useEffect(() => {
    if (stage === "pair" || !connected || serverPaired !== false) return;
    void phone.register(nameRef.current.trim() || defaultDeviceName()).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, connected, serverPaired]);

  // Docked in the console, the phone pairs itself the moment it loads, so a
  // brand call rings with no click anywhere. Only when no other phone holds
  // the pairing: a judge's scanned phone always wins. Sound and the mic are
  // unlocked by the Accept tap instead (see accept()).
  useEffect(() => {
    if (!EMBEDDED || stage !== "pair" || !connected || serverPaired !== false || pairing) return;
    plog("embedded: pairing by itself");
    setPairing(true);
    keepAwake();
    warmUpSpeech();
    void phone
      .register(nameRef.current.trim() || defaultDeviceName())
      .then(() => go("idle"))
      .catch(() => undefined)
      .finally(() => setPairing(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, connected, serverPaired]);

  /** Another device holds the pairing right now (a judge's phone): this one must not ring. */
  const standingBy = Boolean(serverPaired && serverDevice && serverDevice !== (nameRef.current.trim() || defaultDeviceName()));

  useEffect(() => () => teardown(), [teardown]);

  // -- Call lifecycle, driven by liveCall from the WebSocket -----------------

  const liveId = liveCall?.id;
  const liveStatus = liveCall?.status;
  useEffect(() => {
    const s = stageRef.current;
    if (s === "idle") {
      if (liveCall && liveStatus === "ringing") {
        if (standingBy) {
          plog("incoming call", liveCall.id, "rings", serverDevice, "· this phone stands by");
          return;
        }
        plog("incoming call", liveCall.id, "from", liveCall.callerAgent);
        callIdRef.current = liveCall.id;
        observedRef.current = liveCall.transcript.length;
        setCaller({ callerName: liveCall.callerName, callerAgent: liveCall.callerAgent });
        setView(EMPTY_VIEW);
        go("ringing");
        startRinging(); // first: the ring must sound within 100 ms of the status
        keepAwake();
        // The ring starts without a gesture. If iOS parked the context since pairing, ask for one tap.
        void resumeAudio().then((ok) => setSoundBlocked(!ok && audioState() !== "none"));
      }
      return;
    }
    const gone = !liveCall || liveId !== callIdRef.current || liveStatus === "ended" || liveStatus === "failed";
    if (s === "ringing" && gone) finish("missed");
    if (s === "incall" && gone) {
      // The agent's goodbye is still playing: the engine will call finish() itself.
      if (engineRef.current?.ending) return;
      finish(liveCall?.endReason === "error" || liveStatus === "failed" ? "error" : "hangup");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, liveId, liveStatus, standingBy]);

  // Lines the console adds to the call (typed as Dr. Patel, and the agent's
  // replies to them) arrive only over the WebSocket. Show them to the engine,
  // which voices the agent lines it did not request itself.
  const transcriptLen = liveCall?.transcript.length ?? 0;
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || stageRef.current !== "incall" || !liveCall || liveCall.id !== callIdRef.current) return;
    const lines = liveCall.transcript;
    for (let i = observedRef.current; i < lines.length; i++) engine.observe(lines[i].role, lines[i].text);
    observedRef.current = lines.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcriptLen, engineGen, stage]);

  // Show the "enable sound" banner whenever the context is parked during a ring or a call, clear it when it runs again.
  useEffect(
    () =>
      onAudioState((s) => {
        const live = stageRef.current === "ringing" || stageRef.current === "incall";
        setSoundBlocked(live && s !== "running" && s !== "none");
      }),
    [],
  );

  const enableSound = () => {
    unlockAudio();
    void resumeAudio().then((ok) => {
      setSoundBlocked(!ok && audioState() !== "none");
      if (ok && stageNow() === "ringing") {
        stopRinging();
        startRinging();
      }
    });
  };

  // -- Mic monitor for the orb: only while listening (see MIC_MONITOR) ------

  const listening = stage === "incall" && view.mic === "listening";
  useEffect(() => {
    if (!listening || !MIC_MONITOR) return;
    void startMicMonitor();
    return () => stopMicMonitor();
  }, [listening]);

  // -- Barge-in hint: the agent's first lines, until the judge interrupts once ----

  const speaking = stage === "incall" && view.mic === "speaking";
  const agentLine = view.agentLine;
  useEffect(() => {
    if (!speaking) return;
    agentLines.current += 1;
    setShowInterruptHint(!interrupted.current && agentLines.current <= INTERRUPT_HINT_LINES && Boolean(engineRef.current));
  }, [speaking, agentLine]);

  // -- Ringing actions -------------------------------------------------------

  const accept = async () => {
    const id = callIdRef.current;
    if (!id || stageNow() !== "ringing") return;
    plog("Accept tapped; mic:", micRef.current);
    stopRinging();
    unlockAudio();
    haptic("accept");
    keepAwake();
    // Inside the tap: the only gesture an auto-paired (docked) phone gets before the call.
    if (micRef.current !== "granted" && micRef.current !== "denied") void askMic("Accept tap");
    setSoundBlocked(false);
    answeredRef.current = Date.now();
    setAnsweredAt(answeredRef.current);
    agentLines.current = 0;
    interrupted.current = false;
    setShowInterruptHint(false);
    setView({ ...EMPTY_VIEW, mic: "idle" }); // "Connecting…" until the opening line plays
    go("incall");
    let opening: string;
    try {
      opening = (await phone.answer(id)).reply;
    } catch (e) {
      pwarn("answer failed", e);
      finish("error");
      return;
    }
    if (stageNow() !== "incall") return;

    // Bonus engine: a real-time ElevenLabs agent session, when the server has one.
    try {
      const session = await phone.session();
      if (session.engine === "elevenlabs" && session.signedUrl && stageNow() === "incall") {
        elevenRef.current = await startElevenLabs(session.signedUrl, {
          update: patchView,
          disconnected: () => {
            if (stageNow() !== "incall") return;
            void phone.hangup(id).catch(() => undefined);
            finish("agent");
          },
        });
        return;
      }
    } catch {
      /* fall through to the browser engine */
    }
    if (stageNow() !== "incall") return;

    const engine = new BrowserEngine(
      id,
      { turn: phone.turn, ttsUrl: phone.ttsUrl },
      {
        update: patchView,
        finished: () => {
          if (stageNow() === "incall") finish("agent");
        },
      },
      { micDenied: micRef.current === "denied", autoListen },
    );
    engineRef.current = engine;
    setEngineGen((g) => g + 1);
    await engine.start(opening);
  };

  const decline = async () => {
    const id = callIdRef.current;
    stopRinging();
    haptic("hangup");
    if (id) void phone.decline(id).catch(() => undefined);
    finish("declined");
  };

  const hangup = async () => {
    const id = callIdRef.current;
    haptic("hangup");
    if (id) void phone.hangup(id).catch(() => undefined);
    finish("hangup");
  };

  // -- In-call input ---------------------------------------------------------

  const sendDraft = (e?: FormEvent) => {
    e?.preventDefault();
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    void engineRef.current?.submit(t);
  };

  const toggleText = () => engineRef.current?.setTextMode(!engineRef.current.textMode);

  /** Orb / Talk button: interrupt the agent, or reopen the mic when parked. */
  const talk = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.interrupt()) {
      interrupted.current = true;
      setShowInterruptHint(false);
      haptic("tick");
      return;
    }
    engine.listen(true);
  };

  const retry = () => engineRef.current?.retry();

  // -- Push-to-talk: the big button, or Space while the phone has focus -------

  const pushStart = () => {
    const engine = engineRef.current;
    if (!engine || holdingRef.current) return;
    holdingRef.current = true;
    haptic("tick");
    engine.pushStart();
  };
  const pushStop = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    engineRef.current?.pushStop();
  };
  const onHoldDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    pushStart();
  };
  const onHoldUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    pushStop();
  };

  useEffect(() => {
    if (stage !== "incall") return;
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || typing(e.target)) return;
      e.preventDefault();
      pushStart();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      pushStop();
    };
    const blur = () => pushStop();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      holdingRef.current = false;
    };
  }, [stage]);

  const toggleAutoListen = () => {
    const next = !autoListen;
    setAutoListen(next);
    engineRef.current?.setAutoListen(next);
  };

  // -- Render ----------------------------------------------------------------

  const callerName = caller.callerName ?? snapshot?.brand.displayName ?? "Stelazio";
  const callerAgent = caller.callerAgent ?? snapshot?.brand.name ?? "";
  const talkEnabled = Boolean(engineRef.current) && (view.mic === "speaking" || view.mic === "tap");
  const holdEnabled = Boolean(engineRef.current) && view.mic !== "thinking" && view.mic !== "idle" && view.mic !== "text";
  const deviceName = standingBy ? name : (snapshot?.phone?.deviceName ?? name);

  return (
    <div className="ph" data-stage={stage} data-mic={stage === "incall" ? view.mic : undefined} data-embedded={EMBEDDED ? "1" : undefined}>
      {stage === "pair" && (
        <form className="ph-screen" onSubmit={pair}>
          <div className="ph-top">
            <div className="ph-mark">
              <PhoneGlyph />
            </div>
            <div className="ph-title">Dr. Patel's phone</div>
            <div className="ph-sub">{EMBEDDED ? "This computer becomes Dr. Patel's phone. Only verified agents can ring it." : "Pair this device so verified agents can ring it. Unverified ones never will."}</div>
          </div>
          {!EMBEDDED && (
            <div className="ph-field">
              <label htmlFor="ph-name">This device</label>
              <input id="ph-name" className="ph-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" />
            </div>
          )}
          <button type="submit" className={`ph-primary${EMBEDDED ? " big" : ""}`} disabled={pairing}>
            {pairing ? "Starting…" : EMBEDDED ? "Start" : "Pair this phone"}
          </button>
          <div className="ph-hint">{EMBEDDED ? "Allows sound and the microphone." : "One tap also lets this page play sound and use the microphone."}</div>
          <div className="ph-spacer" />
          <div className="ph-status">
            <span className={`ph-dot${connected ? "" : " off"}`} /> {connected ? "Connected to Dr. Patel's agent" : "Connecting…"}
          </div>
        </form>
      )}

      {stage === "idle" && (
        <div className="ph-screen">
          <div className="ph-top">
            <div className="ph-kicker">Callsign</div>
            <div className="ph-name">{EMBEDDED ? `Ready · ${deviceName}` : `Paired as ${deviceName}`}</div>
          </div>
          <div className="ph-radar" aria-hidden>
            <span className="ring" />
            <span className="ring" />
            <span className="ring" />
            <span className="core">
              <ShieldGlyph />
            </span>
          </div>
          <div className="ph-sub">{standingBy ? `Standing by · ${serverDevice} is paired` : "Waiting for a verified call…"}</div>
          <div className="ph-hint">{standingBy ? "Calls ring that phone. This one takes over if it goes away." : "Only agents that pass ANS verification can make this phone ring."}</div>
          <MicChip status={mic} onRetry={mic === "granted" ? undefined : retryMic} />
          <div className="ph-spacer" />
          <div className="ph-status">
            <span className={`ph-dot${connected ? "" : " off"}`} /> {connected ? "Connected" : "Reconnecting…"} ·{" "}
            {snapshot?.phone?.voice === "elevenlabs" ? "ElevenLabs voice" : "Browser voice"}
          </div>
          <button type="button" className="ph-link" onClick={unpair}>
            Unpair
          </button>
        </div>
      )}

      {stage === "ringing" && (
        <div className="ph-screen">
          <div className="ph-top">
            <div className="ph-kicker">Callsign call</div>
            <div className="ph-name">{callerName}</div>
            {callerAgent && <div className="ph-ans">{callerAgent}</div>}
            <div className="ph-verified">
              <ShieldDrawGlyph />
              <span>Demo credentials verified</span>
            </div>
          </div>
          <div className="ph-spacer" />
          {soundBlocked && (
            <button type="button" className="ph-banner" onClick={enableSound}>
              <SpeakerGlyph />
              <span>Tap to enable sound</span>
            </button>
          )}
          <div className="ph-actions">
            <button type="button" className="ph-action" onClick={decline} aria-label="Decline">
              <span className="ph-circle red">
                <HangupGlyph />
              </span>
              Decline
            </button>
            <button type="button" className="ph-action" onClick={accept} aria-label="Accept">
              <span className="ph-circle green">
                <PhoneGlyph />
              </span>
              Accept
            </button>
          </div>
        </div>
      )}

      {stage === "incall" && (
        <div className="ph-screen">
          <div className="ph-callhead">
            <div className="ph-name">{callerName}</div>
            <CallTimer since={answeredAt} />
            <div className="ph-verified">
              <ShieldGlyph />
              <span>Demo credentials · {callerAgent}</span>
            </div>
            {!elevenRef.current && <MicChip status={mic} compact />}
          </div>

          <div className="ph-captions" aria-live="polite">
            {view.agentLine ? (
              <div className="ph-agentline" data-long={view.agentLine.length > 150 ? "1" : undefined} key={view.agentLine}>
                {view.agentLine}
              </div>
            ) : view.mic !== "thinking" && view.mic !== "idle" ? (
              <div className="ph-agentline">…</div>
            ) : null}
            {view.interim ? (
              <div className="ph-doctorline interim">{view.interim}</div>
            ) : view.doctorLine ? (
              <div className="ph-doctorline" key={view.doctorLine}>
                {view.doctorLine}
              </div>
            ) : null}
            {view.mic === "thinking" || view.mic === "idle" ? (
              <div className="ph-dots" aria-label="Thinking">
                <i />
                <i />
                <i />
              </div>
            ) : null}
          </div>

          <Orb
            mic={view.mic}
            wait={view.wait}
            hold={view.hold}
            onTap={engineRef.current ? talk : undefined}
            onRetry={retry}
            hint={showInterruptHint && view.mic === "speaking" ? "Tap the orb to interrupt" : undefined}
          />
          {view.note && <div className="ph-note">{view.note}</div>}
          {soundBlocked && (
            <button type="button" className="ph-banner" onClick={enableSound}>
              <SpeakerGlyph />
              <span>Tap to enable sound</span>
            </button>
          )}

          {view.mic === "text" ? (
            <>
              <form className="ph-typing" onSubmit={sendDraft}>
                <input
                  className="ph-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Say something, e.g. send samples"
                  autoFocus
                  autoComplete="off"
                  enterKeyHint="send"
                />
                <button type="submit" className="ph-send" disabled={!draft.trim()}>
                  Send
                </button>
              </form>
              {mic !== "granted" && speechSupported() && (
                <button type="button" className="ph-pill ghost" onClick={retryMic}>
                  Try mic again
                </button>
              )}
            </>
          ) : engineRef.current ? (
            <div className="ph-talkrow">
              <button
                type="button"
                className={`ph-hold${view.hold ? " on" : ""}`}
                disabled={!holdEnabled}
                onPointerDown={onHoldDown}
                onPointerUp={onHoldUp}
                onPointerCancel={onHoldUp}
                onLostPointerCapture={pushStop}
                onContextMenu={(e) => e.preventDefault()}
                aria-pressed={Boolean(view.hold)}
                title="Hold while you speak (or hold Space)"
              >
                <MicGlyph />
                <span>{view.hold ? "Release to send" : "Hold to talk"}</span>
              </button>
              <button type="button" className={`ph-toggle${autoListen ? " on" : ""}`} onClick={toggleAutoListen} aria-pressed={autoListen} title="Open the mic by itself after each agent line">
                <i />
                Auto-listen
              </button>
            </div>
          ) : null}

          <div className="ph-controls">
            <button type="button" className="ph-action" onClick={toggleText} disabled={!engineRef.current} aria-label="Type instead">
              <span className={`ph-circle small${view.mic === "text" ? " on" : ""}`}>
                <KeyboardGlyph />
              </span>
              {view.mic === "text" ? "Voice" : "Type"}
            </button>
            <button type="button" className="ph-action" onClick={hangup} aria-label="End call">
              <span className="ph-circle red">
                <HangupGlyph />
              </span>
              End
            </button>
            <button type="button" className="ph-action" onClick={talk} disabled={!talkEnabled} aria-label={view.mic === "speaking" ? "Interrupt" : "Talk"}>
              <span className={`ph-circle small${view.mic === "listening" ? " on" : ""}`}>
                <MicGlyph />
              </span>
              {view.mic === "speaking" ? "Interrupt" : "Talk"}
            </button>
          </div>
        </div>
      )}

      {stage === "ended" && ended && (
        <div className="ph-screen">
          <div className="ph-spacer" />
          <Summary ended={ended} negotiations={snapshot?.negotiations ?? []} onDone={done} />
          <div className="ph-spacer" />
        </div>
      )}
    </div>
  );
}

function Summary({ ended, negotiations, onDone }: { ended: EndedCall; negotiations: Negotiation[]; onDone: () => void }) {
  const outcome = outcomeLine(ended, negotiations);
  return (
    <div className="ph-summary" data-signed={outcome.signed ? "1" : "0"}>
      <div className="ph-summary-head">
        <span className="ph-summary-shield" aria-label="Demo credentials verified">
          <ShieldGlyph />
        </span>
        <div className="ph-summary-who">
          <div className="ph-name">{ended.callerName}</div>
          {ended.callerAgent && <div className="ph-ans">{ended.callerAgent}</div>}
        </div>
      </div>
      <div className="ph-summary-title">{ENDED_TITLE[ended.reason]}</div>
      {ended.duration !== undefined && <div className="ph-timer big">{formatDuration(ended.duration)}</div>}
      <div className="ph-summary-outcome">
        <div className="head">{outcome.head}</div>
        {outcome.sub && <div className="sub">{outcome.sub}</div>}
      </div>
      <button type="button" className="ph-primary ph-done" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

const MIC_CHIP: Record<MicStatus, string> = {
  granted: "Mic: allowed",
  denied: "Mic: blocked — click the camera icon in the address bar",
  prompt: "Mic: not asked yet",
  unknown: "Mic: not asked yet",
};

/** Persistent microphone status for the presenter: green, red with the one-line fix, or gray. */
function MicChip({ status, compact, onRetry }: { status: MicStatus; compact?: boolean; onRetry?: () => void }) {
  return (
    <div className={`ph-micchip${compact ? " compact" : ""}`} data-mic={status} role="status">
      <span className="chip">
        <i />
        {MIC_CHIP[status]}
      </span>
      {!compact && onRetry && (
        <button type="button" className="ph-pill ghost" onClick={onRetry}>
          Try mic again
        </button>
      )}
    </div>
  );
}

function CallTimer({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  return <div className="ph-timer">{since ? formatDuration(now - since) : "00:00"}</div>;
}
