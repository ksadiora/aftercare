import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, LoaderCircle, RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { EscalationRecord, EscalationStep, EscalationView, ProviderPolicy } from '../shared/types';
import { api } from './api';

/**
 * The escalation gate, as both sides see it. Aftercare owns the case; Callsign
 * (server/callsign/) checks whether an escalation may reach the intended
 * provider. The nurse sees the verdict and the reason beside the case and can
 * retry a held delivery; the provider sees the same record with the evidence of
 * every check next to the escalation, the nurse's note and the summary.
 */
const stepStates: Record<EscalationStep['status'], string> = { pending: 'Waiting', running: 'Checking', pass: 'Passed', fail: 'Stopped', skipped: 'Skipped' };
const statusLabels: Record<EscalationRecord['status'], string> = { verifying: 'Verifying', delivered: 'Delivered to the provider', held: 'Held', rejected: 'Rejected' };
const variantLabels: Record<EscalationRecord['variant'], string> = { genuine: '', spoof: 'Demo · spoofed sender', tamper: 'Demo · tampered message', replay: 'Demo · replayed message' };
const time = (value: string) => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function EscalationGate({ patientId, mode, nurse = 'Demo nurse' }: { patientId: string; mode: 'nurse' | 'provider'; nurse?: string }) {
  const [view, setView] = useState<EscalationView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(mode === 'provider');

  const load = useCallback(async () => {
    try { setView(await api<EscalationView>(`/patients/${patientId}/escalation`)); }
    catch { /* keep the last view; the next update retries */ }
  }, [patientId]);

  useEffect(() => {
    void load();
    const events = new EventSource('/api/events');
    events.addEventListener('update', () => void load());
    return () => events.close();
  }, [load]);

  const act = async (path: string, body: unknown) => {
    if (busy) return;
    setBusy(true); setError('');
    try { setView(await api<EscalationView>(`/patients/${patientId}/escalation/${path}`, body)); }
    catch (e) { setError(e instanceof Error ? e.message : 'The escalation gate could not complete that action.'); }
    finally { setBusy(false); }
  };

  if (!view) return null;
  const record = view.escalation;
  if (!record) {
    return mode === 'provider' ? <section className="escalation-gate idle" aria-label="Escalation gate"><span className="small-kicker"><ShieldCheck size={13} /> VERIFIED BY YOUR CALLSIGN AGENT</span><p className="small muted">No gated escalation on record for this case.</p></section> : null;
  }
  const passed = record.steps.filter(s => s.status === 'pass').length;
  const failed = record.steps.find(s => s.status === 'fail');

  return <section className={`escalation-gate ${mode} ${record.status}`} aria-label="Escalation gate">
    <span className="small-kicker">
      {record.status === 'delivered' ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
      {mode === 'provider' ? ' VERIFIED BY YOUR CALLSIGN AGENT' : ` ${view.providerName.toUpperCase()}'S CALLSIGN AGENT`}
      <span className={`gate-status ${record.status}`}>{statusLabels[record.status]}</span>
      {record.variant !== 'genuine' && <span className="gate-status demo">{variantLabels[record.variant]}</span>}
    </span>
    <p className="gate-line">
      {record.status === 'delivered'
        ? <>Signed by <code>{record.sender}</code> as “{record.senderDisplayName}”, verified by <code>{record.providerAgent}</code> · {passed} of {record.steps.length} checks passed · {time(record.updatedAt)}</>
        : <>{record.reason ?? 'Checking…'} <span className="muted">({passed} of {record.steps.length} checks passed{failed ? `, stopped at ${failed.label.toLowerCase()}` : ''})</span></>}
    </p>
    <button type="button" className="text-button gate-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}><ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} />{open ? 'Hide the checks' : 'Show the checks and evidence'}</button>
    {open && <ol className="gate-steps" aria-label="Verification steps">
      {record.steps.map(step => <li key={step.id} className={step.status}>
        <div><span>{step.label}</span><strong>{stepStates[step.status]}</strong>{step.ms !== undefined && <small>{step.ms} ms</small>}</div>
        {step.detail && <p>{step.detail}</p>}
        {mode === 'provider' && step.evidence && step.evidence.length > 0 && <dl className="gate-evidence">{step.evidence.map((row, i) => <div key={`${row.label}-${i}`}><dt>{row.label}</dt><dd className={row.mono ? 'mono' : ''}>{row.value}</dd></div>)}</dl>}
      </li>)}
    </ol>}
    {open && record.screening && record.screening.signals.some(s => s.severity !== 'neutral') && <ul className="gate-signals">{record.screening.signals.filter(s => s.severity !== 'neutral').map((s, i) => <li key={i} className={s.severity}><strong>{s.label}</strong> {s.detail}{s.quote && <em> “{s.quote}”</em>}</li>)}</ul>}
    {mode === 'nurse' && <div className="gate-actions">
      {(record.status === 'held' || record.status === 'rejected') && <button className="button secondary" disabled={busy} onClick={() => void act('retry', { nurse })}><RefreshCw size={14} />{busy ? 'Verifying…' : 'Retry delivery'}</button>}
      <span className="small muted">Demo what an attacker's copy looks like:</span>
      <button className="text-button" disabled={busy} onClick={() => void act('demo', { variant: 'spoof', nurse })}>Spoofed sender</button>
      <button className="text-button" disabled={busy} onClick={() => void act('demo', { variant: 'tamper', nurse })}>Tampered message</button>
      <button className="text-button" disabled={busy} onClick={() => void act('demo', { variant: 'replay', nurse })}>Replayed message</button>
      {busy && <LoaderCircle className="spin" size={14} />}
    </div>}
    {mode === 'provider' && <p className="small muted">Registry: {view.registryMode === 'local' ? 'this server’s local ANS-shaped registry' : `${view.registryMode} registry checks`} · <a href={`/api/proof/${encodeURIComponent(record.requestId)}`} target="_blank" rel="noreferrer">proof record ↗</a>{record.registry.base && <> · <a href={`${record.registry.base}/`} target="_blank" rel="noreferrer">registry ↗</a></>}</p>}
    {error && <div className="error-banner" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
  </section>;
}

/** The provider's own rule: whether verified escalations may be delivered right now. */
export function ProviderPolicyToggle() {
  const [policy, setPolicy] = useState<ProviderPolicy>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<ProviderPolicy>('/provider/policy').then(setPolicy).catch(() => undefined); }, []);
  const toggle = async () => {
    if (!policy || busy) return;
    setBusy(true);
    try { setPolicy(await api<ProviderPolicy>('/provider/policy', { acceptCalls: !policy.acceptCalls, note: policy.acceptCalls ? 'In clinic' : '' })); }
    catch { /* the toggle keeps its last known state */ }
    finally { setBusy(false); }
  };
  if (!policy) return null;
  return <button type="button" className={`text-button policy-toggle ${policy.acceptCalls ? 'on' : 'off'}`} role="switch" aria-checked={policy.acceptCalls} disabled={busy} onClick={() => void toggle()} title="Verified escalations are delivered only while this is on; otherwise they are held for the nurse with a reason.">
    {policy.acceptCalls ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}{policy.acceptCalls ? 'Accepting escalations' : 'Holding escalations'}
  </button>;
}
