import { AudioLines, Mic, MicOff, PhoneCall, PhoneOff, Volume2 } from 'lucide-react';
import { AudioCheck } from './AudioCheck';
import type { Language } from '../shared/types';
export function InAppCall(props: {
  patient: string; language: Language; active: boolean; busy: boolean; disabled: boolean;
  status: string; elapsed: number; muted: boolean; volume: number; level: number;
  onStart: () => void; onEnd: () => void; onMute: () => void; onVolume: (volume: number) => void;
}) {
  return <section className={`internet-call ${props.active ? 'is-active' : ''}`} aria-label="In-app call">
    <div className="call-network"><span className="tiny-dot"/>INTERNET AUDIO · ELEVENLABS</div>
    <div className={`call-avatar ${props.status === 'Agent speaking' ? 'is-speaking' : ''}`}><AudioLines size={34}/></div>
    <h3>Aftercare follow-up agent</h3>
    <p className="call-participant">You are {props.patient} · {props.language === 'es' ? 'Español' : 'English'}</p>
    <div className="call-state" role="status">{props.active ? props.status : props.busy ? 'Preparing call…' : props.status === 'Call ended' ? 'Call ended' : 'Ready when you are'}</div>
    {props.active ? <>
      <time className="call-time">{Math.floor(props.elapsed / 60)}:{String(props.elapsed % 60).padStart(2, '0')}<span> / 5:00</span></time>
      <div className="call-input"><span>{props.muted ? 'Microphone muted' : 'Your microphone'}</span><meter aria-label="Call microphone level" min={0} max={1} value={props.muted ? 0 : props.level}/></div>
      <div className="call-controls"><button className={`button secondary ${props.muted ? 'mic-muted' : ''}`} aria-pressed={props.muted} onClick={props.onMute}>{props.muted ? <MicOff size={18}/> : <Mic size={18}/>}{props.muted ? 'Unmute microphone' : 'Mute microphone'}</button><button className="button end-button" onClick={props.onEnd}><PhoneOff size={18}/>End call</button></div>
      <label className="call-volume"><Volume2 size={17}/><span>Speaker volume</span><input aria-label="Call speaker volume" type="range" min="0" max="100" value={Math.round(props.volume * 100)} onChange={e => props.onVolume(Number(e.target.value) / 100)}/></label>
      <p className="call-hint">Answer out loud. You can interrupt the agent. Headphones can help prevent echo.</p>
    </> : <>
      <AudioCheck disabled={props.disabled || props.busy}/>
      <button className="button primary full-width" onClick={props.onStart} disabled={props.disabled || props.busy}><PhoneCall size={18}/>{props.busy ? 'Preparing call…' : 'Start call'}</button>
      <p className="call-hint">Your real answers guide the conversation. Uses your ElevenLabs allowance. Audio recording is off.</p>
    </>}
    <div className="call-transfer-note">Nurse escalation creates a callback task. Phone transfer will be added with Twilio.</div>
  </section>;
}
