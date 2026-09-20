import { BadgeCheck, Mic, MicOff, PhoneCall, PhoneOff, ShieldAlert, ShieldCheck, TriangleAlert, Volume2 } from 'lucide-react';
import type { Handoff } from '../shared/types';
import { handoffLabels } from '../shared/types';

/** Ringing banner for the nurse. Only ever shown for a handoff still waiting. */
export function HandoffRinging(props: { handoff: Handoff; patientName: string; nurse: string; busy: boolean; onAccept: () => void; onDecline: () => void }) {
  const { handoff } = props;
  return <section className="handoff-ringing" role="alert" aria-label="Incoming handoff request">
    <div className="handoff-pulse"><PhoneCall size={20} /></div>
    <div className="handoff-copy">
      <strong>{props.patientName} is waiting for a person</strong>
      <span>{handoff.reason}</span>
      {handoff.verification
        ? <span className={`handoff-verify ${handoff.verification.verified ? 'ok' : 'bad'}`}>
            {handoff.verification.verified ? <BadgeCheck size={13} /> : <ShieldAlert size={13} />}
            {handoff.verification.verified ? `Care-team service verified · ${handoff.verification.service}` : `Not verified · ${handoff.verification.detail}`}
          </span>
        : <span className="handoff-verify unknown"><ShieldAlert size={13} />Identity verification unavailable — ANS is not configured.</span>}
    </div>
    <div className="handoff-buttons">
      <button className="button primary" disabled={props.busy} onClick={props.onAccept}><PhoneCall size={16} />Accept as {props.nurse}</button>
      <button className="button secondary" disabled={props.busy} onClick={props.onDecline}><PhoneOff size={16} />Decline</button>
    </div>
  </section>;
}

/** State of a handoff already claimed, or the outcome of one that ended badly. */
export function HandoffStatus(props: {
  handoff: Handoff; onEnd: () => void; onJoin: () => void; onMute: () => void;
  joined: boolean; busy: boolean; audioStatus: string; peers: number; muted: boolean;
  audioBlocked: boolean; onResumeAudio: () => void;
}) {
  const { handoff } = props;
  const live = ['accepted', 'connecting', 'active'].includes(handoff.state);
  const bad = ['declined', 'timed_out', 'failed'].includes(handoff.state);
  return <section className={`handoff-status ${handoff.state}`} aria-label="Handoff status">
    <div className="handoff-state">
      {bad ? <TriangleAlert size={16} /> : handoff.state === 'active' ? <ShieldCheck size={16} /> : <PhoneCall size={16} />}
      <strong>{handoffLabels[handoff.state]}</strong>
      {handoff.nurse && <span className="small muted">{handoff.nurse}</span>}
    </div>
    {handoff.state === 'connecting' && <p className="small muted">Waiting for both people to connect. Nothing is announced as connected until they are.</p>}
    {handoff.outcome && <p className="small">{handoff.outcome}</p>}
    {bad && <p className="small muted">An urgent callback task stays open on this case.</p>}
    {props.joined && <p className="handoff-audio" role="status">
      <Mic size={13} />{props.audioStatus || 'Connecting audio'}
      {props.peers > 0 ? ' \u00b7 the patient is on the line' : ' \u00b7 ringing at their end, waiting for them to answer'}
    </p>}
    {live && <div className="handoff-buttons">
      {!props.joined && <button className="button primary" disabled={props.busy} onClick={props.onJoin}><PhoneCall size={15} />Join audio</button>}
      {props.joined && props.audioBlocked && <button className="button primary" disabled={props.busy} onClick={props.onResumeAudio}><Volume2 size={15} />Resume audio</button>}
      {props.joined && <button className={`button secondary ${props.muted ? 'mic-muted' : ''}`} aria-pressed={props.muted} disabled={props.busy} onClick={props.onMute}>{props.muted ? <MicOff size={15} /> : <Mic size={15} />}{props.muted ? 'Unmute' : 'Mute'}</button>}
      <button className="button secondary" disabled={props.busy} onClick={props.onEnd}><PhoneOff size={15} />End handoff</button>
    </div>}
  </section>;
}
