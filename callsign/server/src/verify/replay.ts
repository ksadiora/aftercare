/**
 * REPLAY PROTECTION  (owner: Identity lane)
 *
 * A valid signature proves who wrote a message, not when. An attacker who
 * captured a genuine brand message can resend it unchanged and the signature
 * still verifies. Two cheap checks close that hole, in every ANS mode:
 *
 *  1. Freshness: `ts` must be within REPLAY_WINDOW_MS in the past and at most
 *     FUTURE_SKEW_MS in the future (clock skew between agents).
 *  2. Uniqueness: (from, id) of every message whose signature step passed is
 *     remembered for this process, bounded FIFO, and a second sighting is
 *     rejected with the time the first one was verified.
 *
 * Both are applied after the signature itself has been checked, so the trust
 * card can say "the signature is real, but this message is 11 minutes old and
 * was already verified at 10:42:03".
 */

export const REPLAY_WINDOW_MS = 5 * 60_000;
export const FUTURE_SKEW_MS = 2 * 60_000;
const MAX_SEEN = 5000;

/** "from|id" -> epoch ms when the signature step first passed. Insertion-ordered, so the oldest entry is evicted first. */
const seen = new Map<string, number>();

const keyOf = (from: string, id: string) => `${from.trim().toLowerCase()}|${id}`;

export interface Freshness {
  ok: boolean;
  /** Positive = message is in the past. NaN when ts is unreadable. */
  ageMs: number;
  detail: string;
}

export function checkFreshness(ts: string | undefined, now = Date.now()): Freshness {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return { ok: false, ageMs: NaN, detail: `message timestamp unreadable (${ts ?? "missing"})` };
  const ageMs = now - t;
  if (ageMs > REPLAY_WINDOW_MS) return { ok: false, ageMs, detail: `message is ${formatAge(ageMs)} old · replay window is ${formatAge(REPLAY_WINDOW_MS)}` };
  if (-ageMs > FUTURE_SKEW_MS) return { ok: false, ageMs, detail: `message is dated ${formatAge(-ageMs)} in the future · allowed skew is ${formatAge(FUTURE_SKEW_MS)}` };
  return { ok: true, ageMs, detail: `${formatAge(ageMs)} old · inside the ${formatAge(REPLAY_WINDOW_MS)} replay window` };
}

/** When this (from, id) was first verified in this process, if ever. */
export function seenAt(from: string, id: string): number | undefined {
  return seen.get(keyOf(from, id));
}

/** Remember a message whose signature step passed. Call only after every signature check succeeded. */
export function markVerified(from: string, id: string, at = Date.now()): void {
  const k = keyOf(from, id);
  if (seen.has(k)) return;
  seen.set(k, at);
  while (seen.size > MAX_SEEN) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

export function seenCount(): number {
  return seen.size;
}

/** "45 s", "11 min", "2 h 5 min". Negative input is treated as its magnitude. */
export function formatAge(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Wall-clock "10:42:03" for the trust card. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
