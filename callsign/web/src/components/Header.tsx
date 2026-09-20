import type { PhoneState } from "@callsign/shared";
import { IconShield } from "./ui.tsx";

export type SessionCounts = { verified: number; quarantined: number; calls: number };

export type NavLink = { href: string; label: string; title?: string };

/**
 * Sticky, translucent top nav: wordmark left, quiet status and session
 * counters right. The console passes onPresent; standalone pages (/try)
 * pass links back instead.
 */
export function Header({
  phone,
  connected,
  counts,
  links,
  onPresent,
}: {
  phone: PhoneState;
  connected: boolean;
  counts?: SessionCounts;
  links?: NavLink[];
  onPresent?: () => void;
}) {
  const status = !connected ? "Reconnecting…" : phone.paired ? `Phone paired · ${phone.deviceName ?? "Phone"}` : "No phone paired";
  const total = counts ? counts.verified + counts.quarantined + counts.calls : 0;
  return (
    <nav className="nav" aria-label="Callsign">
      <div className="nav-inner">
        <a className="wordmark" href="/">
          <span className="wordmark-mark" aria-hidden>
            <IconShield />
          </span>
          Callsign
        </a>
        <div className="nav-right">
          {counts && total > 0 && (
            <span className="nav-counts num" title="This session">
              {counts.verified} verified · {counts.quarantined} quarantined · {counts.calls} {counts.calls === 1 ? "call" : "calls"}
            </span>
          )}
          <span className="nav-status" title={status}>
            <span className={`dot ${!connected ? "off" : phone.paired ? "" : "idle"}`} aria-hidden />
            <span className="nav-status-text">{status}</span>
          </span>
          {links?.map((l) => (
            <a key={l.href} className="nav-link" href={l.href} title={l.title}>
              {l.label}
            </a>
          ))}
          {onPresent && (
            <button type="button" className="nav-link" onClick={onPresent} title="Presenter panel (`)">
              Present
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
