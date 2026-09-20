import type { PhoneTurnResponse } from "@callsign/shared";
import { cancelSpeech, speak } from "./audio.ts";
import { plog, pwarn } from "./log.ts";
import { createListener, FATAL_SPEECH_ERRORS, speechSupported, speechUnavailableReason, type Listener } from "./speech.ts";

/**
 * The browser voice engine for one call: speak the agent's line, listen for
 * the doctor, post the text to /api/phone/turn, speak the reply, repeat.
 * Every state change goes through `events.update` so the screen can render
 * captions and the orb. Never throws; a failed turn parks the call on
 * "Tap to talk" rather than dropping it.
 *
 * Barge-in: interrupt() while the agent speaks cuts the audio and opens the
 * mic at once. A slow /turn shows "Still working…" after 8 s and offers
 * Retry after 15 s; the late reply of a superseded attempt is ignored.
 *
 * Two ways to talk:
 *   auto-listen (default)  the mic opens by itself after every agent line;
 *                          silence is retried twice ("Didn't catch that"),
 *                          then the call parks on "Tap to talk".
 *   push-to-talk           pushStart() on press, pushStop() on release; the
 *                          words heard in between are sent as the turn.
 *
 * Lines typed on the console ("Type as Dr. Patel") reach the server without
 * us; they come back over the WebSocket as transcript lines. observe() voices
 * any agent line this engine did not itself request, matching text against
 * the replies we are waiting for so nothing is spoken twice.
 */

export type MicState =
  | "speaking" // the agent's line is playing
  | "listening" // recogniser open
  | "thinking" // waiting on /turn
  | "tap" // recogniser gave up; judge taps to retry
  | "text" // typing fallback
  | "idle";

/** How long the current turn has been in flight, or that audio is still on its way. */
export type WaitState = "slow" | "retry" | "connecting";

export interface CallView {
  agentLine: string;
  doctorLine: string;
  interim: string;
  mic: MicState;
  note?: string;
  wait?: WaitState;
  /** Listening because the judge is holding the talk button (or Space). */
  hold?: boolean;
}

export const EMPTY_VIEW: CallView = { agentLine: "", doctorLine: "", interim: "", mic: "idle" };

export interface EngineApi {
  turn(callId: string, text: string): Promise<PhoneTurnResponse>;
  ttsUrl(text: string): string;
}

export interface EngineEvents {
  update(patch: Partial<CallView>): void;
  /** The agent said goodbye and the last line has finished playing. */
  finished(): void;
}

export interface EngineOptions {
  /** The browser refused the microphone: start in type-to-talk. */
  micDenied?: boolean;
  /** Open the mic after every agent line (default true); off means push-to-talk only. */
  autoListen?: boolean;
}

/** Silent recogniser sessions retried before parking on "Tap to talk". */
const MAX_SILENCE_RETRIES = 2;
export const SLOW_TURN_MS = 8_000;
export const RETRY_TURN_MS = 15_000;
/** Audio not playing this long after a line was requested → "Connecting…". */
export const CONNECTING_MS = 1_200;
const MAX_OWN_LINES = 20;

export const DIDNT_CATCH = "Didn't catch that";

export class BrowserEngine {
  private alive = true;
  private busy = false;
  private listener?: Listener;
  private silences = 0;
  private attempt = 0;
  private lastText = "";
  private timers: number[] = [];
  private deniedOnce = false;
  private holding = false;
  /** Agent lines the console asked for, waiting to be voiced. */
  private external: string[] = [];
  /** Replies we received and spoke (or are speaking) whose transcript line has not arrived yet. */
  private ownAgent: string[] = [];
  /** Doctor lines we sent whose transcript line has not arrived yet. */
  private ownDoctor: string[] = [];
  /** Agent lines that arrived while our own turn was in flight: ours or the console's, decided when the reply lands. */
  private candidates: string[] = [];
  /** True from the moment a reply with `end: true` starts playing. */
  ending = false;
  /** True while the agent's line is playing and may be interrupted. */
  speaking = false;
  textMode: boolean;
  autoListen: boolean;

  constructor(
    private readonly callId: string,
    private readonly api: EngineApi,
    private readonly events: EngineEvents,
    opts: EngineOptions = {},
  ) {
    this.textMode = !speechSupported() || Boolean(opts.micDenied);
    this.autoListen = opts.autoListen ?? true;
    plog("engine: created", { textMode: this.textMode, autoListen: this.autoListen, micDenied: Boolean(opts.micDenied), speech: speechSupported() });
  }

  async start(openingLine: string): Promise<void> {
    if (this.textMode) this.events.update({ note: speechSupported() ? "Microphone is blocked; type your reply, or allow the mic and try again." : speechUnavailableReason() });
    this.remember(this.ownAgent, openingLine);
    await this.say(openingLine, false);
  }

  /** Text from the typing fallback, or a final speech result. */
  async submit(text: string): Promise<void> {
    const clean = text.trim();
    if (!this.alive || this.busy || !clean) return;
    this.busy = true;
    this.holding = false;
    this.silences = 0;
    this.lastText = clean;
    this.remember(this.ownDoctor, clean);
    this.listener?.abort();
    this.listener = undefined;
    const attempt = ++this.attempt;
    this.clearTimers();
    plog("turn →", JSON.stringify(clean));
    this.events.update({ doctorLine: clean, interim: "", mic: "thinking", note: undefined, wait: undefined, hold: false });
    this.timers.push(
      window.setTimeout(() => attempt === this.attempt && this.alive && this.events.update({ wait: "slow" }), SLOW_TURN_MS),
      window.setTimeout(() => attempt === this.attempt && this.alive && this.events.update({ wait: "retry" }), RETRY_TURN_MS),
    );
    const t0 = performance.now();
    let out: PhoneTurnResponse | undefined;
    try {
      out = await this.api.turn(this.callId, clean);
    } catch (e) {
      pwarn("turn failed", e);
      out = undefined;
    }
    if (attempt !== this.attempt) return; // a retry superseded this attempt
    this.clearTimers();
    this.busy = false;
    if (!this.alive) return;
    if (!out) {
      this.external.push(...this.candidates.splice(0));
      this.events.update({ mic: this.textMode ? "text" : "tap", wait: undefined, note: "Couldn't reach the agent. Try again." });
      return;
    }
    plog(`turn ← ${Math.round(performance.now() - t0)} ms`, JSON.stringify(out.reply), out.end ? "(agent hangs up after this)" : "");
    // The transcript line for this reply may already have arrived (candidates) or may still be on its way (ownAgent).
    const i = this.candidates.indexOf(out.reply);
    if (i >= 0) this.candidates.splice(i, 1);
    else this.remember(this.ownAgent, out.reply);
    // Anything else that landed meanwhile was typed on the console: voice it after the reply.
    this.external.push(...this.candidates.splice(0));
    await this.say(out.reply, out.end);
  }

  /** Send the last line again after a turn stalled; the stalled reply is dropped when it arrives. */
  retry(): void {
    if (!this.alive || !this.lastText) return;
    this.busy = false;
    void this.submit(this.lastText);
  }

  /** Barge-in: cut the agent's line and listen right away. No-op unless the agent is speaking. */
  interrupt(): boolean {
    if (!this.alive || !this.speaking || this.ending) return false;
    plog("barge-in: agent line cut");
    cancelSpeech(); // resolves the pending speak(); say() then opens the mic
    return true;
  }

  /**
   * (Re)open the microphone. `fromGesture` is true when a tap called this:
   * some browsers only let the first recogniser start from a gesture, so a
   * "not-allowed" outside one parks on "Tap to talk" once before we conclude
   * the mic is really unavailable and switch to typing.
   */
  listen(fromGesture = false, note?: string): void {
    if (!this.alive || this.busy || this.ending || this.holding) return;
    if (this.textMode) {
      this.events.update({ mic: "text", interim: "", hold: false });
      return;
    }
    this.listener?.abort();
    this.listener = createListener({
      onInterim: (t) => this.alive && this.events.update({ interim: t, mic: "listening" }),
      onFinal: (t) => void this.submit(t),
      onError: (code) => {
        if (!this.alive || this.busy) return;
        if (FATAL_SPEECH_ERRORS.has(code)) {
          if ((code === "not-allowed" || code === "service-not-allowed") && !fromGesture && !this.deniedOnce) {
            this.deniedOnce = true;
            this.events.update({ mic: "tap", interim: "", note: "Tap to talk, or type your reply." });
            return;
          }
          this.textMode = true;
          this.events.update({ mic: "text", interim: "", note: speechUnavailableReason(code) });
          return;
        }
        if (code === "no-speech") {
          if (++this.silences <= MAX_SILENCE_RETRIES) {
            plog(`nothing heard, listening again (${this.silences}/${MAX_SILENCE_RETRIES})`);
            this.listen(false, DIDNT_CATCH);
            return;
          }
          this.events.update({ mic: "tap", interim: "", note: `${DIDNT_CATCH}. Tap to talk, or hold the button while you speak.` });
          return;
        }
        if (code === "network") {
          this.events.update({ mic: "tap", interim: "", note: speechUnavailableReason(code) });
          return;
        }
        this.events.update({ mic: "tap", interim: "" });
      },
    });
    this.events.update({ mic: "listening", interim: "", note, hold: false });
    this.listener.start();
  }

  /** Push-to-talk: press. Cuts the agent's line if it is still playing. */
  pushStart(): void {
    if (!this.alive || this.busy || this.ending || this.holding) return;
    if (this.textMode) return;
    this.holding = true;
    plog("push-to-talk: pressed");
    if (this.speaking) cancelSpeech(); // say() sees `holding` and leaves our listener alone
    this.listener?.abort();
    this.listener = createListener(
      {
        onInterim: (t) => this.alive && this.events.update({ interim: t, mic: "listening", hold: true }),
        onFinal: (t) => {
          this.holding = false;
          void this.submit(t);
        },
        onError: (code) => {
          this.holding = false;
          if (!this.alive || this.busy) return;
          if (FATAL_SPEECH_ERRORS.has(code)) {
            this.textMode = true;
            this.events.update({ mic: "text", interim: "", note: speechUnavailableReason(code), hold: false });
            return;
          }
          this.events.update({ mic: "tap", interim: "", hold: false, note: code === "no-speech" ? `${DIDNT_CATCH}. Hold the button while you speak.` : speechUnavailableReason(code) });
        },
      },
      { hold: true },
    );
    this.events.update({ mic: "listening", interim: "", note: undefined, hold: true });
    this.listener.start();
  }

  /** Push-to-talk: release. Whatever was heard becomes the turn. */
  pushStop(): void {
    if (!this.holding) return;
    plog("push-to-talk: released");
    this.listener?.stop();
  }

  setAutoListen(on: boolean): void {
    if (this.autoListen === on) return;
    this.autoListen = on;
    plog("auto-listen", on ? "on" : "off");
    if (!this.alive || this.busy || this.ending || this.holding || this.textMode || this.speaking) return;
    if (on) this.listen(true);
    else {
      this.listener?.abort();
      this.listener = undefined;
      this.events.update({ mic: "tap", interim: "", note: undefined, hold: false });
    }
  }

  setTextMode(on: boolean): void {
    this.textMode = on;
    this.holding = false;
    this.listener?.abort();
    this.listener = undefined;
    plog("input mode:", on ? "typing" : "voice");
    if (!this.alive || this.busy || this.ending) return;
    if (on) this.events.update({ mic: "text", interim: "", note: undefined, hold: false });
    else {
      this.silences = 0;
      if (this.autoListen) this.listen(true);
      else this.events.update({ mic: "tap", interim: "", note: undefined, hold: false });
    }
  }

  /**
   * A transcript line arrived over the WebSocket. Lines this engine produced
   * are matched and dropped; anything else came from the console: doctor
   * lines are captioned, agent lines are voiced.
   */
  observe(role: "agent" | "doctor" | "system", text: string): void {
    if (!this.alive || !text) return;
    if (role === "doctor") {
      if (this.claim(this.ownDoctor, text)) return;
      plog("console typed as Dr. Patel:", JSON.stringify(text));
      this.events.update({ doctorLine: text, interim: "" });
      return;
    }
    if (role !== "agent") return;
    if (this.claim(this.ownAgent, text)) return;
    if (this.busy) {
      // Could be our reply arriving before the HTTP response: decide when it lands.
      this.candidates.push(text);
      return;
    }
    this.voiceExternal(text);
  }

  /** Hang up: stop audio and the recogniser. Idempotent. */
  stop(): void {
    this.alive = false;
    this.speaking = false;
    this.holding = false;
    this.clearTimers();
    this.listener?.abort();
    this.listener = undefined;
    cancelSpeech();
    plog("engine: stopped");
  }

  private remember(list: string[], text: string): void {
    list.push(text);
    if (list.length > MAX_OWN_LINES) list.shift();
  }

  private claim(list: string[], text: string): boolean {
    const i = list.indexOf(text);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  private voiceExternal(text: string): void {
    plog("voicing a line the console requested:", JSON.stringify(text));
    if (this.speaking) {
      this.external.push(text);
      return;
    }
    this.holding = false;
    this.listener?.abort();
    this.listener = undefined;
    void this.say(text, false);
  }

  private clearTimers(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
  }

  private async say(text: string, end: boolean): Promise<void> {
    if (!this.alive) return;
    this.ending = end;
    this.speaking = true;
    this.events.update({ agentLine: text, interim: "", mic: "speaking", wait: undefined, hold: false });
    const connecting = window.setTimeout(() => {
      if (this.alive && this.speaking) {
        plog("audio slow to start, showing Connecting…");
        this.events.update({ wait: "connecting" });
      }
    }, CONNECTING_MS);
    await speak(text, this.api.ttsUrl(text), () => {
      window.clearTimeout(connecting);
      if (this.alive) this.events.update({ wait: undefined });
    });
    window.clearTimeout(connecting);
    this.speaking = false;
    if (!this.alive) return;
    if (end) {
      this.alive = false;
      this.events.finished();
      return;
    }
    this.afterSpeak();
  }

  /** What happens once a line has finished playing: the next queued line, or the judge's turn. */
  private afterSpeak(): void {
    if (this.holding) return; // push-to-talk cut the line; its listener is already open
    const next = this.external.shift();
    if (next !== undefined) {
      void this.say(next, false);
      return;
    }
    this.silences = 0;
    if (this.textMode) this.events.update({ mic: "text", interim: "", hold: false });
    else if (this.autoListen) this.listen();
    else this.events.update({ mic: "tap", interim: "", note: undefined, hold: false });
  }
}
