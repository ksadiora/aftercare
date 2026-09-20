import { ArrowRight, ClipboardList, HeartHandshake, ShieldCheck, Stethoscope, UserRound } from 'lucide-react';

/**
 * Demo role chooser. Real deployments would route people here by account, not by
 * clicking; this exists so three surfaces can be opened on three machines without
 * building a sign-in system that the demo does not need.
 */
export function RoleLanding() {
  return <div className="landing-shell">
    <div className="landing">
      <a className="patient-brand" href="/" aria-label="Aftercare home"><span className="brand-icon"><HeartHandshake size={20} strokeWidth={1.8} /></span>aftercare<span className="brand-period">.</span></a>
      <h1>Who are you today?</h1>
      <p className="patient-intro">Three people see three different things. Open the one you are playing — on this machine or another.</p>

      <a className="landing-role" href="/nurse">
        <span className="landing-icon"><ClipboardList size={20} /></span>
        <div>
          <strong>Care team</strong>
          <span>The risk-sorted worklist, live check-ins, the clinician briefing, and the live handoff.</span>
        </div>
        <ArrowRight size={17} />
      </a>

      <a className="landing-role" href="/provider">
        <span className="landing-icon"><Stethoscope size={20} /></span>
        <div>
          <strong>Provider</strong>
          <span>Only what a nurse escalated, with the reason and the source-linked briefing. Reply goes back to the nurse.</span>
        </div>
        <ArrowRight size={17} />
      </a>

      <a className="landing-role" href="/patient">
        <span className="landing-icon"><UserRound size={20} /></span>
        <div>
          <strong>Patient</strong>
          <span>Pick which patient to be. In a real deployment they arrive by their own invitation link; this picker is a demo shortcut and is staff-only.</span>
        </div>
        <ArrowRight size={17} />
      </a>

      <p className="landing-footer"><ShieldCheck size={13} />Synthetic patients only. This is a demonstration, not medical care, and not a HIPAA-compliant system.</p>
    </div>
  </div>;
}
