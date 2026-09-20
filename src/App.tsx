import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, AudioLines, CalendarDays, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, ClipboardList, FileText, HeartHandshake, History, LayoutList, LoaderCircle, MessageSquare, Mic, PhoneCall, Play, Plus, RotateCcw, Search, Send, ShieldCheck, Sparkles, PhoneOutgoing, SlidersHorizontal, Square, Stethoscope, TriangleAlert, Users, Volume2, VolumeX, X } from 'lucide-react';
import type { AuditEvent, Capabilities, Dashboard, Handoff, Language, Mode, Outreach, Patient, PatientDetail, ScenarioId, Session } from '../shared/types';
import { outreachLabels, scenarioLabels, severityLabels } from '../shared/types';
import { api } from './api';
import { createInAppCall } from './voice';
import { InAppCall } from './InAppCall';
import { createSimulationPlayback } from './simulation-audio';
import { createNarrator, type Narrator } from './speech';
import { ChatPanel } from './ChatPanel';
import { Briefing } from './Briefing';
import { HandoffRinging, HandoffStatus } from './HandoffPanel';
import { joinHandoffAudio } from './handoff-media';
import { createRingtone } from './ringtone';

const date = (value: string, options?: Intl.DateTimeFormatOptions) => new Date(value).toLocaleDateString('en-US', options || { month: 'short', day: 'numeric' });
const time = (value: string) => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const ageDays = (value: string) => Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000));
const activeStatus = (s?: Session | null) => s && ['active', 'connecting'].includes(s.status);
function Badge({ patient }: { patient: Patient }) { return <span className={`badge ${patient.disposition === 'resolved' ? 'resolved' : patient.severity}`}><span className="status-dot" />{patient.disposition === 'resolved' ? 'Resolved by nurse' : severityLabels[patient.severity]}</span>; }
function Avatar({ patient, large = false }: { patient: Patient; large?: boolean }) { return <span className={`avatar ${patient.avatar} ${large ? 'large' : ''}`}>{patient.initials}</span>; }

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [detail, setDetail] = useState<PatientDetail>();
  const [selected, setSelected] = useState('alvarez');
  const [capability, setCapability] = useState<Capabilities>();
  const [cohort, setCohort] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'overview' | 'conversation' | 'briefing' | 'audit'>('overview');
  const [mode, setMode] = useState<Mode>('simulation');
  const [language, setLanguage] = useState<Language>('en');
  const [scenario, setScenario] = useState<ScenarioId>('wound');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [simulationStatus, setSimulationStatus] = useState('Simulation running');
  const [audioWarning, setAudioWarning] = useState('');
  const simulation = useRef<ReturnType<typeof createSimulationPlayback> | null>(null);
  const simulationId = useRef<string | null>(null);
  const narrator = useRef<Narrator | null>(null);
  const spokenTurn = useRef<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState('Ready');
  const [callMuted, setCallMuted] = useState(false);
  const [callVolume, setCallVolume] = useState(1);
  const [callLevel, setCallLevel] = useState(0);
  const [modal, setModal] = useState<'guide' | 'protocol' | 'history' | 'reset' | 'resolve' | 'escalate' | null>(null);
  const [note, setNote] = useState('');
  const [caseNote, setCaseNote] = useState('');
  const threadEnd = useRef<HTMLDivElement>(null);
  const [sendingNote, setSendingNote] = useState(false);
  const [history, setHistory] = useState<{ runs: { id: string; number: number; createdAt: string; conversations: number }[]; events: AuditEvent[] }>();
  const [historyRun, setHistoryRun] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [joinedHandoff, setJoinedHandoff] = useState('');
  const [handoffStatus, setHandoffStatus] = useState('');
  const [handoffPeers, setHandoffPeers] = useState(0);
  const [handoffMuted, setHandoffMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const media = useRef<ReturnType<typeof joinHandoffAudio> | null>(null);
  const ringtone = useRef<ReturnType<typeof createRingtone> | null>(null);
  // Two teammates demo the atomic claim by opening ?nurse=<name> in each browser.
  const nurse = new URLSearchParams(window.location.search).get('nurse')?.trim().slice(0, 60) || 'Demo nurse';
  // The teammate playing the patient opens ?role=patient so their Join button joins
  // the room as the patient. Without this both sides would claim the nurse seat and
  // the handoff could never reach 'active'.
  const joinRole: 'patient' | 'nurse' = new URLSearchParams(window.location.search).get('role') === 'patient' ? 'patient' : 'nurse';
  const voice = useRef<ReturnType<typeof createInAppCall> | null>(null);
  const starting = useRef(false);
  const detailSequence = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const modalRef = useRef<HTMLDialogElement>(null);
  const latestSelected = useRef(selected); latestSelected.current = selected;

  const loadDetail = useCallback(async (id: string) => {
    const sequence = ++detailSequence.current;
    const next = await api<PatientDetail>(`/patients/${id}`);
    if (sequence === detailSequence.current && id === latestSelected.current) setDetail(next);
  }, []);
  const refresh = useCallback(async () => {
    const next = await api<Dashboard>('/dashboard'); setDashboard(next);
    await loadDetail(latestSelected.current);
    return next;
  }, [loadDetail]);
  useEffect(() => {
    void refresh().catch(e => setError(e.message));
    void api<Capabilities>('/capabilities').then(setCapability).catch(e => setError(e.message));
    const events = new EventSource('/api/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener('update', () => { setConnected(true); void refresh().catch(() => undefined); });
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => { events.close(); clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { void loadDetail(selected).catch(e => setError(e.message)); }, [selected, loadDetail]);
  useEffect(() => { if (detail?.patient.id === selected) setLanguage(detail.patient.language); }, [selected, detail?.patient.id]);
  useEffect(() => {
    const session = dashboard?.activeSession;
    if (session?.patientId === selected) { setMode(session.mode); setLanguage(session.language); if (session.scenario) setScenario(session.scenario); }
  }, [dashboard?.activeSession?.id, selected]);
  useEffect(() => { if (modal && !modalRef.current?.open) modalRef.current?.showModal(); }, [modal]);
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [detail?.turns.length]);
  // A written check-in is still read aloud. Someone typing has not chosen to read in
  // silence, and a question misread is a question answered wrongly. Only the agent's
  // side is spoken; the typed reply is theirs and is never read back at them.
  useEffect(() => {
    const session = dashboard?.activeSession;
    if (!session || session.mode !== 'chat' || !detail) { spokenTurn.current = null; return; }
    const last = detail.turns.filter(turn => turn.sessionId === session.id && turn.role === 'agent').at(-1);
    if (!last || last.id === spokenTurn.current) return;
    spokenTurn.current = last.id;
    narrator.current ??= createNarrator({ muted, warning: setAudioWarning });
    narrator.current.say(last.text, last.language);
  }, [detail, dashboard?.activeSession?.id, dashboard?.activeSession?.mode, muted]);
  useEffect(() => () => { narrator.current?.cancel(); }, []);
  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'nearest' }); }, [detail?.thread?.length, selected]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => {
    const leave = () => {
      simulation.current?.cancel();
      if (simulationId.current) void fetch(`/api/sessions/${simulationId.current}/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'interrupted' }), keepalive: true });
    };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); leave(); void voice.current?.stop(); void media.current?.stop('failed'); };
  }, []);
  useEffect(() => {
    if (simulationId.current && dashboard?.activeSession?.id !== simulationId.current) simulation.current?.cancel();
  }, [dashboard?.activeSession?.id]);
  useEffect(() => {
    const session = dashboard?.activeSession;
    if (session?.mode !== 'chat' || session.status !== 'active') return;
    const beat = () => void api(`/sessions/${session.id}/heartbeat`, {}).catch(() => undefined);
    beat();
    const timer = setInterval(beat, 10000);
    return () => clearInterval(timer);
  }, [dashboard?.activeSession?.id, dashboard?.activeSession?.mode, dashboard?.activeSession?.status]);
  useEffect(() => {
    const incoming = dashboard?.handoff?.state === 'requested' && joinRole !== 'patient';
    if (incoming) {
      ringtone.current ??= createRingtone('Patient waiting');
      void ringtone.current.start();
    } else {
      ringtone.current?.stop(); ringtone.current = null;
    }
  }, [dashboard?.handoff?.state, joinRole]);
  useEffect(() => () => { ringtone.current?.stop(); }, []);
  useEffect(() => { if (modal === 'history') void api<NonNullable<typeof history>>(`/history${historyRun ? `?runId=${historyRun}` : ''}`).then(setHistory).catch(e => setError(e.message)); }, [modal, historyRun]);

  async function action(kind: 'acknowledge' | 'resolve' | 'escalate' | 'callback', actionNote = '') {
    setBusy(true); setError('');
    try {
      await api(`/patients/${selected}/actions`, { action: kind, note: actionNote });
      const next = await refresh();
      setModal(null); setNote('');
      // A callback the nurse placed should not make them accept their own request
      // and then join it. Put them on the line; let it ring at the other end.
      if (kind === 'callback' && next.handoff?.patientId === selected && next.handoff.state === 'requested') {
        await joinPlacedCall(next.handoff.id);
        return;
      }
      setToast(kind === 'callback'
        ? (capability?.handoff ? 'Calling the patient now. Their page is ringing.' : 'Callback task recorded. No call was placed; no audio route is configured.')
        : 'Nurse action saved to the audit trail.');
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save action.'); } finally { setBusy(false); }
  }

  /** Claim the call we just placed and open the microphone, in one gesture. */
  async function joinPlacedCall(id: string) {
    try {
      await api(`/handoffs/${id}/accept`, { nurse });
      setTab('conversation');
      await joinHandoff(id);
      setToast('You are on the line. Their page is ringing.');
    } catch (e) {
      // Leave the ringing banner up so it can still be accepted by hand.
      setError(e instanceof Error ? e.message : 'Placed the call but could not join it.');
      await refresh();
    }
  }
  async function start() {
    if (starting.current) return; starting.current = true; setBusy(true); setError('');
    try {
      setAudioWarning('');
      const playback = mode === 'simulation' && !muted ? createSimulationPlayback({ muted, status: setSimulationStatus, warning: setAudioWarning, stopped: () => { simulation.current = null; simulationId.current = null; void refresh(); } }) : null;
      simulation.current = playback;
      const session = await api<Session>('/sessions', { patientId: selected, mode, language, scenario, browserPlayback: Boolean(playback) });
      if (playback) simulationId.current = session.id;
      setTab('conversation'); await refresh();
      if (playback) void playback.run(session);
      if (mode === 'voice') {
        setCallMuted(false); setCallLevel(0);
        const call = createInAppCall(session, detail?.patient.name || 'Demo participant', { status: setVoiceStatus, error: setError, level: setCallLevel, stopped: () => { if (voice.current === call) voice.current = null; void refresh(); } });
        voice.current = call; call.setVolume(callVolume); await call.ready;
      }
    } catch (e) { simulation.current?.cancel(); simulation.current = null; simulationId.current = null; setError(e instanceof Error ? e.message : 'Could not start the check-in.'); }
    finally { starting.current = false; setBusy(false); }
  }
  async function end() {
    const current = dashboard?.activeSession; if (!current) return;
    simulation.current?.cancel();
    try { if (voice.current) await voice.current.stop(); else await api(`/sessions/${current.id}/end`, { reason: 'interrupted' }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not end session.'); }
  }
  async function reset(sampleData: boolean) {
    setBusy(true);
    try { await api('/demo/reset', { sampleData }); setSelected('alvarez'); setFilter('all'); setSearch(''); setTab('overview'); setModal(null); setHistoryRun(''); await refresh(); setToast(sampleData ? 'Fresh demo ready. Previous activity is saved in history.' : 'Clean run ready. Nothing is assessed until a check-in happens.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not reset demo.'); } finally { setBusy(false); }
  }
  /**
   * The conversation with the provider. It used to be one-way and buried in the
   * audit-trail tab, three clicks from where the nurse works, so a reply could sit
   * unread while the case waited on it. It is now a thread either side can add to,
   * above the tabs, visible whichever one is open.
   */
  const thread = detail?.thread ?? [];
  const awaitingNurse = new Set(dashboard?.awaitingNurse ?? []);

  async function sendCaseNote(event: React.FormEvent) {
    event.preventDefault();
    const text = caseNote.trim();
    if (!text || sendingNote) return;
    setSendingNote(true); setError('');
    try { await api(`/patients/${selected}/nurse-note`, { note: text, nurse }); setCaseNote(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send your message to the provider.'); }
    finally { setSendingNote(false); }
  }

  async function sendChat(text: string) {
    const current = dashboard?.activeSession;
    if (!current) return;
    setError('');
    try { await api(`/sessions/${current.id}/message`, { eventId: crypto.randomUUID(), text }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send your reply.'); }
  }
  async function handoffAction(path: string, body: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    try { await api(path, body); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not update the handoff.'); }
    finally { setBusy(false); }
  }
  async function acceptHandoff(id: string, patientId: string) {
    setSelected(patientId); setTab('conversation');
    await handoffAction(`/handoffs/${id}/accept`, { nurse });
  }
  async function joinHandoff(id: string) {
    if (media.current) return;
    setBusy(true); setError(''); setHandoffPeers(0); setHandoffMuted(false);
    const call = joinHandoffAudio(id, joinRole, nurse, {
      status: setHandoffStatus,
      error: setError,
      peers: setHandoffPeers,
      stopped: () => { if (media.current === call) media.current = null; setJoinedHandoff(''); setHandoffPeers(0); setAudioBlocked(false); void refresh(); },
    });
    media.current = call;
    setJoinedHandoff(id);
    try { await call.ready; setAudioBlocked(call.audioBlocked()); await refresh(); }
    finally { setBusy(false); }
  }
  async function leaveHandoff(id: string) {
    setBusy(true);
    try { if (media.current) await media.current.stop('ended'); else await handoffAction(`/handoffs/${id}/end`, {}); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not end the handoff.'); }
    finally { setBusy(false); }
  }
  function select(p: Patient) { setSelected(p.id); setTab(dashboard?.activeSession?.patientId === p.id ? 'conversation' : 'overview'); }
  const patients = dashboard?.patients.filter(p => cohort || p.featured) || [];
  const needsReview = patients.filter(p => ['emergency', 'red', 'yellow'].includes(p.severity) && p.disposition !== 'resolved');
  const resolved = patients.filter(p => p.disposition === 'resolved').length;
  const filtered = patients.filter(p => (filter === 'all' || (filter === 'review' && needsReview.includes(p)) || (filter === 'resolved' && p.disposition === 'resolved')) && `${p.name} ${p.language} ${p.quote}`.toLowerCase().includes(search.toLowerCase()));
  const p = detail?.patient;
  const active = dashboard?.activeSession;
  const thisActive = active?.patientId === selected ? active : null;
  const handoff = dashboard?.handoff ?? null;
  const outreach: Outreach[] = dashboard?.outreach ?? [];
  const ringing = outreach.find(o => o.ringingSince) ?? null;
  const patientHandoff = handoff?.patientId === selected ? handoff : null;
  const handoffLive = Boolean(handoff && ['requested', 'accepted', 'connecting', 'active'].includes(handoff.state));
  const latest = detail?.sessions[0];
  const elapsed = thisActive ? Math.max(0, Math.floor((clock - Date.parse(thisActive.startedAt)) / 1000)) : 0;
  const shownTurns = detail?.turns.filter(t => t.sessionId === latest?.id) || [];

  return <div className="app-shell">
    <a className="skip-link" href="#worklist">Skip to patient worklist</a>
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Aftercare home"><span className="brand-icon"><HeartHandshake size={23} strokeWidth={1.8} /></span><span>aftercare<span className="brand-period">.</span></span></a>
      <div className="workspace-label"><span className="hospital-icon"><Plus size={14} /></span> Recovery care team<ChevronDown size={13} /></div>
      <div className="nav-heading">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={`nav-item ${!modal ? 'selected' : ''}`} onClick={() => { setModal(null); document.getElementById('worklist')?.scrollIntoView({ behavior: 'smooth' }); }}><LayoutList size={18} />Patient worklist<span className="nav-count">{dashboard?.patients.length || 40}</span></button>
        <button className="nav-item" onClick={() => { setHistoryRun(''); setModal('history'); }}><History size={18} />Demo history</button>
        <button className="nav-item" onClick={() => setModal('protocol')}><ClipboardList size={18} />Care protocol</button>
      </nav>
      <div className="sidebar-note"><span className="small-kicker"><span className="tiny-dot" /> THE FIRST 30 DAYS</span><HeartHandshake size={31} strokeWidth={1.25} /><h3>Recovery continues<br />beyond the hospital.</h3><p>A timely conversation can help bring the right person into the loop.</p><button onClick={() => setModal('guide')}>Explore the demo <ArrowRight size={14} /></button></div>
      <div className="sidebar-bottom"><div className="sandbox-label"><ShieldCheck size={15} />Synthetic patients only</div><div className="user"><div className="user-avatar">DN</div><div><strong>Demo nurse</strong><span>Local workspace</span></div><span className="user-dot" /></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Care coordination<ChevronRight size={13} /><span>Patient worklist</span></div><div className="top-actions"><span className={`connection ${connected ? '' : 'offline'}`}><span className="tiny-dot" />{connected ? 'Live updates' : 'Reconnecting'}</span><span className="top-divider" /><button className="icon-button" aria-label="Open demo guide" onClick={() => setModal('guide')}><CircleHelp size={19} /></button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">A BETTER TRANSITION HOME</div><h1>Follow-up worklist</h1><p>A clearer picture of recovery, one conversation at a time.</p></div><button className="button secondary reset-button" onClick={() => setModal('reset')} disabled={Boolean(active)}><RotateCcw size={15} />New demo<span className="demo-number">{dashboard?.runNumber || 1}</span></button></div>
        {handoff && joinRole !== 'patient' && handoff.state === 'requested' && <HandoffRinging handoff={handoff} patientName={dashboard?.patients.find(x => x.id === handoff.patientId)?.name || 'A patient'} nurse={nurse} busy={busy} onAccept={() => void acceptHandoff(handoff.id, handoff.patientId)} onDecline={() => void handoffAction(`/handoffs/${handoff.id}/decline`, { nurse })} />}
        {handoff && joinRole !== 'patient' && ['accepted', 'connecting', 'active'].includes(handoff.state) && <HandoffStatus handoff={handoff} joined={joinedHandoff === handoff.id} busy={busy} audioStatus={handoffStatus} peers={handoffPeers} muted={handoffMuted} audioBlocked={audioBlocked} onResumeAudio={() => void media.current?.resumeAudio().then(ok => setAudioBlocked(!ok))} onJoin={() => void joinHandoff(handoff.id)} onMute={() => { const next = !handoffMuted; setHandoffMuted(next); void media.current?.setMuted(next); }} onEnd={() => void leaveHandoff(handoff.id)} />}
        {error && <div className="error-banner" role="alert"><TriangleAlert size={17} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {outreach.length > 0 && <section className="outreach-card" aria-label="Scheduled outreach">
          <div className="card-title"><h3><Send size={15} />Day 3 outreach</h3><span className="small muted">{outreach.length} sent by the service</span></div>
          {outreach.map(o => {
            const who = dashboard?.patients.find(x => x.id === o.patientId);
            return <div className="outreach-row" key={o.token}>
              <div><strong>{who?.name || o.patientId}</strong><span>{outreachLabels[o.state]}</span></div>
              <code>{`${window.location.origin}/c/${o.token}`}</code>
              <button className="button secondary" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/c/${o.token}`); setToast('Patient link copied.'); }}>Copy link</button>
            </div>;
          })}
          <p className="small muted">The service generates and sends these on day 3. No SMS or email provider is configured, so the link is shown here instead of delivered.</p>
        </section>}
        <section className="stats" aria-label="Demo overview">
          <Stat label="Patients in view" value={patients.length} description="Post-surgical recovery" icon={<Users size={18} />} />
          <Stat label="Need attention" value={needsReview.length} description="Flagged for nurse review" icon={<TriangleAlert size={18} />} accent="amber" />
          <Stat label="Outreach documented" value={patients.filter(p => p.lastContact).length} description="Includes illustrative seed records" icon={<CheckCheck size={18} />} accent="green" />
          <Stat label="Awaiting assessment" value={patients.filter(p => p.severity === 'unassessed').length} description="Ready for a conversation" icon={<Clock3 size={18} />} />
        </section>
        <div className="section-heading"><div><span className="section-dot" /><h2>Your patients</h2><span className="section-count">{patients.length}</span></div><div className="cohort-switch" role="group" aria-label="Patient cohort"><button className={!cohort ? 'active' : ''} onClick={() => setCohort(false)}>Featured <span>3</span></button><button className={cohort ? 'active' : ''} onClick={() => setCohort(true)}>Full cohort <span>40</span></button></div></div>
        <div className="workspace-grid">
          <div className="worklist-column">
            <section className="worklist-card" id="worklist" aria-label="Patient worklist">
              <div className="list-toolbar"><div className="filter-tabs" role="group" aria-label="Filter patients"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All patients <span>{patients.length}</span></button><button className={filter === 'review' ? 'active' : ''} onClick={() => setFilter('review')}>Needs review <span>{needsReview.length}</span></button><button className={filter === 'resolved' ? 'active' : ''} onClick={() => setFilter('resolved')}>Resolved <span>{resolved}</span></button></div></div>
              <div className="search-row"><label className="search"><Search size={16} /><input placeholder="Search patients or reported concerns" aria-label="Search patients" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</label><span className="sort-label"><SlidersHorizontal size={14} />Priority first</span></div>
              <div className="table-labels"><span>PATIENT</span><span>FOLLOW-UP</span><span>PRIORITY</span></div>
              <div className="patient-list">
                {!dashboard && <div className="empty-state"><LoaderCircle className="spin" />Loading your worklist…</div>}
                {filtered.map(patient => <button key={patient.id} data-testid={`patient-${patient.id}`} className={`patient-row ${selected === patient.id ? 'is-selected' : ''}`} onClick={() => select(patient)} aria-pressed={selected === patient.id}>
                  <div className="patient-identity"><Avatar patient={patient} /><div><strong>{patient.name}</strong><span>{patient.age} years <i /> Day {ageDays(patient.dischargeDate)} after discharge</span>{awaitingNurse.has(patient.id) && <span className="replied-chip"><Stethoscope size={11} />Provider replied</span>}</div></div>
                  <div className="follow-up-cell"><span className="language-chip">{patient.language === 'en' ? 'EN' : 'ES'}</span><span className={active?.patientId === patient.id ? 'in-progress' : ''}>{active?.patientId === patient.id ? 'In progress' : patient.lastContact ? time(patient.lastContact) : 'Check-in due'}</span></div>
                  <div className="priority-cell"><Badge patient={patient} /><ChevronRight size={15} /></div>
                  <div className="row-context">{patient.quote ? <><MessageSquare size={12} /><span>“{patient.quote}”</span></> : <><Clock3 size={12} /><span>Day 3 symptom check · ready to connect</span></>}{(patient.quoteSource ?? patient.mode) === 'seed' && <em>Sample record</em>}</div>
                </button>)}
                {dashboard && filtered.length === 0 && <div className="empty-state"><Search size={25} /><strong>No patients in this view</strong><p>Try another name or change the filter.</p><button className="text-button" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</button></div>}
              </div>
              <div className="list-footer"><span><ShieldCheck size={13} />All records are synthetic</span><span>{filtered.length} of {patients.length} patients</span></div>
            </section>
            <section className="insight-card"><span className="insight-icon"><HeartHandshake size={22} /></span><div><h3>More time for the people who need it.</h3><p>Structured check-ins surface concerns. Your care team makes the decisions.</p></div><ArrowDownLeft size={22} /></section>
            <section className="activity-card"><div className="card-title"><h3>Recent activity</h3><button onClick={() => setModal('history')}>View history <ArrowRight size={14} /></button></div>{dashboard?.recent.slice(0, 3).map(event => <div className="activity-row" key={event.id}><span className={`activity-icon ${event.kind === 'flag' ? 'flag' : ''}`}>{event.kind === 'flag' ? <TriangleAlert size={14} /> : event.actor === 'Demo nurse' ? <Stethoscope size={14} /> : <Check size={14} />}</span><div><p>{event.text}</p><span>{event.actor}{event.mode ? ` · ${event.mode === 'seed' ? 'Sample record' : event.mode === 'voice' ? 'In-app call' : 'Simulation'}` : ''}</span></div><time>{time(event.createdAt)}</time></div>)}</section>
            <p className="documentation-note"><FileText size={13} />Outreach documentation supports nurse review. It does not establish TCM billing eligibility.</p>
          </div>
          <aside className="detail-panel" ref={panelRef} aria-label="Patient details">
            {p ? <>
              <div className="detail-header"><div className="small-kicker">PATIENT DETAILS <span className="synthetic-pill">SYNTHETIC</span></div><div className="detail-person"><Avatar patient={p} large /><div><h2>{p.name}</h2><p>{p.age} years · {p.language === 'es' ? 'Spanish' : 'English'} preferred</p></div></div><div className="detail-status"><Badge patient={p} /><span>{p.disposition === 'open' ? 'Open case' : p.disposition}</span></div></div>
              {thread.length > 0 && <section className="case-thread" aria-label="Conversation with the provider">
                <span className="small-kicker"><Stethoscope size={13} /> PROVIDER CONVERSATION{thread.at(-1)?.role === 'provider' ? ' · AWAITING YOU' : ' · AWAITING THE PROVIDER'}</span>
                <div className="case-messages">
                  {thread.map(message => <div className={`case-message ${message.role}`} key={message.id}>
                    <span className="case-author">{message.author}<time>{time(message.at)} · {date(message.at)}</time></span>
                    <p>{message.text}</p>
                  </div>)}
                  <div ref={threadEnd} />
                </div>
                <form className="case-composer" onSubmit={sendCaseNote}>
                  <label className="sr-only" htmlFor="case-note">Message the provider</label>
                  <textarea id="case-note" rows={2} maxLength={2000} value={caseNote} placeholder="Reply to the provider…"
                    onChange={e => setCaseNote(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendCaseNote(e); } }} />
                  <button className="button secondary" disabled={sendingNote || !caseNote.trim()}><Send size={14} />{sendingNote ? 'Sending…' : 'Send'}</button>
                </form>
                <span className="small muted">Neither side's message changes the disposition. The case stays open until you resolve it.</span>
              </section>}
              <div className="detail-tabs" role="tablist" aria-label="Patient information">{(['overview', 'conversation', 'briefing', 'audit'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={tab === t ? 'active' : ''}>{t === 'audit' ? 'Audit trail' : t[0].toUpperCase() + t.slice(1)}{t === 'conversation' && thisActive && <span className="tiny-dot" />}</button>)}</div>
              <div className="detail-content">
                {tab === 'overview' && <>
                  {p.quote && <div className={`concern-card ${p.severity}`}><span className="small-kicker">{p.severity === 'green' ? 'DOCUMENTED RESPONSE' : 'WHAT THE PATIENT SAID'}</span><blockquote>“{p.quote}”</blockquote>{(p.quoteSource ?? p.mode) === 'seed' && <span className="muted small">Illustrative seed record</span>}<div className="recommended"><span>RECOMMENDED ACTION</span><p>{p.action}</p></div></div>}
                  {!p.quote && <div className="ready-card"><span className="ready-icon"><AudioLines size={24} /></span><h3>A conversation starts here.</h3><p>Check in on {p.name.split(' ')[0]}’s recovery and bring any concerns to the care team.</p><button className="button primary" onClick={() => setTab('conversation')}><Play size={15} />Start a check-in<ArrowRight size={15} /></button></div>}
                  <div className="detail-section"><h4>Recovery at a glance</h4><Info icon={<Plus size={15} />} label="Procedure" value={p.procedure} /><Info icon={<CalendarDays size={15} />} label="Discharged" value={`${date(p.dischargeDate)} · ${ageDays(p.dischargeDate)} days ago`} /><Info icon={<Stethoscope size={15} />} label="Care team" value={p.surgeon} /><Info icon={<Users size={15} />} label="Support at home" value={p.caregiver} /></div>
                  <div className="appointment-card"><CalendarDays size={20} /><div><span>Next follow-up</span><strong>{date(p.appointment, { weekday: 'long', month: 'short', day: 'numeric' })}</strong><small>Orthopedic follow-up · demo appointment</small></div></div>
                  <details className="medications"><summary>Mock discharge record<ChevronDown size={14} /></summary><p>Procedure: {p.procedure}. Discharged home. Medication details are intentionally synthetic; medication questions always go to the nurse.</p>{p.medications.map(m => <p key={m}>• {m}</p>)}</details>
                  {p.featured && p.quote && <button className="button secondary full-width" onClick={() => setTab('conversation')}><AudioLines size={16} />Open check-in studio<ArrowRight size={15} /></button>}
                </>}
                {tab === 'conversation' && <>
                  {p.featured ? <div className="call-studio"><div className="studio-title"><span className="small-kicker">CHECK-IN STUDIO</span><span className="small muted">Day 3 protocol</span></div><div className="mode-switch" role="group" aria-label="Conversation mode"><button className={mode === 'simulation' ? 'active' : ''} onClick={() => setMode('simulation')} disabled={Boolean(active)}><Play size={14} />Simulation</button><button className={mode === 'voice' ? 'active' : ''} onClick={() => setMode('voice')} disabled={Boolean(active)}><Mic size={14} />In-app call</button><button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')} disabled={Boolean(active)}><MessageSquare size={14} />Text chat</button></div>
                    <div className="ring-patient">
                      <div>
                        <strong><PhoneOutgoing size={15} />Call {p.name.split(' ')[0]} for their check-in</strong>
                        <span>Rings their own device. They talk to the follow-up agent, not to you. Use the modes below to run a check-in on this machine instead.</span>
                      </div>
                      <button className="button primary" disabled={busy || Boolean(active) || ringing?.patientId === p.id} onClick={() => void handoffAction(`/patients/${p.id}/ring`)}>
                        <PhoneOutgoing size={15} />{ringing?.patientId === p.id ? 'Ringing\u2026' : 'Call patient'}
                      </button>
                    </div>
                    {ringing?.patientId === p.id && <p className="small muted">Their page is ringing. When they answer, the check-in starts there and the transcript appears below.</p>}
                    <p className="mode-description">{mode === 'simulation' ? 'Hear the follow-up agent. Patient replies are text placeholders. No microphone or credits needed.' : mode === 'chat' ? (capability?.chat ? `Type as the patient. The agent can rephrase a question you answer unclearly, using ${capability.model}.` : capability?.chatReason || 'Checking chat availability…') : capability?.voice ? 'Talk to the AI over the internet. You speak as the patient; the agent answers aloud.' : capability?.voiceReason || 'Checking call availability…'}</p>
                    {mode !== 'voice' && <div className="simulation-audio"><button type="button" className="button" aria-pressed={!muted} aria-label={mode === 'chat' ? 'Read questions aloud' : 'Simulation audio'} disabled={mode === 'simulation' && Boolean(thisActive) && !simulation.current} onClick={() => { const next = !muted; setMuted(next); simulation.current?.setMuted(next); narrator.current?.setMuted(next); }}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}{muted ? 'Audio off' : 'Audio on'}</button><span className="small muted">{muted ? 'Text only' : mode === 'chat' ? 'Questions read aloud · device voices' : 'English / Español · device voices'}</span></div>}
                    {mode === 'simulation' && audioWarning && <p className="audio-warning" role="status">{audioWarning}</p>}
                    <div className="form-row"><label>Language<select aria-label="Conversation language" value={language} onChange={e => setLanguage(e.target.value as Language)} disabled={Boolean(active)}><option value="en">English</option><option value="es">Español</option></select></label>{mode === 'simulation' && <label>Scenario<select aria-label="Simulation scenario" value={scenario} onChange={e => setScenario(e.target.value as ScenarioId)} disabled={Boolean(active)}>{Object.entries(scenarioLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>}</div>
                    {mode === 'chat' ? <ChatPanel patient={p.name} language={language} session={thisActive ?? null} busy={busy} disabled={Boolean(active) || !capability?.chat} reason={capability?.chatReason || ''} model={capability?.model || 'gemini'} onStart={() => void start()} onSend={sendChat} onEnd={() => void end()} /> : mode === 'voice' ? <InAppCall patient={p.name} language={language} active={Boolean(thisActive)} busy={busy} disabled={Boolean(active) || !capability?.voice} status={voiceStatus} elapsed={elapsed} muted={callMuted} volume={callVolume} level={callLevel} onStart={() => void start()} onEnd={() => void end()} onMute={() => { try { const next = !callMuted; voice.current?.setMuted(next); setCallMuted(next); } catch { setError('Could not change microphone state. End the call and try again.'); } }} onVolume={value => { setCallVolume(value); voice.current?.setVolume(value); }} /> : thisActive ? <div className="running-session"><div className="session-meter" aria-hidden="true">{[9, 17, 26, 15, 31, 21, 12, 26, 18, 8, 22, 31, 15, 24, 10].map((height, i) => <i key={i} style={{ height, animationDelay: `${i * .11}s` }} />)}</div><div className="session-meta"><span><span className="tiny-dot" />{thisActive.mode === 'simulation' ? (simulation.current ? simulationStatus : 'Simulation running · audio off') : voiceStatus}</span><time>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} / 5:00</time></div><button className="button end-button" onClick={() => void end()}><Square size={13} />End check-in</button></div> : <button className="button primary full-width" disabled={busy || Boolean(active) || false} onClick={() => void start()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />} {busy ? 'Starting…' : 'Start simulation'}</button>}
                    {active && !thisActive && <p className="small muted">Another patient’s check-in is running.</p>}
                    {mode === 'chat' && !capability?.chat && <p className="setup-note"><FileText size={13} />Add GEMINI_API_KEY to .env, then restart the server.</p>}
                    {mode === 'voice' && !capability?.voice && <p className="setup-note"><FileText size={13} />Setup instructions are in the project README.</p>}
                  </div> : <div className="empty-state compact"><Users size={25} /><p>Cohort records illustrate the worklist. Select a featured patient to try a conversation.</p></div>}
                  {patientHandoff && ['ended', 'declined', 'timed_out', 'failed'].includes(patientHandoff.state) && <HandoffStatus handoff={patientHandoff} joined={false} busy={busy} audioStatus="" peers={0} muted={false} audioBlocked={false} onResumeAudio={() => {}} onJoin={() => {}} onMute={() => {}} onEnd={() => {}} />}
                  <details className="live-transcript" open><summary>Live transcript &amp; call outcome</summary><div className="transcript-heading"><h4>Conversation</h4><span className={`source-tag ${latest?.mode || ''}`}>{latest ? latest.mode === 'voice' ? 'IN-APP CALL' : latest.mode === 'chat' ? 'TEXT CHAT' : 'SIMULATION' : 'NO CHECK-IN YET'}</span></div>
                  {latest && !activeStatus(latest) && <div className={`session-result ${latest.status === 'emergency' ? 'is-emergency' : ''}`}><CheckCircle2 size={15} />{latest.status === 'completed' ? 'Outreach documented · awaiting nurse review' : latest.status === 'emergency' ? 'Emergency flagged · nurse follow-up open' : latest.status === 'callback' ? 'Human callback requested' : latest.status === 'failed' ? 'Connection failed · intake incomplete' : 'Intake incomplete · nurse review required'}</div>}
                  <div className="transcript" aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions">{shownTurns.length ? shownTurns.map(turn => <div className={`transcript-turn ${turn.role}`} key={turn.id}><div><span>{turn.role === 'agent' ? 'AFTERCARE' : p.name.split(' ')[0].toUpperCase()}</span><time>{time(turn.createdAt)}</time></div><p lang={turn.language}>{turn.text}</p></div>) : <div className="transcript-empty"><MessageSquare size={26} strokeWidth={1.4} /><p>The conversation will appear here.</p><span>Original words. Clear next steps.</span></div>}<div ref={transcriptEnd} /></div></details>
                  {detail.sessions.length > 1 && <details className="past-sessions"><summary>{detail.sessions.length - 1} earlier check-in(s) in this demo</summary>{detail.sessions.slice(1).map(s => <div key={s.id}><strong>{s.mode === 'voice' ? 'In-app call' : 'Simulation'} · {s.status}</strong><small>{time(s.startedAt)}</small>{detail.turns.filter(t => t.sessionId === s.id).map(t => <p key={t.id}><b>{t.role === 'user' ? 'Patient' : 'Aftercare'}:</b> {t.text}</p>)}</div>)}</details>}
                </>}
                {tab === 'briefing' && <Briefing patientId={p.id} patientName={p.name} available={Boolean(capability?.chat)} reason={capability?.chatReason || 'Checking briefing availability…'} />}
                {tab === 'audit' && <div className="audit-list"><p className="audit-intro">Every concern and nurse action has a place in the record.</p>{detail.audit.map(event => <div className="audit-item" key={event.id}><span className={`audit-dot ${event.kind === 'flag' ? 'flag' : ''}`} /><div><strong>{event.actor}</strong><time>{time(event.createdAt)} · {date(event.createdAt)}</time><p>{event.text}</p>{event.mode && <span className="source-tag">{event.mode === 'seed' ? 'SAMPLE RECORD' : event.mode.toUpperCase()}</span>}</div></div>)}</div>}
              </div>
              <div className="nurse-actions"><div className="small-kicker"><Stethoscope size={13} /> NURSE ACTIONS</div><div><button className="button secondary" disabled={busy || p.disposition === 'resolved' || p.disposition === 'acknowledged'} onClick={() => void action('acknowledge')}><Check size={14} />{p.disposition === 'acknowledged' ? 'Acknowledged' : 'Acknowledge'}</button><button className="button secondary" disabled={busy || p.disposition === 'resolved'} onClick={() => { setNote(''); setModal('resolve'); }}><CheckCheck size={14} />Resolve</button></div><div className="sub-actions">{p.featured && !outreach.some(o => o.patientId === selected) && <button onClick={() => void handoffAction(`/patients/${selected}/outreach`)}><Send size={13} />Send check-in invitation</button>}{capability?.handoff && !handoffLive && <button onClick={() => void handoffAction(`/patients/${selected}/handoff`, { reason: 'The nurse asked for a live conversation with this patient.' })} disabled={busy}><PhoneCall size={13} />Start live handoff</button>}<button onClick={() => void action('callback')} disabled={busy}><PhoneCall size={13} />Request callback</button><button className="escalate-button" onClick={() => { setNote(''); setModal('escalate'); }} disabled={busy}>Escalate<ArrowRight size={13} /></button></div></div>
            </> : <div className="empty-state"><LoaderCircle className="spin" />Loading patient details…</div>}
          </aside>
        </div>
        <footer className="page-footer"><span>Designed for the days between discharge and recovery.</span><span><span className="tiny-dot" /> Demo workspace · {date(new Date().toISOString(), { month: 'long', day: 'numeric', year: 'numeric' })}</span></footer>
      </main>
    </div>
    {toast && <div className="toast" role="status"><CheckCircle2 size={17} />{toast}</div>}
    {modal && <dialog ref={modalRef} className={`modal ${modal === 'history' ? 'wide' : ''}`} onCancel={() => setModal(null)} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="modal-heading"><span className="small-kicker">AFTERCARE · DEMO WORKSPACE</span><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={19} /></button></div>
      {(modal === 'resolve' || modal === 'escalate') && <form onSubmit={e => { e.preventDefault(); void action(modal, note); }}><h2>{modal === 'resolve' ? 'Resolve this case' : 'Escalate this case'}</h2><p>{modal === 'resolve' ? <>Record your follow-up for {p?.name}. This action will be attributed to the demo nurse.</> : <>Tell the provider why, in your own words. An automated summary of {p?.name}&rsquo;s check-in is attached either way, so you can leave this blank and send that alone.</>}</p><label className="note-label">{modal === 'resolve' ? 'Nurse note' : 'Nurse note (optional)'}<textarea autoFocus required={modal === 'resolve'} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder={modal === 'resolve' ? 'What was reviewed, and what happens next?' : 'What do you want the provider to decide? Leave blank to send the summary only.'} /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary" disabled={busy || (modal === 'resolve' && !note.trim())}>{modal === 'resolve' ? 'Save and resolve' : busy ? 'Preparing summary\u2026' : 'Save escalation'}</button></div></form>}
      {modal === 'reset' && <><h2>A fresh start for the next demo.</h2><p>Both restore the forty synthetic patients. Previous conversations and nurse actions stay in Demo history.</p>
        <div className="reset-choices">
          <button className="reset-choice" disabled={busy || Boolean(active)} onClick={() => void reset(false)}>
            <span className="landing-icon"><Sparkles size={18} /></span>
            <div><strong>Clean run</strong><span>Nobody is assessed yet. Every flag on the worklist comes from this demo, so a live check-in is impossible to miss. Best for presenting.</span></div>
          </button>
          <button className="reset-choice" disabled={busy || Boolean(active)} onClick={() => void reset(true)}>
            <span className="landing-icon"><LayoutList size={18} /></span>
            <div><strong>With sample records</strong><span>Pre-filled worklist with existing concerns and documented outreach. Best for showing a populated dashboard.</span></div>
          </button>
        </div>
        <div className="modal-actions"><button className="button secondary" onClick={() => setModal(null)}>Keep this demo</button></div></>}
      {modal === 'guide' && <><h2>One conversation.<br />A clearer next step.</h2><p>This demo follows a synthetic patient three days after knee replacement. Simulation is ready without any accounts or credits.</p><ol className="guide-steps"><li><span>01</span><div><strong>Choose Miguel Alvarez</strong><p>Open Conversation, choose a language, and select Wound concern.</p></div></li><li><span>02</span><div><strong>Start the simulation</strong><p>Watch the original patient response appear and the worklist flag the concern.</p></div></li><li><span>03</span><div><strong>Try an emergency or a barrier</strong><p>Run another scenario, then acknowledge, escalate, or resolve with a nurse note.</p></div></li></ol><div className="guide-note"><Mic size={18} /><p>In-app call uses your ElevenLabs allowance. Add the API key and run the setup command in the README. Twilio is not used.</p></div><button className="button primary" onClick={() => { setSelected('alvarez'); setTab('conversation'); setModal(null); }}>Try a check-in<ArrowRight size={15} /></button></>}
      {modal === 'protocol' && <><h2>A focused day 3 check-in.</h2><p>Demonstration rules for synthetic knee-replacement patients. These rules have not been clinically validated.</p><div className="protocol-list">{[['01', 'Consent & identity', 'Automated demo, transcription disclosure, and permission to continue.'], ['02', 'Recovery questions', 'Incision, fever, medications, falls, nutrition, and appointment transport.'], ['03', 'Route the concern', 'Emergency → 911 instruction and alert. Red → urgent review. Yellow → review today. Unclear → nurse review.'], ['04', 'Keep a person in control', 'No diagnosis, treatment advice, or medication changes. Only the nurse resolves a case.']].map(([n, title, text]) => <div key={n}><span>{n}</span><div><strong>{title}</strong><p>{text}</p></div></div>)}</div><p className="small muted">A five-minute session cap applies. In-app call cannot transfer calls. Emergency detection follows speech recognition and is not guaranteed. TCM eligibility requires clinical-staff contact and additional services.</p><a className="text-button" href="/scenario-cards.html" target="_blank" rel="noreferrer">Open printable scenario cards<ArrowRight size={14} /></a></>}
      {modal === 'history' && <><h2>Demo history</h2><p>Earlier demo sessions remain available after a reset.</p><label className="history-select">Demo session<select value={historyRun || dashboard?.runId || ''} onChange={e => setHistoryRun(e.target.value)}>{history?.runs.map(run => <option key={run.id} value={run.id}>Demo {run.number} · {date(run.createdAt)} {time(run.createdAt)} · {run.conversations} conversations</option>)}</select></label><div className="history-events">{history?.events.map(event => <div className="history-event" key={event.id}><time>{time(event.createdAt)}</time><div><strong>{event.actor}{event.patientId ? ` · ${event.patientId}` : ''}</strong><p>{event.text}</p></div><span className="source-tag">{event.mode || 'NURSE'}</span></div>)}</div></>}
    </dialog>}
  </div>;
}
function Stat({ label, value, description, icon, accent = '' }: { label: string; value: number; description: string; icon: React.ReactNode; accent?: string }) { return <article className={`stat-card ${accent}`}><div><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value.toString().padStart(2, '0')}</strong><p>{description}</p></article>; }
function Info({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="info-row"><span>{icon}</span><div><span>{label}</span><strong>{value}</strong></div></div>; }
