/**
 * Ringtone for an incoming call, synthesised rather than shipped as a file: no
 * asset to load, and nothing to fail at the moment it is needed.
 *
 * Browsers refuse audio until the page has been interacted with, and an incoming
 * call is exactly the case where that may not have happened yet. So the title
 * flash is not a nicety — on a page the person has not touched, it is the only
 * signal that works, and it runs whether or not the tone does.
 */
const RING_MS = 1600;
const GAP_MS = 2200;
// The classic North American pair. Two tones beat against each other and carry
// better than one, which matters on a laptop speaker in a noisy room.
const TONES = [440, 480];

type Ctx = AudioContext & { state: string; resume: () => Promise<void> };

export function createRingtone(label = 'Incoming call') {
  let context: Ctx | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flash: ReturnType<typeof setInterval> | undefined;
  let ringing = false;
  let originalTitle = '';

  const Ctor = typeof window !== 'undefined'
    ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    : undefined;

  function burst() {
    if (!ringing || !context || context.state !== 'running') return;
    const now = context.currentTime;
    const gain = context.createGain();
    gain.connect(context.destination);
    // Ramped, never stepped: an abrupt gain change is an audible click.
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
    gain.gain.setValueAtTime(0.12, now + RING_MS / 1000 - 0.08);
    gain.gain.linearRampToValueAtTime(0, now + RING_MS / 1000);
    for (const frequency of TONES) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + RING_MS / 1000);
    }
  }

  function cycle() {
    burst();
    timer = setTimeout(cycle, RING_MS + GAP_MS);
  }

  return {
    /** Safe to call repeatedly; only the first call starts anything. */
    async start() {
      if (ringing) return;
      ringing = true;

      if (typeof document !== 'undefined') {
        originalTitle = document.title;
        let on = false;
        flash = setInterval(() => { on = !on; document.title = on ? `☎ ${label}` : originalTitle; }, 900);
      }

      if (!Ctor) return;
      try {
        context = new Ctor() as Ctx;
        // Suspended means the page has not been interacted with. resume() succeeds
        // if it has; if not, the flashing title carries the message alone.
        if (context.state === 'suspended') await context.resume().catch(() => undefined);
        cycle();
      } catch { /* no audio available; the title still flashes */ }
    },
    stop() {
      ringing = false;
      clearTimeout(timer); timer = undefined;
      clearInterval(flash); flash = undefined;
      if (originalTitle && typeof document !== 'undefined') document.title = originalTitle;
      void context?.close().catch(() => undefined);
      context = undefined;
    },
    /** True only when a tone is actually sounding, not merely requested. */
    audible: () => ringing && context?.state === 'running',
  };
}
