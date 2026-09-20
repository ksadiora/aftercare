import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, HeartHandshake, LoaderCircle, Send, TriangleAlert, UserRound } from 'lucide-react';
import type { Dashboard, Outreach, Patient } from '../shared/types';
import { api } from './api';

/**
 * Demo convenience: pick which patient to be, instead of pasting a token URL that
 * changes on every reset.
 *
 * This page sits behind the care-team password, because the list of invitation
 * links is exactly the thing that must not be public. A patient's own link still
 * needs no password — the unguessable token is their credential. Real deployments
 * would not have this page at all; the patient arrives by SMS or email.
 */
export function PatientPicker() {
  const [data, setData] = useState<Dashboard>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (quiet = false) => {
    try { setData(await api<Dashboard>('/dashboard')); }
    catch (e) { if (!quiet) setError(e instanceof Error ? e.message : 'Could not load patients.'); }
  }, []);
  useEffect(() => {
    // The scheduler creates invitations a moment after a reset, so a page that
    // fetched once would sit showing "Create link" for someone who already has one.
    void load();
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function invite(id: string) {
    setBusy(id); setError('');
    try { await api(`/patients/${id}/outreach`, {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not create a link.'); }
    finally { setBusy(''); }
  }

  const featured: Patient[] = (data?.patients ?? []).filter(p => p.featured);
  const linkFor = (id: string): Outreach | undefined => data?.outreach.find(o => o.patientId === id);

  return <div className="landing-shell">
    <div className="landing">
      <a className="patient-brand" href="/" aria-label="Aftercare home"><span className="brand-icon"><HeartHandshake size={20} strokeWidth={1.8} /></span>aftercare<span className="brand-period">.</span></a>
      <h1>Which patient are you?</h1>
      <p className="patient-intro">Open the check-in as one of the synthetic patients. Each link is their own; it shows their record and nothing else.</p>

      {error && <div className="error-banner" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
      {!data && <div className="empty-state"><LoaderCircle className="spin" />Loading…</div>}

      {featured.map(patient => {
        const link = linkFor(patient.id);
        return <div className="landing-role picker-row" key={patient.id}>
          <span className={`avatar ${patient.avatar}`}>{patient.initials}</span>
          <div>
            <strong>{patient.name}</strong>
            <span>{patient.age} years · {patient.language === 'es' ? 'Spanish' : 'English'} · {patient.procedure}</span>
          </div>
          {link
            ? <a className="button primary" href={`/c/${link.token}`}>Open as {patient.name.split(' ')[0]}<ArrowRight size={15} /></a>
            : <button className="button secondary" disabled={busy === patient.id} onClick={() => void invite(patient.id)}>
                <Send size={15} />{busy === patient.id ? 'Creating…' : 'Create link'}
              </button>}
        </div>;
      })}

      <p className="landing-footer"><UserRound size={13} />This picker is staff-only. A patient would receive their link directly and never see this page.</p>
      <a className="text-button" href="/"><ArrowLeft size={14} />Back to roles</a>
    </div>
  </div>;
}
