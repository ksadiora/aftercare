import { useEffect, useRef } from "react";
import { micLive, prefersReducedMotion, readLevel } from "./audio.ts";
import type { MicState, WaitState } from "./engine.ts";

/**
 * THE VOICE ORB
 *
 * A soft sphere in the middle of the in-call screen that breathes with the
 * conversation. Blue while the agent speaks (driven by the analyser on the
 * TTS <audio>, or word boundaries when speechSynthesis is talking), green
 * while it listens (driven by the microphone analyser), amber while a turn
 * is in flight, gray when it is waiting for a tap. Tapping it while the
 * agent speaks interrupts; tapping it when parked reopens the mic.
 *
 * One requestAnimationFrame loop writes transforms straight onto two spans
 * (no React re-render per frame). It stops when the tab is hidden and never
 * runs at all under prefers-reduced-motion: the orb then just changes color.
 */

export type OrbMode = "speaking" | "listening" | "thinking" | "idle";

export function orbMode(mic: MicState): OrbMode {
  switch (mic) {
    case "speaking":
      return "speaking";
    case "listening":
      return "listening";
    case "thinking":
    case "idle":
      return "thinking";
    default:
      return "idle";
  }
}

export const ORB_WORD: Record<MicState, string> = {
  speaking: "Speaking",
  listening: "Listening… say something",
  thinking: "Thinking",
  idle: "Connecting…",
  tap: "Tap to talk",
  text: "Type your reply",
};

/** Slow sine "breath" between base and base+amp, with a second harmonic so it never looks mechanical. */
function breath(t: number, base: number, amp: number, period: number): number {
  const a = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / period);
  const b = 0.7 + 0.3 * Math.sin((2 * Math.PI * t) / (period * 0.37) + 1.3);
  return base + amp * a * b;
}

function target(mode: OrbMode, t: number): number {
  if (mode === "speaking") {
    const v = readLevel("playback");
    return v === undefined ? breath(t, 0.3, 0.32, 520) : 0.12 + v * 0.88;
  }
  if (mode === "listening") {
    const v = readLevel("mic");
    if (v === undefined) return breath(t, 0.26, 0.16, 1100);
    const shaped = Math.max(0, v - 0.05) * 1.25; // lift above the room's noise floor
    return 0.12 + Math.min(1, shaped) * 0.88;
  }
  if (mode === "thinking") return breath(t, 0.24, 0.16, 760);
  return breath(t, 0.12, 0.06, 1700);
}

export interface OrbProps {
  mic: MicState;
  wait?: WaitState;
  /** Listening because the judge is holding the talk button. */
  hold?: boolean;
  /** Tap on the sphere: interrupt while speaking, listen when parked. */
  onTap?: () => void;
  onRetry?: () => void;
  hint?: string;
}

/** The word under the orb. */
export function orbWord(mic: MicState, wait?: WaitState, hold?: boolean): string {
  if (mic === "speaking" && wait === "connecting") return "Connecting…";
  if (mic === "thinking" && wait) return "Still working…";
  if (mic === "listening" && hold) return "Listening… release to send";
  return ORB_WORD[mic];
}

export function Orb({ mic, wait, hold, onTap, onRetry, hint }: OrbProps) {
  const mode = orbMode(mic);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const sphere = useRef<HTMLSpanElement>(null);
  const halo = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLElement>(null);

  useEffect(() => {
    const s = sphere.current;
    const h = halo.current;
    if (!s || !h) return;
    if (prefersReducedMotion()) {
      s.style.transform = "scale(1)";
      h.style.transform = "scale(1.25)";
      h.style.opacity = "0.55";
      return;
    }
    let raf = 0;
    let level = 0.2;
    let meterLevel = 0;
    let running = false;
    const frame = (t: number) => {
      if (!running) return;
      const goal = target(modeRef.current, t);
      level += (goal - level) * (goal > level ? 0.32 : 0.09);
      s.style.transform = `scale(${(1 + level * 0.13).toFixed(4)})`;
      h.style.transform = `scale(${(1.05 + level * 0.6).toFixed(4)})`;
      h.style.opacity = (0.22 + level * 0.62).toFixed(3);
      // The level meter shows the real microphone only: no signal, no bar.
      const m = meter.current;
      if (m) {
        const v = modeRef.current === "listening" ? (readLevel("mic") ?? 0) : 0;
        meterLevel += (v - meterLevel) * (v > meterLevel ? 0.5 : 0.15);
        m.style.transform = `scaleX(${Math.min(1, meterLevel * 1.4).toFixed(3)})`;
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const vis = () => (document.visibilityState === "visible" ? start() : stop());
    document.addEventListener("visibilitychange", vis);
    vis();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  const tappable = Boolean(onTap) && (mic === "speaking" || mic === "tap");
  const label = mic === "speaking" ? "Interrupt and talk" : mic === "tap" ? "Tap to talk" : ORB_WORD[mic];
  const live = mic === "listening" && micLive();

  return (
    <div className="ph-orbwrap" data-mode={mode}>
      <button type="button" className="ph-orb" data-mode={mode} data-mic={mic} onClick={tappable ? onTap : undefined} aria-label={label} tabIndex={tappable ? 0 : -1}>
        <span className="halo" ref={halo} aria-hidden />
        <span className="sphere" ref={sphere} aria-hidden>
          <span className="coat c-gray" />
          <span className="coat c-blue" />
          <span className="coat c-green" />
          <span className="coat c-amber" />
          <span className="gloss" />
        </span>
        <span className="pulse" aria-hidden />
      </button>
      <div className="ph-orbword" aria-live="polite">
        {orbWord(mic, wait, hold)}
      </div>
      <div className={`ph-meter${mic === "listening" ? " on" : ""}${live ? " live" : ""}`} aria-hidden title={live ? "Microphone level" : undefined}>
        <i ref={meter} />
      </div>
      {mic === "thinking" && wait === "retry" && onRetry ? (
        <button type="button" className="ph-pill" onClick={onRetry}>
          Retry
        </button>
      ) : hint ? (
        <div className="ph-orbhint" key={hint}>
          {hint}
        </div>
      ) : (
        <div className="ph-orbhint blank" aria-hidden />
      )}
    </div>
  );
}
