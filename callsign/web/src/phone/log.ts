/**
 * `[phone]` console logging for the presenter. Every microphone, recognition,
 * audio and call-lifecycle event on the phone goes through here so a stuck
 * demo can be debugged from DevTools in seconds. Never throws.
 */
const t0 = typeof performance === "undefined" ? 0 : performance.now();

export function plog(...args: unknown[]): void {
  try {
    const t = ((performance.now() - t0) / 1000).toFixed(2);
    console.log(`[phone] +${t}s`, ...args);
  } catch {
    /* ignore */
  }
}

export function pwarn(...args: unknown[]): void {
  try {
    const t = ((performance.now() - t0) / 1000).toFixed(2);
    console.warn(`[phone] +${t}s`, ...args);
  } catch {
    /* ignore */
  }
}
