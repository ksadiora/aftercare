import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@callsign/shared";

/**
 * Two tiny Web Audio cues, synthesized on the spot (no files): a soft
 * two-note chime when a verification lands "verified", a low thud when it
 * lands "quarantined". Muted with a switch in the presenter sheet; the
 * choice persists in localStorage when the browser allows it.
 */

const KEY = "callsign.sounds";

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

function note(c: AudioContext, freq: number, at: number, dur: number, peak: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

/** Soft two-note chime: E5 then B5, a fifth up. */
export function playChime() {
  const c = audio();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.01;
  note(c, 659.25, t, 0.28, 0.12);
  note(c, 987.77, t + 0.14, 0.42, 0.1);
}

/** Low, short thud: a sine dropping from 150 Hz to 45 Hz with a fast decay. */
export function playThud() {
  const c = audio();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.01;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.16);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.42, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.3);
}

function readPref(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

/** The mute preference, persisted when possible. Default on. */
export function useSoundPref(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(readPref);
  const set = (next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* private mode or blocked storage: the switch still works for this session */
    }
  };
  return [on, set];
}

/**
 * Watches the snapshot for verifications reaching a verdict and plays the
 * cue. Verdicts already present when the page loads are not replayed.
 * Browsers only start audio after a user gesture, so the first click or
 * keypress on the page unlocks the context; cues before that are skipped.
 */
export function useSounds(snapshot: Snapshot | undefined, enabled: boolean) {
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const unlock = () => {
      audio();
    };
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    if (!seen.current) {
      seen.current = new Set(snapshot.verifications.filter((v) => v.verdict).map((v) => v.requestId));
      return;
    }
    for (const v of snapshot.verifications) {
      if (!v.verdict || seen.current.has(v.requestId)) continue;
      seen.current.add(v.requestId);
      if (!enabled) continue;
      if (v.verdict === "verified") playChime();
      else playThud();
    }
  }, [snapshot, enabled]);
}
