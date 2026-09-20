import type { Session } from '../shared/types';
import { questions } from '../shared/protocol';
import { api, ApiError } from './api';
import { createBargeInGate, createMicMeter, type MicMeter } from './barge-in';
type VoiceHandle = { endSession: () => Promise<void>; setMicMuted: (value: boolean) => void; setVolume: (value: {volume: number}) => void; getInputVolume: () => number };
type Callbacks = { status: (message: string) => void; error: (message: string) => void; stopped: () => void; level?: (value: number) => void };
/** How often the microphone level is sampled. Fast enough that the gate's attack window is several samples wide. */
const SAMPLE_MS = 60;

// Return controls immediately so End call also works while permission/connection is pending.
export function createInAppCall(session: Session, patientName: string, callbacks: Callbacks, base = `/sessions/${session.id}`) {
  let conversation: VoiceHandle | undefined;
  let stopping = false;
  let micMuted = false;
  let volume = 1;
  let queue: Promise<unknown> = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let meter: ReturnType<typeof setInterval> | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let finishFallback: ReturnType<typeof setTimeout> | undefined;
  let finishRequested = false;
  /** Set once the server reports the questionnaire closed; no answer may follow it. */
  let intakeClosed = false;
  let speaking = false;
  let mic: MicMeter | undefined;
  let micStream: MediaStream | undefined;
  let gateOpen = true;
  let sentMuted = false;
  const gate = createBargeInGate();
  const abort = new AbortController();
  const status = () => { if (!stopping) callbacks.status(speaking ? 'Agent speaking' : micMuted ? 'Microphone muted' : 'Listening to you'); };
  /**
   * The microphone is closed either because the participant muted it, or because
   * the agent is mid-sentence and the gate has not heard sustained speech yet.
   * Only push a change, so a sample every 60ms does not spam the audio worklet.
   */
  const applyMute = (force = false) => {
    const muted = micMuted || (speaking && !gateOpen);
    if (!force && muted === sentMuted) return;
    sentMuted = muted; conversation?.setMicMuted(muted);
  };
  const releaseMic = () => {
    mic?.close(); mic = undefined;
    micStream?.getTracks().forEach(track => track.stop()); micStream = undefined;
  };
  const stop = async (reason: 'completed' | 'interrupted' | 'failed' = 'interrupted') => {
    if (stopping) return;
    stopping = true; abort.abort();
    clearInterval(heartbeat); clearInterval(meter); clearTimeout(limit); clearTimeout(finishFallback);
    releaseMic();
    callbacks.level?.(0);
    try { await conversation?.endSession(); } catch { /* Persist local end even if the remote socket is gone. */ }
    await queue.catch(() => undefined);
    try { await api(`${base}/end`, { reason }); } catch (error) { callbacks.error(error instanceof Error ? error.message : 'Could not record call end.'); }
    callbacks.status('Call ended'); callbacks.stopped();
  };
  const onPageHide = () => {
    void stop();
    void fetch(`/api${base}/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'interrupted' }), keepalive: true }).catch(() => undefined);
  };
  const onOffline = () => { callbacks.error('Internet connection lost. The incomplete call is saved for nurse review.'); void stop('failed'); };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('offline', onOffline);
  abort.signal.addEventListener('abort', () => { window.removeEventListener('pagehide', onPageHide); window.removeEventListener('offline', onOffline); }, { once: true });
  const setMuted = (value: boolean) => { micMuted = value; applyMute(); if (value) callbacks.level?.(0); status(); };
  const setVolume = (value: number) => { volume = Math.min(1, Math.max(0, value)); conversation?.setVolume({volume}); };
  // Race permission/SDK startup against cancellation without leaking a late microphone stream.
  const cancellable = <T,>(pending: Promise<T>) => new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Call ended', 'AbortError'));
    if (abort.signal.aborted) { cancel(); return; }
    abort.signal.addEventListener('abort', cancel, {once:true});
    pending.then(resolve, reject).finally(() => abort.signal.removeEventListener('abort', cancel));
  });
  const ready = (async () => {
    try {
      callbacks.status('Allow microphone access');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is unavailable. Use localhost or HTTPS in Chrome or Safari.');
      const probe = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      // A grant that lands after the call was cancelled still holds the microphone open.
      void probe.then(stream => { if (stopping) stream.getTracks().forEach(track => track.stop()); }, () => undefined);
      // Kept for the life of the call: the gate needs a level reading at exactly
      // the moments the SDK's own meter reports zero, which is while it is muted.
      // Recorded before the cancellation check, so stop() always has it to release.
      micStream = await cancellable(probe); mic = createMicMeter(micStream);
      if (stopping) { releaseMic(); return; }
      callbacks.status('Connecting');
      const timeout = setTimeout(() => { callbacks.error('The call could not connect within 25 seconds. Please try again.'); void stop('failed'); }, 25000);
      abort.signal.addEventListener('abort', () => clearTimeout(timeout), {once:true});
      try {
        const { signedUrl } = await api<{ signedUrl: string }>(`${base}/voice-url`, {}, abort.signal);
        const { Conversation } = await import('@elevenlabs/client');
        if (stopping) return;
        const connecting = Conversation.startSession({
          signedUrl, connectionType: 'websocket', overrides: { agent: { language: session.language } },
          dynamicVariables: { patient_name: patientName, opening: questions[session.language].consent },
          onConnect: ({ conversationId }) => {
            if (stopping) return;
            queue = queue.then(() => api(`${base}/connected`, { providerId: conversationId })).catch(error => {
              callbacks.error(`Could not save the call connection: ${error.message}`); window.setTimeout(() => void stop('failed'), 0);
            }); status();
          },
          onModeChange: ({ mode }) => {
            const wasSpeaking = speaking; speaking = mode === 'speaking';
            // Every agent turn starts with the gate shut, so the sound that ended
            // the last turn cannot carry over and cut off the next question. With
            // no level reading there is nothing to reopen it, so it never shuts.
            if (speaking && !wasSpeaking && mic) { gate.close(); gateOpen = false; }
            if (!speaking) gateOpen = true;
            applyMute(); status();
            if (finishRequested && wasSpeaking && !speaking) window.setTimeout(() => void stop('completed'), 300);
          },
          onMessage: ({ role, message, event_id }) => {
            if (stopping || !message.trim()) return;
            // Once the server has closed the questionnaire, anything further the
            // participant says is a goodbye over the agent's closing line, not an
            // answer. The server refuses it — correctly, nothing may follow the
            // last question — so sending it only produced an alarming red banner
            // at the exact moment the check-in had in fact succeeded.
            if (role === 'user' && intakeClosed) return;
            queue = queue.then(() => api(`${base}/events`, { role, text: message, eventId: `voice-${role}-${event_id ?? crypto.randomUUID()}` })).catch(error => {
              // A conflict means this intake is already over. Whatever ends the
              // call is already in flight; do not tear it down or alarm anyone.
              if (error instanceof ApiError && error.status === 409) { intakeClosed = true; return; }
              callbacks.error(`Intake recording failed: ${error instanceof Error ? error.message : 'Connection lost'}`);
              window.setTimeout(() => void stop('failed'), 0);
            });
          },
          clientTools: {
            get_next_step: async () => {
              await queue; if (stopping) throw new Error('Call ended');
              const latest = await api<{ next: Session['next'] }>(`${base}/next`);
              if (latest.next.done) intakeClosed = true;
              return JSON.stringify(latest.next);
            },
            finish_session: async () => {
              finishRequested = true; clearTimeout(finishFallback);
              // Preserve the final spoken instruction before closing audio.
              finishFallback = setTimeout(() => void stop('completed'), 15000);
              return 'Finish speaking the final instruction, then remain silent. The client will close after playback.';
            },
          },
          onError: message => { if (stopping) return; callbacks.error(`In-app call: ${message}. Check your ElevenLabs allowance and connection.`); window.setTimeout(() => void stop('failed'), 0); },
          onDisconnect: details => { if (stopping) return; if (details.reason === 'error') callbacks.error('The call disconnected. The incomplete intake is saved for nurse review.'); void stop(details.reason === 'error' ? 'failed' : 'interrupted'); },
        });
        void connecting.then(handle => { if (stopping) void handle.endSession(); }, () => undefined);
        conversation = await cancellable(connecting);
      } finally { clearTimeout(timeout); }
      if (stopping) return;
      // Force the push: the agent's opening line can begin before this point, and
      // the gate's decision from that turn has to reach the SDK, not just be recorded.
      applyMute(true); conversation.setVolume({volume});
      meter = setInterval(() => {
        if (stopping) return;
        if (!mic) { callbacks.level?.(micMuted ? 0 : Math.min(1, Math.max(0, conversation?.getInputVolume() || 0))); return; }
        const rms = micMuted ? 0 : mic.level();
        // Read from our own stream, so the meter still moves while the gate holds
        // the microphone shut and the participant can see they are being heard.
        callbacks.level?.(Math.min(1, rms * 5));
        if (speaking && !micMuted) gateOpen = gate.feed(rms, Date.now());
        applyMute();
      }, SAMPLE_MS);
      heartbeat = setInterval(() => {
        void api<{ status: string }>(`${base}/heartbeat`, {}).then(s => { if (!['active', 'connecting'].includes(s.status)) void stop(); }).catch(() => { callbacks.error('Lost the local intake connection.'); void stop('failed'); });
      }, 10000);
      limit = setTimeout(() => void stop(), Math.max(0, 300000 - (Date.now() - Date.parse(session.startedAt))));
    } catch (error) {
      if (stopping) return;
      callbacks.error(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow microphone access in your browser, or continue in writing instead.' : error instanceof Error ? error.message : 'The in-app call could not start.');
      await stop('failed');
    }
  })();
  return { ready, stop, setMuted, setVolume };
}
export async function startBrowserVoice(session: Session, patientName: string, callbacks: Callbacks) {
  const call = createInAppCall(session, patientName, callbacks); await call.ready; return call;
}
