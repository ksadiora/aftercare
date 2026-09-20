import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, HeartHandshake, Inbox, LoaderCircle, Send, Stethoscope, TriangleAlert } from 'lucide-react';
import type { CaseMessage, EscalationRecord, Patient } from '../shared/types';
import { severityLabels } from '../shared/types';
import { api } from './api';
import { Briefing } from './Briefing';
import { EscalationGate, ProviderPolicyToggle } from './EscalationGate';

interface QueueItem {
  patient: Patient; escalatedAt: string | null; reason: string;
  summary: string | null; summarySource: string | null;
  lastReply: string | null; repliedAt: string | null;
  thread: CaseMessage[];
  escalation: EscalationRecord | null;
}

const time = (value: string | null) => value ? new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

/**
 * The provider's surface. Deliberately not the nurse dashboard: it shows only what a
 * nurse has escalated, the reason they gave, and the source-linked briefing — then
 * takes a written reply back into the same audit trail the nurse reads.
 */
export function ProviderView({ chatReady, chatReason }: { chatReady: boolean; chatReason: string }) {
  const [queue, setQueue] = useState<QueueItem[]>();
  const [selected, setSelected] = useState<string>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const provider = new URLSearchParams(window.location.search).get('name')?.trim().slice(0, 60) || 'Demo provider';
  const threadEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<QueueItem[]>('/provider/queue');
      setQueue(next);
      setSelected(current => current && next.some(i => i.patient.id === current) ? current : next[0]?.patient.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the queue.'); }
  }, []);

  useEffect(() => {
    void load();
    const events = new EventSource('/api/events');
    events.addEventListener('update', () => void load());
    return () => events.close();
  }, [load]);

  async function reply(event: React.FormEvent) {
    event.preventDefault();
    const text = note.trim();
    if (!text || !selected || busy) return;
    setBusy(true); setError('');
    try { await api(`/patients/${selected}/provider-note`, { note: text, provider }); setNote(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send your note.'); }
    finally { setBusy(false); }
  }

  const current = queue?.find(i => i.patient.id === selected);
  // The list is scrollable, so a long thread would otherwise open on its oldest message.
  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'nearest' }); }, [current?.thread.length, selected]);

  return <div className="provider-shell">
    <header className="provider-top">
      <a className="brand" href="/" aria-label="Aftercare home"><span className="brand-icon"><HeartHandshake size={20} strokeWidth={1.8} /></span>aftercare<span className="brand-period">.</span></a>
      <span className="provider-role"><Stethoscope size={14} />Provider view · {provider}</span>
      <ProviderPolicyToggle />
      <a className="text-button" href="/"><ArrowLeft size={14} />Switch role</a>
    </header>

    <main className="provider-main">
      <section className="provider-queue" aria-label="Escalated cases">
        <div className="card-title"><h3><Inbox size={15} />Escalated to you</h3><span className="small muted">{queue?.length ?? 0}</span></div>
        {!queue && <div className="empty-state"><LoaderCircle className="spin" />Loading…</div>}
        {queue?.length === 0 && <div className="empty-state compact"><Inbox size={22} /><p>Nothing escalated. Cases appear here the moment a nurse escalates one.</p></div>}
        {queue?.map(item => <button key={item.patient.id} className={`provider-row ${selected === item.patient.id ? 'is-selected' : ''}`} onClick={() => setSelected(item.patient.id)}>
          <div><strong>{item.patient.name}</strong><span>{severityLabels[item.patient.severity]} · escalated {time(item.escalatedAt)}</span></div>
          {item.thread.at(-1)?.role === 'provider' ? <em className="replied">you replied</em> : <em className="waiting">awaiting you</em>}
        </button>)}
      </section>

      <section className="provider-detail" aria-label="Case detail">
        {error && <div className="error-banner" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
        {!current ? <div className="empty-state"><Stethoscope size={24} /><p>Select an escalated case.</p></div> : <>
          <div className="provider-head">
            <h2>{current.patient.name}</h2>
            <p className="small muted">{current.patient.age} years · {current.patient.procedure} · {current.patient.language === 'es' ? 'Spanish' : 'English'} preferred</p>
          </div>
          {/* The generated summary stays outside the conversation: it is context, not
              something a person said, and the two must never read as one voice. */}
          {current.summary && <div className="provider-summary">
            <span className="small-kicker">AUTOMATED CASE SUMMARY <span className="synthetic-pill">DRAFT</span></span>
            <p>{current.summary}</p>
            <span className="small muted">{current.summarySource}</span>
          </div>}
          <EscalationGate patientId={current.patient.id} mode="provider" />
          <div className="case-thread" aria-label="Conversation with the care team">
            <span className="small-kicker">CONVERSATION WITH THE CARE TEAM{current.thread.at(-1)?.role === 'nurse' ? ' · AWAITING YOU' : ' · AWAITING THE NURSE'}</span>
            <div className="case-messages">
              {current.thread.length ? current.thread.map(message => <div className={`case-message ${message.role}`} key={message.id}>
                <span className="case-author">{message.author}<time>{time(message.at)}</time></span>
                <p>{message.text}</p>
              </div>) : <p className="small muted">The nurse escalated without a note. The summary above is the whole of what they sent.</p>}
              <div ref={threadEnd} />
            </div>
          </div>
          <Briefing patientId={current.patient.id} patientName={current.patient.name} available={chatReady} reason={chatReason} />

          <form className="provider-reply" onSubmit={reply}>
            <label htmlFor="provider-note">Reply to the nurse</label>
            <textarea id="provider-note" rows={3} maxLength={2000} value={note}
              placeholder="Guidance for the nurse, or a question back to them. This goes into the patient's audit trail and, when your Callsign agent has connected the call, to that conversation too."
              onChange={e => setNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void reply(e); } }} />
            <button className="button primary" disabled={busy || !note.trim()}><Send size={15} />{busy ? 'Sending…' : 'Send to nurse'}</button>
          </form>
          <p className="small muted">Every message here is recorded against this patient and appears on the nurse's screen. Neither side's message changes the case disposition — the nurse still decides.</p>
        </>}
      </section>
    </main>
  </div>;
}
