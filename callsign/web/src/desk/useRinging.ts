import { useEffect } from "react";
/** An optional, quiet incoming-call cue; scoped to this receiver's ringing state. */
export function useRinging(ringing: boolean, enabled: boolean) {
  useEffect(() => {
    if (!ringing || !enabled || !window.AudioContext) return;
    const context = new AudioContext();
    const ring = () => {
      if (context.state !== "running") return;
      for (const delay of [0, .35]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = 660;
        gain.gain.setValueAtTime(0, context.currentTime + delay);
        gain.gain.linearRampToValueAtTime(.055, context.currentTime + delay + .02);
        gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + delay + .23);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(context.currentTime + delay);
        oscillator.stop(context.currentTime + delay + .25);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
    };
    void context.resume().then(ring).catch(() => undefined);
    const interval = window.setInterval(ring, 2600);
    return () => { window.clearInterval(interval); void context.close().catch(() => undefined); };
  }, [ringing, enabled]);
}
