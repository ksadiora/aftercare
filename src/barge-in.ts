/**
 * Barge-in gate for the in-app call.
 *
 * ElevenLabs decides interruptions on its own side, from the audio we send it.
 * A chair scraping, a phone set down on a table, a cough — any of those reach
 * its turn detector as "the participant started talking", and the agent stops
 * mid-question and loses its place. Nothing in the agent configuration filters
 * a transient that carries no words, so the only reliable fix is to not send it.
 *
 * While the agent is speaking the microphone is held closed and this gate
 * watches the real input level instead. It opens only once the level has stayed
 * up long enough to be speech rather than a knock, and closes again after a
 * pause. While the agent is listening the gate is not used at all, so an answer
 * to a question is never clipped — only a deliberate interruption is, by about
 * the length of the attack window, which costs the front of one word.
 *
 * The thresholds are relative to the same RMS scale the pre-call microphone
 * check uses, where 0.015 is "some signal is present".
 */
export interface GateSettings {
  /** RMS the input must exceed to count toward opening. Above room tone, residual echo and a settling knock. */
  threshold: number;
  /** How long it must stay there. Shorter than a syllable is noise, not speech. */
  attackMs: number;
  /** How long it must stay quiet before the gate closes again, so gaps between words do not re-close it. */
  releaseMs: number;
}

export const BARGE_IN: GateSettings = { threshold: 0.045, attackMs: 180, releaseMs: 900 };

export function createBargeInGate(settings: GateSettings = BARGE_IN) {
  let open = false;
  let loudSince: number | null = null;
  let quietSince: number | null = null;
  return {
    get open() { return open; },
    /** Feed one level sample. Returns whether the microphone should be sending. */
    feed(level: number, at: number) {
      if (level >= settings.threshold) {
        quietSince = null; loudSince ??= at;
        if (at - loudSince >= settings.attackMs) open = true;
      } else {
        loudSince = null; quietSince ??= at;
        if (at - quietSince >= settings.releaseMs) open = false;
      }
      return open;
    },
    /** Each agent turn starts closed; a gate left open by the last turn would defeat the point. */
    close() { open = false; loudSince = null; quietSince = null; },
  };
}
export type BargeInGate = ReturnType<typeof createBargeInGate>;

export interface MicMeter { level: () => number; close: () => void }

/**
 * Reads the true microphone level from our own stream. The SDK's own meter
 * reports zero whenever the microphone is muted, which is exactly when the gate
 * needs a reading, so it cannot be the source here.
 *
 * Returns undefined where Web Audio is unavailable. The caller then leaves the
 * microphone permanently open, which is the behaviour this gate replaced: a
 * browser that cannot measure the input is not a reason to stop the call.
 */
export function createMicMeter(stream: MediaStream): MicMeter | undefined {
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  if (!Ctor) return undefined;
  try {
    const context = new Ctor();
    void context.resume?.().catch(() => undefined);
    const analyser = context.createAnalyser(); analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const bytes = new Uint8Array(analyser.fftSize);
    let closed = false;
    return {
      level() {
        if (closed) return 0;
        analyser.getByteTimeDomainData(bytes);
        let sum = 0;
        for (const value of bytes) sum += ((value - 128) / 128) ** 2;
        return Math.sqrt(sum / bytes.length);
      },
      close() { closed = true; void context.close().catch(() => undefined); },
    };
  } catch { return undefined; }
}
