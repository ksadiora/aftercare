/** Inline SVG glyphs for the phone screens (no icon font, no downloads). */

const base = { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** Handset, as on the green Accept button. */
export function PhoneGlyph() {
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.3 1.1L6.6 10.8z" />
    </svg>
  );
}

/** Handset pointing down, as on the red Decline / End button. */
export function HangupGlyph() {
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <path d="M12 9c-2.9 0-5.6.6-8.1 1.7-.4.2-.6.6-.6 1v3.1c0 .6.4 1 1 1 1.3 0 2.5-.2 3.6-.6.3-.1.7 0 1 .2l1.9 1.9c.2.2.6.3.9.1a13.6 13.6 0 0 1 .6-.3l.5-.3c.4-.2.6-.6.6-1V13c0-.4.3-.8.7-.9a9 9 0 0 1 3.8 0c.4.1.7.5.7.9v2.8c0 .4.2.8.6 1l.5.3.6.3c.3.2.7.1.9-.1l1.9-1.9c.3-.2.7-.3 1-.2 1.1.4 2.3.6 3.6.6.6 0 1-.4 1-1v-3.1c0-.4-.2-.8-.6-1A20.7 20.7 0 0 0 12 9z" transform="translate(0 0)" />
    </svg>
  );
}

/** Shield with a check, for "Verified via ANS". */
export function ShieldGlyph() {
  return (
    <svg {...base} fill="currentColor" stroke="none">
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3zm-1.2 13.6-3.3-3.3 1.4-1.4 1.9 1.9 4.6-4.6 1.4 1.4-6 6z" />
    </svg>
  );
}

/**
 * Shield outline + check that draw themselves in (stroke-dashoffset, see
 * .ph-shield-draw in phone.css), then fill. For the incoming-call screen.
 */
export function ShieldDrawGlyph() {
  return (
    <svg {...base} className="ph-shield-draw" strokeWidth={1.8}>
      <path className="fill" d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" fill="currentColor" stroke="none" />
      <path className="outline" pathLength={1} d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" />
      <path className="check" pathLength={1} d="m8.2 12.1 2.6 2.6 5-5" />
    </svg>
  );
}

export function MicGlyph() {
  return (
    <svg {...base}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  );
}

export function KeyboardGlyph() {
  return (
    <svg {...base}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </svg>
  );
}

export function SpeakerGlyph() {
  return (
    <svg {...base}>
      <path d="M4 10v4h3l4 4V6L7 10H4z" fill="currentColor" stroke="none" />
      <path d="M15 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
    </svg>
  );
}

export function SpinnerGlyph() {
  return (
    <svg {...base}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

export function WaveGlyph() {
  return (
    <svg {...base}>
      <path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2" />
    </svg>
  );
}
