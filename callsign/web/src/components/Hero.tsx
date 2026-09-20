import type { DoctorProfile, PhoneState } from "@callsign/shared";
import { PhoneCard } from "./PhoneCard.tsx";
import { IconChevron } from "./ui.tsx";

/** Compact white strip under the nav: who this agent protects, and the phone it rings. */
export function Hero({ doctor, phone, onDock, docked }: { doctor: DoctorProfile; phone: PhoneState; onDock?: () => void; docked?: boolean }) {
  return (
    <header className="hero">
      <div className="hero-inner">
        <div>
          <h1>{doctor.name}</h1>
          <p className="hero-sub">
            <span>{doctor.specialty}</span>
            <span aria-hidden>·</span>
            <span className="mono">{doctor.agentName}</span>
          </p>
          <p className="hero-links">
            <a className="link" href="/call" title="Call Dr. Patel yourself and hear what her agent does">
              Be the caller <IconChevron />
            </a>
            <a className="link" href="/try" title="Compose your own request and watch the checks">
              Try to fool it <IconChevron />
            </a>
          </p>
        </div>
        <PhoneCard phone={phone} onDock={onDock} docked={docked} />
      </div>
    </header>
  );
}
