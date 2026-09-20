import { api } from './api';

type Role = 'patient' | 'nurse';
/** Minimal shape of a subscribed LiveKit track. */
interface TrackLike { kind: string; attach: () => HTMLMediaElement; detach: () => HTMLMediaElement[]; attachedElements?: HTMLMediaElement[] }
type Callbacks = { status: (message: string) => void; error: (message: string) => void; peers: (count: number) => void; stopped: () => void };
interface RoomLike {
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  startAudio: () => Promise<void>;
  canPlaybackAudio: boolean;
  localParticipant: { setMicrophoneEnabled: (enabled: boolean) => Promise<unknown> };
  remoteParticipants: Map<string, unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => unknown;
}

/**
 * Joins the LiveKit room for an accepted handoff. Mirrors the in-app call adapter:
 * controls come back immediately so Leave works while connecting, every failure is
 * explicit, and the server is told the truth about whether this side actually joined.
 *
 * Audio only. The server decides when a handoff counts as live — this reports arrival,
 * it never declares success on its own.
 */
export function joinHandoffAudio(handoffId: string, role: Role, nurse: string, callbacks: Callbacks, base = `/handoffs/${handoffId}`) {
  let room: RoomLike | undefined;
  let stopping = false;
  let muted = false;
  let blocked = false;
  let attached: TrackLike[] = [];
  const releaseAudio = () => {
    for (const track of attached) { try { track.detach().forEach(el => el.remove()); } catch { /* element already gone */ } }
    attached = [];
  };
  const abort = new AbortController();

  const stop = async (reason: 'ended' | 'failed' = 'ended', message?: string) => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    window.removeEventListener('pagehide', onPageHide);
    releaseAudio();
    try { await room?.disconnect(); } catch { /* keep going: the local state still has to settle */ }
    if (message) callbacks.error(message);
    // Only the side that started the handoff reports its end; a patient leaving is a
    // disconnect, not a decision to close the case.
    if (role === 'nurse') {
      try { await api(`${base}/end`, { state: reason === 'failed' ? 'failed' : 'ended' }); }
      catch (error) { callbacks.error(error instanceof Error ? error.message : 'Could not record the end of the handoff.'); }
    }
    callbacks.status('Handoff audio ended');
    callbacks.stopped();
  };
  const onPageHide = () => { void stop('failed'); };
  window.addEventListener('pagehide', onPageHide);

  const ready = (async () => {
    try {
      callbacks.status('Allow microphone access');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is unavailable. Use localhost or HTTPS in Chrome or Safari.');
      const probe = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      probe.getTracks().forEach(track => track.stop());
      if (stopping) return;

      callbacks.status('Requesting join token');
      const { token, url } = await api<{ token: string; url: string }>(`${base}/token`, { role, nurse }, abort.signal);
      if (stopping) return;

      callbacks.status('Connecting audio');
      const { Room, RoomEvent } = await import('livekit-client');
      if (stopping) return;
      const live = new Room({ adaptiveStream: false, dynacast: false }) as unknown as RoomLike;
      room = live;
      const reportPeers = () => callbacks.peers(live.remoteParticipants.size);
      live.on(RoomEvent.ParticipantConnected, reportPeers);
      live.on(RoomEvent.ParticipantDisconnected, reportPeers);
      live.on(RoomEvent.Disconnected, () => { if (!stopping) void stop('failed', 'The live audio connection dropped. An urgent callback task remains open.'); });
      // livekit-client does NOT play remote audio for you. Its Room handler on
      // TrackSubscribed only wires up playback-status listeners and re-emits; the
      // application has to attach the track to an element. Without this the call
      // connects, both sides publish, and neither hears anything.
      live.on(RoomEvent.TrackSubscribed, (...args: unknown[]) => {
        const track = args[0] as TrackLike | undefined;
        if (stopping || !track || track.kind !== 'audio') return;
        if (track.attachedElements?.length) return;
        const element = track.attach();
        element.autoplay = true;
        element.setAttribute('data-aftercare-audio', '');
        document.body.appendChild(element);
        attached.push(track);
        void element.play?.().catch(() => { /* reported by AudioPlaybackStatusChanged */ });
      });
      live.on(RoomEvent.TrackUnsubscribed, (...args: unknown[]) => {
        const track = args[0] as TrackLike | undefined;
        if (!track || track.kind !== 'audio') return;
        track.detach().forEach(element => element.remove());
        attached = attached.filter(t => t !== track);
      });
      // The SDK plays remote audio itself, but a browser can refuse until a gesture.
      // Silence with no explanation is the worst failure here, so say it out loud.
      live.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (stopping) return;
        blocked = !live.canPlaybackAudio;
        if (blocked) callbacks.error('Your browser blocked audio playback. Click "Resume audio" to hear the other person.');
        callbacks.status(blocked ? 'Audio blocked by the browser' : 'Connected');
      });

      await live.connect(url, token);
      if (stopping) { await live.disconnect(); return; }
      await live.localParticipant.setMicrophoneEnabled(true);
      // Called inside the click that started the join, so the gesture still counts.
      try { await live.startAudio(); } catch { /* the status handler reports it */ }
      blocked = !live.canPlaybackAudio;

      // Tell the server only after the media session is genuinely up.
      await api(`${base}/joined`, { role });
      reportPeers();
      callbacks.status('Connected');
    } catch (error) {
      if (stopping) return;
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow microphone access, or use the callback task instead.'
        : error instanceof Error ? error.message : 'The handoff audio could not connect.';
      await stop('failed', message);
    }
  })();

  return {
    ready,
    stop,
    audioBlocked: () => blocked,
    /** For a "Resume audio" button when the browser refused playback. */
    resumeAudio: async () => {
      try { await room?.startAudio(); blocked = !(room?.canPlaybackAudio ?? true); }
      catch { callbacks.error('Could not start audio playback.'); }
      callbacks.status(blocked ? 'Audio blocked by the browser' : 'Connected');
      return !blocked;
    },
    setMuted: async (value: boolean) => {
      muted = value;
      try { await room?.localParticipant.setMicrophoneEnabled(!value); } catch { callbacks.error('Could not change the microphone.'); }
      callbacks.status(muted ? 'Microphone muted' : 'Connected');
    },
  };
}
