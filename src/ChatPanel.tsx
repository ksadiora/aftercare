import { useState } from 'react';
import { MessageSquare, Send, Square } from 'lucide-react';
import type { Language, Session } from '../shared/types';

export function ChatPanel(props: {
  patient: string; language: Language; session: Session | null;
  busy: boolean; disabled: boolean; reason: string; model: string;
  onStart: () => void; onSend: (text: string) => Promise<void>; onEnd: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const live = props.session && props.session.status === 'active';
  const closed = Boolean(props.session?.next.done);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try { await props.onSend(text); setDraft(''); }
    finally { setSending(false); }
  }

  return <section className="chat-panel" aria-label="Text chat check-in">
    <div className="chat-network"><span className="tiny-dot" />TEXT CHAT · {props.model.toUpperCase()}</div>
    <p className="call-participant">You are {props.patient} · {props.language === 'es' ? 'Español' : 'English'}</p>
    {live ? <>
      <form className="chat-composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-draft">Your reply</label>
        <textarea
          id="chat-draft" value={draft} rows={2} maxLength={2000} autoFocus
          placeholder={closed ? 'The check-in has ended.' : 'Answer in your own words…'}
          disabled={closed || sending}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(e); } }}
        />
        <div className="chat-actions">
          <button type="submit" className="button primary" disabled={closed || sending || !draft.trim()}><Send size={16} />{sending ? 'Sending…' : 'Send reply'}</button>
          <button type="button" className="button secondary" onClick={props.onEnd}><Square size={15} />End check-in</button>
        </div>
      </form>
      <p className="call-hint">Enter sends; Shift+Enter starts a new line. The nurse sees your exact words.</p>
    </> : <>
      <button className="button primary full-width" onClick={props.onStart} disabled={props.disabled || props.busy}>
        <MessageSquare size={17} />{props.busy ? 'Starting…' : 'Start text check-in'}
      </button>
      <p className="call-hint">{props.disabled ? props.reason : 'Type your answers. The follow-up agent asks one question at a time and can rephrase a question you are unsure about.'}</p>
    </>}
    <div className="call-transfer-note">Urgency is decided by the server's rules, not the language model.</div>
  </section>;
}
