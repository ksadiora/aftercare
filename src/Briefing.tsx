import { useState } from 'react';
import { ArrowRight, FileText, Languages, LoaderCircle, MessageSquare, Quote, Search, TriangleAlert } from 'lucide-react';
import type { QuestionId } from '../shared/types';
import { questions } from '../shared/protocol';
import { api } from './api';

interface Citation { turnId: string; role: 'agent' | 'user'; text: string }
interface Statement { text: string; citations: Citation[] }
export interface BriefingData {
  patientId: string; sessionId: string; draft: true; generatedAt: string; model: string;
  reason: string; statements: Statement[];
  quote: { original: string; language: string; englishTranslation: string | null } | null;
  answered: QuestionId[]; unanswered: QuestionId[];
  timeline: { at: string; text: string }[];
}
interface Answer { question: string; answer: string; citations: Citation[]; grounded: boolean }

function Sources({ citations }: { citations: Citation[] }) {
  return <details className="briefing-sources">
    <summary>{citations.length} source {citations.length === 1 ? 'line' : 'lines'}</summary>
    {citations.map(c => <blockquote key={c.turnId} className={c.role}><span>{c.role === 'agent' ? 'Aftercare' : 'Patient'}</span>{c.text}</blockquote>)}
  </details>;
}

export function Briefing(props: { patientId: string; patientName: string; available: boolean; reason: string }) {
  const [briefing, setBriefing] = useState<BriefingData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [asking, setAsking] = useState(false);

  async function prepare() {
    setLoading(true); setError('');
    try { setBriefing(await api<BriefingData>(`/patients/${props.patientId}/briefing`, {})); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not prepare the briefing.'); }
    finally { setLoading(false); }
  }
  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const value = question.trim();
    if (value.length < 3 || asking) return;
    setAsking(true); setError('');
    try { setAnswers([await api<Answer>(`/patients/${props.patientId}/briefing/ask`, { question: value }), ...answers]); setQuestion(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not answer that question.'); }
    finally { setAsking(false); }
  }

  if (!props.available) return <div className="empty-state compact"><FileText size={24} /><p>{props.reason}</p></div>;

  return <div className="briefing">
    {error && <div className="error-banner" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
    {!briefing ? <div className="ready-card">
      <span className="ready-icon"><FileText size={24} /></span>
      <h3>Know the case before you pick up.</h3>
      <p>Build a source-linked summary of {props.patientName.split(' ')[0]}'s check-in. Every sentence points back to the transcript line it came from.</p>
      <button className="button primary" onClick={() => void prepare()} disabled={loading}>
        {loading ? <><LoaderCircle size={15} className="spin" />Preparing…</> : <>Prepare briefing<ArrowRight size={15} /></>}
      </button>
    </div> : <>
      <div className="briefing-head">
        <span className="small-kicker">CLINICIAN BRIEFING <span className="synthetic-pill">DRAFT</span></span>
        <span className="small muted">{briefing.model}</span>
      </div>
      <div className="briefing-reason"><TriangleAlert size={16} /><p>{briefing.reason}</p></div>

      {briefing.quote && <div className="briefing-quote">
        <span className="small-kicker"><Quote size={12} /> THE PATIENT'S OWN WORDS</span>
        <blockquote lang={briefing.quote.language}>{briefing.quote.original}</blockquote>
        {briefing.quote.englishTranslation && <p className="briefing-translation">
          <Languages size={13} /><em>English translation (generated, not the patient's words):</em> {briefing.quote.englishTranslation}
        </p>}
      </div>}

      <div className="briefing-section"><h4>What the transcript establishes</h4>
        {briefing.statements.length ? briefing.statements.map((s, i) => <div className="briefing-statement" key={i}>
          <p>{s.text}</p><Sources citations={s.citations} />
        </div>) : <p className="small muted">No statement in this briefing could be traced to the transcript, so none is shown.</p>}
      </div>

      <div className="briefing-section"><h4>Questions covered</h4>
        <ul className="briefing-ledger">
          {briefing.answered.map(q => <li key={q} className="answered"><span /> {questions.en[q].split(',')[0]}</li>)}
          {briefing.unanswered.map(q => <li key={q} className="unanswered"><span /> {questions.en[q].split(',')[0]} <em>not answered</em></li>)}
        </ul>
      </div>

      {briefing.timeline.length > 0 && <div className="briefing-section"><h4>What has happened so far</h4>
        <ol className="briefing-timeline">
          {briefing.timeline.map((event, i) => <li key={i}>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</time>
            <p>{event.text}</p>
          </li>)}
        </ol>
      </div>}

      <form className="briefing-ask" onSubmit={ask}>
        <label htmlFor="case-question"><MessageSquare size={13} /> Ask about this case</label>
        <div>
          <input id="case-question" value={question} maxLength={400} placeholder="What did the patient actually say about the incision?" onChange={e => setQuestion(e.target.value)} />
          <button className="button secondary" disabled={asking || question.trim().length < 3}><Search size={15} />{asking ? 'Checking…' : 'Ask'}</button>
        </div>
      </form>
      {answers.map((a, i) => <div className="briefing-answer" key={i}>
        <strong>{a.question}</strong>
        <p className={a.grounded ? '' : 'ungrounded'}>{a.answer}</p>
        {a.citations.length > 0 && <Sources citations={a.citations} />}
      </div>)}

      <p className="briefing-footer"><FileText size={13} />Draft for nurse review. Generated from this conversation only; it is not a clinical assessment and resolves nothing.</p>
    </>}
  </div>;
}
