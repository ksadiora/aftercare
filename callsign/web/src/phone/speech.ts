import { IS_IOS, IS_WEBVIEW } from "./audio.ts";
import { plog, pwarn } from "./log.ts";

/**
 * Speech-to-text on the phone through the browser's SpeechRecognition
 * (Chrome, Edge, Samsung Internet, Safari 14.1+ / iOS 14.5+ as
 * webkitSpeechRecognition; absent in Firefox and most in-app webviews).
 * One short utterance per start(): continuous=false, interim results shown
 * live, the final result handed back once. A fresh recogniser is created for
 * every start() because reusing one after an error is unreliable on Android.
 *
 * Chrome ties recognition to the page's microphone permission: once the
 * Start tap's getUserMedia was allowed, start() never prompts again. It does
 * need the network (Google's recogniser), which shows up as "network".
 *
 * Push-to-talk uses the same listener with `hold: true`: stop() ends the
 * capture gracefully so the final result (or the last interim words) is
 * delivered, and silence is reported once instead of being retried.
 */

type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SRResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
};
type SRResultEvent = { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };
type SRCtor = new () => SR;

function ctor(): SRCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function speechSupported(): boolean {
  return Boolean(ctor());
}

/** One line for the judge when voice input can't work here. */
export function speechUnavailableReason(code?: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone access was denied for this page; type your reply instead.";
  if (code === "audio-capture") return "No microphone could be opened; type your reply instead.";
  if (code === "network") return "Speech recognition needs internet access on this phone; type your reply instead.";
  if (!speechSupported()) {
    if (IS_WEBVIEW) return "This in-app browser has no voice input. Open the link in Safari or Chrome, or type instead.";
    if (/Firefox|FxiOS/i.test(navigator.userAgent)) return "Firefox has no voice input yet. Open this in Safari or Chrome, or type instead.";
    return "Voice input isn't available in this browser; type your reply instead.";
  }
  return "Voice input isn't available right now; type your reply instead.";
}

/** Error codes after which asking again is pointless: switch to typing. */
export const FATAL_SPEECH_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

/**
 * iOS Safari shows its own "would like to use Speech Recognition" prompt the
 * first time a recogniser starts. Trigger it during the pairing tap, so it
 * never pops up mid-call. The throwaway session is left alone long enough
 * for the judge to answer the prompt, then aborted. Android Chrome plays its
 * start chime on every start, so this only runs on iOS. Never throws.
 */
const WARM_UP_MS = 6000;
export function warmUpSpeech(): void {
  if (!IS_IOS) return;
  const Ctor = ctor();
  if (!Ctor) return;
  try {
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onerror = null;
    rec.onend = null;
    rec.start();
    plog("speech warm-up started (iOS prompt)");
    window.setTimeout(() => {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }, WARM_UP_MS);
  } catch {
    /* ignore */
  }
}

export interface ListenerHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  /** "no-speech" for silence; a code from FATAL_SPEECH_ERRORS when the mic is unusable. */
  onError(code: string): void;
}

export interface ListenerOptions {
  /** Push-to-talk: the caller ends the capture with stop(). */
  hold?: boolean;
}

export interface Listener {
  start(): void;
  /** Finish gracefully: deliver whatever was heard, then end. */
  stop(): void;
  /** Stop listening without reporting anything. */
  abort(): void;
}

let seq = 0;

export function createListener(h: ListenerHandlers, opts: ListenerOptions = {}): Listener {
  const Ctor = ctor();
  let rec: SR | undefined;
  let done = false;
  let lastInterim = "";
  const id = ++seq;
  const tag = `rec#${id}${opts.hold ? " (hold)" : ""}`;

  const settle = (fn: () => void) => {
    if (done) return;
    done = true;
    fn();
  };

  return {
    start() {
      if (!Ctor) {
        pwarn(tag, "SpeechRecognition is not available in this browser");
        return settle(() => h.onError("not-allowed"));
      }
      try {
        rec = new Ctor();
        rec.lang = "en-US";
        rec.continuous = false;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.onstart = () => plog(tag, "listening");
        rec.onaudiostart = () => plog(tag, "audio capture open");
        rec.onspeechstart = () => plog(tag, "speech detected");
        rec.onspeechend = () => plog(tag, "speech ended");
        rec.onresult = (e) => {
          let interim = "";
          let final = "";
          for (let i = 0; i < e.results.length; i++) {
            const r = e.results[i];
            const t = r[0]?.transcript ?? "";
            if (r.isFinal) final += t;
            else interim += t;
          }
          if (final.trim()) {
            plog(tag, "final:", JSON.stringify(final.trim()));
            settle(() => h.onFinal(final.trim()));
            try {
              rec?.stop();
            } catch {
              /* ignore */
            }
            return;
          }
          if (interim.trim()) {
            lastInterim = interim.trim();
            plog(tag, "interim:", JSON.stringify(lastInterim));
            h.onInterim(lastInterim);
          }
        };
        rec.onerror = (e) => {
          if (e.error === "aborted") return;
          if (e.error === "no-speech") plog(tag, "no speech heard");
          else pwarn(tag, "error:", e.error);
          settle(() => h.onError(e.error || "unknown"));
        };
        rec.onend = () => {
          // Android Chrome sometimes ends without ever flagging a result final.
          if (!done && lastInterim) {
            plog(tag, "ended with interim words only, using them:", JSON.stringify(lastInterim));
            return settle(() => h.onFinal(lastInterim));
          }
          if (!done) plog(tag, "ended with nothing heard");
          settle(() => h.onError("no-speech"));
        };
        rec.start();
        plog(tag, "start() called");
      } catch (e) {
        pwarn(tag, "start() threw", e);
        settle(() => h.onError("not-allowed"));
      }
    },
    stop() {
      plog(tag, "stop() (deliver what was heard)");
      try {
        rec?.stop();
      } catch {
        /* ignore */
      }
    },
    abort() {
      if (!done) plog(tag, "abort()");
      done = true;
      try {
        rec?.abort();
      } catch {
        /* ignore */
      }
      rec = undefined;
    },
  };
}
