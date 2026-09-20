import { useEffect, useRef, type ReactNode } from "react";
import QRCode from "qrcode";

/** Small shared pieces: icons, time formatting, empty state, QR, sheet shell. */

export function DemoCredentials() {
  return <p className="demo-credentials"><strong>Demo credentials.</strong> This server signs the selected identity for this demonstration. Passing checks proves possession of a demo key, not a person's or company's real-world identity.</p>;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function Empty({ title, sub, glyph }: { title: string; sub?: string; glyph?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        <div className="empty-glyph">{glyph ?? <IconDot />}</div>
        <div className="empty-title">{title}</div>
        {sub && <div className="empty-sub">{sub}</div>}
      </div>
    </div>
  );
}

/**
 * Keeps a scrolling element pinned to its bottom: on every dependency change,
 * and whenever the element or any of its children changes size (a sibling
 * appearing below it, a web font arriving and reflowing the text).
 */
export function usePinToBottom<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** A QR code drawn on a canvas. Re-renders when the value changes. */
export function Qr({ value, size = 132 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !value) return;
    QRCode.toCanvas(canvas, value, {
      width: size * 2,
      margin: 4,
      color: { dark: "#1d1d1f", light: "#ffffff" },
    }).catch(() => {
      /* an unencodable value leaves the canvas blank; the URL text is still shown */
    });
  }, [value, size]);
  return (
    <div className="qr" aria-label={`QR code for ${value}`}>
      <canvas ref={ref} />
    </div>
  );
}

/** Slide-in sheet from the right. Stays mounted so it can animate out. */
export function Sheet({
  open,
  title,
  meta,
  wide,
  onClose,
  label,
  children,
}: {
  open: boolean;
  title: string;
  meta?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <aside className={`sheet ${wide ? "wide" : ""} ${open ? "open" : ""}`} role="dialog" aria-label={label} aria-hidden={!open}>
      <div className="sheet-head">
        <h2>{title}</h2>
        {meta && <span className="card-meta">{meta}</span>}
        <button type="button" className="sheet-close" onClick={onClose} aria-label={`Close ${label}`} tabIndex={open ? 0 : -1}>
          <IconClose />
        </button>
      </div>
      <div className="sheet-body">{children}</div>
    </aside>
  );
}

export function Pill({ tone, dot, children }: { tone?: "green" | "red" | "amber" | "blue"; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`pill ${tone ?? ""}`}>
      {dot && <span className="dot" aria-hidden />}
      {children}
    </span>
  );
}

const svg = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function IconDot() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...svg}>
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

export function IconCheck({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...svg} strokeWidth={3.2}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconCross({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...svg} strokeWidth={3.2}>
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

export function IconClose() {
  return (
    <svg viewBox="0 0 24 24" {...svg} strokeWidth={2.4}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconChevron() {
  return (
    <svg className="chev" viewBox="0 0 24 24" {...svg} strokeWidth={2.6}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function IconPhone() {
  return (
    <svg viewBox="0 0 24 24" {...svg}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}

export function IconShield() {
  return (
    <svg viewBox="0 0 24 24" {...svg}>
      <path d="M12 2l8 3.5v6c0 5-3.4 8.6-8 10.5-4.6-1.9-8-5.5-8-10.5v-6L12 2z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}

export function IconInbox() {
  return (
    <svg viewBox="0 0 24 24" {...svg}>
      <path d="M3 13l2.5-8h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />
      <path d="M3 13h5l1.5 3h5L16 13h5" />
    </svg>
  );
}

export function IconHandshake() {
  return (
    <svg viewBox="0 0 24 24" {...svg}>
      <path d="M3 8l4-2 5 3 5-3 4 2v7l-5 4-4-3-4 3-5-4z" />
    </svg>
  );
}
