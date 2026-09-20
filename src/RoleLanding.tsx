import { useEffect, useState } from 'react';
import { ArrowRight, ClipboardList, Gamepad2, HeartHandshake, ShieldCheck, Stethoscope, UserRound } from 'lucide-react';
import type { Capabilities } from '../shared/types';
import { api } from './api';

/**
 * Demo role chooser. Real deployments would route people here by account, not by
 * clicking; this exists so three surfaces can be opened on three machines without
 * building a sign-in system that the demo does not need.
 */
export function RoleLanding() {
  const [gate, setGate] = useState<Pick<Capabilities, 'escalationGate' | 'providerName' | 'providerAgentName' | 'careTeamAgentName'>>();
  useEffect(() => { void api<Capabilities>('/capabilities').then(setGate).catch(() => undefined); }, []);
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

      {gate?.escalationGate && <div className="landing-role landing-note">
        <span className="landing-icon"><ShieldCheck size={20} /></span>
        <div>
          <strong>Escalations are gated by Callsign</strong>
          <span>A nurse's escalation is signed by {gate.careTeamAgentName} and verified by {gate.providerName}'s agent ({gate.providerAgentName}) before it can reach the provider. The evidence sits on both pages.</span>
        </div>
      </div>}

      <a className="landing-role landing-side" href="http://127.0.0.1:4173/" target="_blank" rel="noreferrer">
        <span className="landing-icon"><Gamepad2 size={20} /></span>
        <div>
          <strong>Codi's Cove · side project</strong>
          <span>A separate life-skills game from the same team. Runs on its own server (npm run cove); not connected to the clinical flow.</span>
        </div>
        <ArrowRight size={17} />
      </a>

      <p className="landing-footer"><ShieldCheck size={13} />Synthetic patients only. This is a demonstration, not medical care, and not a HIPAA-compliant system.</p>
    </div>
  </div>;
}
