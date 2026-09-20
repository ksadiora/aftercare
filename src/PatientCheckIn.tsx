import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, HeartHandshake, LoaderCircle, MessageSquare, Mic, MicOff, Phone, PhoneIncoming, PhoneOff, Pill, Plus, Send, ShieldCheck, Stethoscope, TriangleAlert, Users, Volume2, VolumeX } from 'lucide-react';
import type { Handoff, Language, Session, Turn } from '../shared/types';
import { api } from './api';
import { InAppCall } from './InAppCall';
import { createInAppCall } from './voice';
import { joinHandoffAudio } from './handoff-media';
import { createRingtone } from './ringtone';
import { createNarrator, type Narrator } from './speech';

interface Invite {
  outreach: { state: string; createdAt: string; ringingSince: string | null };
  patient: {
    id: string; name: string; initials: string; avatar: string; language: Language; age: number;
    procedure: string; dischargeDate: string; appointment: string; surgeon: string;
    caregiver: string; medications: string[];
  };
  can: { voice: boolean; chat: boolean; voiceReason: string; chatReason: string };
  handoff: Handoff | null;
  session: Session | null;
  turns: Turn[];
}

const day = (value: string, options?: Intl.DateTimeFormatOptions) => new Date(value).toLocaleDateString('en-US', options || { month: 'short', day: 'numeric' });
const daysSince = (value: string) => Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000));

const copy = {
  en: {
    greeting: (first: string) => `Hello, ${first}`,
    intro: 'Your recovery team sent you this check-in. It takes a couple of minutes.',
    yourCare: 'Your care',
    procedure: 'Procedure', discharged: 'Discharged', appointment: 'Next appointment',
    team: 'Care team', support: 'Support at home', meds: 'Your discharge medicines',
    how: 'How would you like to do this?',
    call: 'Talk out loud', callHint: 'Speak with the follow-up assistant using your microphone.',
    chat: 'Type instead', chatHint: 'Answer in writing. No microphone needed.',
    conversation: 'Your check-in', you: 'You',
    ringing: 'Your care team is calling', ringHint: 'A nurse would like to speak with you now.',
    checkInRinging: 'Time for your check-in', checkInHint: 'Your recovery team is calling to go through a few questions. You will speak with the automated follow-up assistant.',
    answerCheckIn: 'Answer', declineCheckIn: 'Not now',
    answer: 'Answer', hangUp: 'Hang up', onCall: 'You are speaking with the care team',
    nurseWaiting: 'Connecting \u2014 waiting for the nurse', mute: 'Mute', unmute: 'Unmute',
    reply: 'Your reply', placeholder: 'Type your answer…', send: 'Send',
    readAloud: 'Read the questions aloud', readAloudOff: 'Questions are shown, not spoken',
    done: 'Thank you. Your answers are saved for the nurse to review.',
    footer: 'Synthetic demonstration data. This is not medical care. In an emergency, call 911.',
  },
  es: {
    greeting: (first: string) => `Hola, ${first}`,
    intro: 'Su equipo de recuperación le envió esta consulta. Toma unos minutos.',
    yourCare: 'Su atención',
    procedure: 'Procedimiento', discharged: 'Alta', appointment: 'Próxima cita',
    team: 'Equipo médico', support: 'Apoyo en casa', meds: 'Sus medicamentos del alta',
    how: '¿Cómo prefiere responder?',
    call: 'Hablar en voz alta', callHint: 'Hable con el asistente usando su micrófono.',
    chat: 'Escribir', chatHint: 'Responda por escrito. No necesita micrófono.',
    conversation: 'Su consulta', you: 'Usted',
    ringing: 'Su equipo de atenci\u00f3n le est\u00e1 llamando', ringHint: 'Una enfermera quiere hablar con usted ahora.',
    checkInRinging: 'Es hora de su consulta', checkInHint: 'Su equipo de recuperaci\u00f3n le llama para hacerle unas preguntas. Hablar\u00e1 con el asistente autom\u00e1tico de seguimiento.',
    answerCheckIn: 'Contestar', declineCheckIn: 'Ahora no',
    answer: 'Contestar', hangUp: 'Colgar', onCall: 'Est\u00e1 hablando con el equipo de atenci\u00f3n',
    nurseWaiting: 'Conectando \u2014 esperando a la enfermera', mute: 'Silenciar', unmute: 'Activar micr\u00f3fono',
    reply: 'Su respuesta', placeholder: 'Escriba su respuesta…', send: 'Enviar',
    readAloud: 'Leer las preguntas en voz alta', readAloudOff: 'Las preguntas se muestran, no se leen',
    done: 'Gracias. Sus respuestas están guardadas para que las revise la enfermera.',
    footer: 'Demostración con datos sintéticos. Esto no es atención médica. En una emergencia, llame al 911.',
  },
};

export function PatientCheckIn({ token }: { token: string }) {
  const [invite, setInvite] = useState<Invite>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'voice' | 'chat'>('voice');
  const [callStatus, setCallStatus] = useState('Ready');
  const [callMuted, setCallMuted] = useState(false);
  const [callVolume, setCallVolume] = useState(1);
  const [callLevel, setCallLevel] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const call = useRef<ReturnType<typeof createInAppCall> | null>(null);
  const nurseCall = useRef<ReturnType<typeof joinHandoffAudio> | null>(null);
  const [onNurseCall, setOnNurseCall] = useState(false);
  const [nurseStatus, setNurseStatus] = useState('');
  const [nursePeers, setNursePeers] = useState(0);
  const [nurseMuted, setNurseMuted] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const ringtone = useRef<ReturnType<typeof createRingtone> | null>(null);
  const narrator = useRef<Narrator | null>(null);
  const spokenTurn = useRef<string | null>(null);
  const [readAloud, setReadAloud] = useState(true);

  const load = useCallback(async (quiet = false) => {
    try { setInvite(await api<Invite>(`/outreach/${token}`)); }
    catch (e) { if (!quiet) setError(e instanceof Error ? e.message : 'This check-in link could not be opened.'); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [invite?.turns.length]);
  useEffect(() => {
    // The server marks a silent browser as an incomplete intake, so keep reporting in.
    const session = invite?.session;
    if (!session || !['active', 'connecting'].includes(session.status)) return;
    const beat = () => void api(`/outreach/${token}/heartbeat`, {}).catch(() => undefined);
    const timer = setInterval(beat, 5000); beat();
    return () => clearInterval(timer);
  }, [invite?.session?.id, invite?.session?.status, token]);
  useEffect(() => () => { void call.current?.stop(); void nurseCall.current?.stop('failed'); }, []);
  useEffect(() => { if (invite && !invite.can.voice) setMode('chat'); }, [invite?.can.voice]);
  useEffect(() => {
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    // Ring until they are actually on the call, not merely until a nurse accepts.
    const checkInCall = Boolean(invite?.outreach.ringingSince) && !invite?.session;
    const waiting = checkInCall || (['requested', 'accepted', 'connecting'].includes(invite?.handoff?.state ?? '') && !onNurseCall);
    if (waiting) {
      ringtone.current ??= createRingtone(copy[invite?.patient.language ?? 'en'][checkInCall ? 'checkInRinging' : 'ringing']);
      void ringtone.current.start();
    } else {
      ringtone.current?.stop(); ringtone.current = null;
    }
  }, [invite?.handoff?.state, invite?.outreach.ringingSince, invite?.session, invite?.patient.language, onNurseCall]);
  useEffect(() => () => { ringtone.current?.stop(); }, []);
  // Someone who chose to type may still need to hear the question: they may be
  // older, tired, or holding the phone at arm's length. Only the agent is spoken.
  useEffect(() => {
    if (invite?.session?.mode !== 'chat') { spokenTurn.current = null; return; }
    const last = invite.turns.filter(turn => turn.role === 'agent').at(-1);
    if (!last || last.id === spokenTurn.current) return;
    spokenTurn.current = last.id;
    narrator.current ??= createNarrator({ muted: !readAloud });
    narrator.current.say(last.text, last.language);
  }, [invite?.turns, invite?.session?.mode, readAloud]);
  useEffect(() => () => { narrator.current?.cancel(); }, []);

  async function answerCall(id: string) {
    if (nurseCall.current) return;
    setBusy(true); setError(''); setNursePeers(0); setNurseMuted(false);
    const handle = joinHandoffAudio(id, 'patient', '', {
      status: setNurseStatus, error: setError, peers: setNursePeers,
      stopped: () => { if (nurseCall.current === handle) nurseCall.current = null; setOnNurseCall(false); void load(); },
    }, `/outreach/${token}/handoff`);
    nurseCall.current = handle; setOnNurseCall(true);
    try { await handle.ready; await load(); } finally { setBusy(false); }
  }
  async function leaveCall() {
    try { await nurseCall.current?.stop('ended'); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not end the call.'); }
  }

  async function start() {
    setBusy(true); setError('');
    try {
      const session = await api<Session>(`/outreach/${token}/start`, { mode });
      await load();
      if (mode === 'voice') {
        setCallMuted(false); setCallLevel(0);
        const handle = createInAppCall(session, invite!.patient.name, {
          status: setCallStatus, error: setError, level: setCallLevel,
          stopped: () => { if (call.current === handle) call.current = null; void load(); },
        }, `/outreach/${token}`);
        call.current = handle; handle.setVolume(callVolume);
        await handle.ready;
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'The check-in could not be started.'); }
    finally { setBusy(false); await load(); }
  }
  async function hangUp() {
    try { if (call.current) await call.current.stop(); else await api(`/outreach/${token}/end`, {}); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not end the check-in.'); }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError('');
    try { await api(`/outreach/${token}/message`, { eventId: crypto.randomUUID(), text }); setDraft(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Your reply could not be sent.'); }
    finally { setBusy(false); }
  }

  if (error && !invite) return <div className="patient-shell"><div className="patient-card"><TriangleAlert size={26} /><h1>This link is not valid</h1><p>{error}</p></div></div>;
  if (!invite) return <div className="patient-shell"><div className="patient-card"><LoaderCircle size={24} className="spin" /><p>Opening your check-in…</p></div></div>;

  const { patient, can, session, turns } = invite;
  const t = copy[patient.language];
  const live = Boolean(session && ['active', 'connecting'].includes(session.status));
  const finished = Boolean(session && !live);
  const elapsed = session && live ? Math.max(0, Math.floor((clock - Date.parse(session.startedAt)) / 1000)) : 0;

  return <div className="patient-shell">
    <header className="patient-top">
      <a className="brand" href="/" aria-label="Aftercare home"><span className="brand-icon"><HeartHandshake size={20} strokeWidth={1.8} /></span>aftercare<span className="brand-period">.</span></a>
      <span className="patient-whoami"><span className={`avatar ${patient.avatar}`}>{patient.initials}</span>{patient.name}</span>
    </header>

    <main className="patient-main">
      <section className="patient-card">
        <h1>{t.greeting(patient.name.split(' ')[0])}</h1>
        <p className="patient-intro">{t.intro}</p>
        {error && <div className="error-banner" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}

        {invite.handoff && ['requested', 'accepted', 'connecting', 'active'].includes(invite.handoff.state) && <section className={`patient-ring ${onNurseCall ? 'is-connected' : ''}`} role="alert">
          <span className="patient-ring-icon"><Phone size={20} /></span>
          <div>
            <strong>{onNurseCall ? t.onCall : t.ringing}</strong>
            <span>{onNurseCall ? (nursePeers > 0 ? nurseStatus || t.onCall : t.nurseWaiting) : t.ringHint}</span>
          </div>
          {onNurseCall ? <div className="handoff-buttons">
            <button className="button secondary" onClick={() => { const next = !nurseMuted; setNurseMuted(next); void nurseCall.current?.setMuted(next); }}>
              {nurseMuted ? <MicOff size={15} /> : <Mic size={15} />}{nurseMuted ? t.unmute : t.mute}
            </button>
            <button className="button end-button" onClick={() => void leaveCall()}><PhoneOff size={15} />{t.hangUp}</button>
          </div> : <button className="button primary" disabled={busy || invite.handoff.state === 'requested'} onClick={() => void answerCall(invite.handoff!.id)}>
            <Phone size={16} />{t.answer}
          </button>}
        </section>}

        {!session && invite.outreach.ringingSince && <section className="patient-ring" role="alert">
          <span className="patient-ring-icon"><PhoneIncoming size={20} /></span>
          <div><strong>{t.checkInRinging}</strong><span>{t.checkInHint}</span></div>
          <div className="handoff-buttons">
            <button className="button primary" disabled={busy} onClick={() => { setMode(can.voice ? 'voice' : 'chat'); void start(); }}>
              <PhoneIncoming size={16} />{t.answerCheckIn}
            </button>
          </div>
        </section>}

        {!session && <>
          <div className="patient-modes" role="group" aria-label={t.how}>
            <span className="small-kicker">{t.how}</span>
            <button className={`patient-mode ${mode === 'voice' ? 'is-selected' : ''}`} disabled={!can.voice} onClick={() => setMode('voice')}>
              <Phone size={18} /><div><strong>{t.call}</strong><span>{can.voice ? t.callHint : can.voiceReason}</span></div>
            </button>
            <button className={`patient-mode ${mode === 'chat' ? 'is-selected' : ''}`} disabled={!can.chat} onClick={() => setMode('chat')}>
              <MessageSquare size={18} /><div><strong>{t.chat}</strong><span>{can.chat ? t.chatHint : can.chatReason}</span></div>
            </button>
          </div>
          <button className="button primary full-width" onClick={() => void start()} disabled={busy || (!can.voice && !can.chat)}>
            {busy ? <LoaderCircle size={17} className="spin" /> : mode === 'voice' ? <Phone size={17} /> : <Send size={17} />}
            {mode === 'voice' ? t.call : t.chat}
          </button>
        </>}

        {session?.mode === 'voice' && <InAppCall
          patient={patient.name} language={patient.language} active={live} busy={busy}
          disabled={!can.voice} status={callStatus} elapsed={elapsed} muted={callMuted}
          volume={callVolume} level={callLevel}
          onStart={() => void start()} onEnd={() => void hangUp()}
          onMute={() => { const next = !callMuted; setCallMuted(next); call.current?.setMuted(next); }}
          onVolume={value => { setCallVolume(value); call.current?.setVolume(value); }}
        />}

        {turns.length > 0 && <div className="patient-transcript" aria-live="polite">
          <span className="small-kicker">{t.conversation}</span>
          {turns.map(turn => <div key={turn.id} className={`patient-turn ${turn.role}`}>
            <span>{turn.role === 'agent' ? 'Aftercare' : t.you}</span>
            <p lang={turn.language}>{turn.text}</p>
          </div>)}
          <div ref={endRef} />
        </div>}

        {session?.mode === 'chat' && live && <button type="button" className="patient-readaloud" aria-pressed={readAloud}
          onClick={() => { const next = !readAloud; setReadAloud(next); narrator.current?.setMuted(!next); }}>
          {readAloud ? <Volume2 size={16} /> : <VolumeX size={16} />}{readAloud ? t.readAloud : t.readAloudOff}
        </button>}

        {session?.mode === 'chat' && live && <form className="patient-composer" onSubmit={send}>
          <label className="sr-only" htmlFor="patient-reply">{t.reply}</label>
          <textarea id="patient-reply" rows={2} maxLength={2000} autoFocus value={draft} placeholder={t.placeholder}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e); } }} />
          <button className="button primary" disabled={busy || !draft.trim()}><Send size={16} />{t.send}</button>
        </form>}

        {finished && <div className="patient-done"><ShieldCheck size={18} />{t.done}</div>}
        <p className="patient-footer">{t.footer}</p>
      </section>

      <aside className="patient-chart" aria-label={t.yourCare}>
        <span className="small-kicker">{t.yourCare}</span>
        <div className="info-row"><span><Plus size={15} /></span><div><span>{t.procedure}</span><strong>{patient.procedure}</strong></div></div>
        <div className="info-row"><span><CalendarDays size={15} /></span><div><span>{t.discharged}</span><strong>{day(patient.dischargeDate)} · day {daysSince(patient.dischargeDate)}</strong></div></div>
        <div className="info-row"><span><CalendarDays size={15} /></span><div><span>{t.appointment}</span><strong>{day(patient.appointment, { weekday: 'long', month: 'short', day: 'numeric' })}</strong></div></div>
        <div className="info-row"><span><Stethoscope size={15} /></span><div><span>{t.team}</span><strong>{patient.surgeon}</strong></div></div>
        <div className="info-row"><span><Users size={15} /></span><div><span>{t.support}</span><strong>{patient.caregiver}</strong></div></div>
        <div className="patient-meds"><span className="small-kicker"><Pill size={12} /> {t.meds}</span>{patient.medications.map(m => <p key={m}>{m}</p>)}</div>
      </aside>
    </main>
  </div>;
}
