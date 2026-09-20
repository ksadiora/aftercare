import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinHandoffAudio } from '../../src/handoff-media';

const sdk = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  setMicrophoneEnabled: vi.fn(async () => {}),
  handlers: {} as Record<string, (...args: unknown[]) => void>,
  remote: new Map<string, unknown>(),
  startAudio: vi.fn(async () => {}),
  appendChild: vi.fn(),
  canPlaybackAudio: true,
  constructed: 0,
}));
vi.mock('livekit-client', () => ({
  RoomEvent: { ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected', Disconnected: 'disconnected', AudioPlaybackStatusChanged: 'audioPlaybackChanged', TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed' },
  Room: class {
    localParticipant = { setMicrophoneEnabled: sdk.setMicrophoneEnabled };
    remoteParticipants = sdk.remote;
    startAudio = sdk.startAudio;
    get canPlaybackAudio() { return sdk.canPlaybackAudio; }
    constructor() { sdk.constructed += 1; }
    connect = sdk.connect;
    disconnect = sdk.disconnect;
    on(event: string, handler: (...args: unknown[]) => void) { sdk.handlers[event] = handler; return this; }
  },
}));

const calls: { path: string; body: Record<string, unknown> }[] = [];
function setup({ tokenFails = false, micDenied = false, connectFails = false } = {}) {
  calls.length = 0;
  sdk.remote.clear();
  sdk.handlers = {};
  sdk.canPlaybackAudio = true;
  sdk.connect.mockImplementation(async () => { if (connectFails) throw new Error('could not reach the media server'); });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => {
    if (micDenied) throw new DOMException('denied', 'NotAllowedError');
    return { getTracks: () => [{ stop: vi.fn() }] };
  }) } });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { body: { appendChild: sdk.appendChild } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    if (path.endsWith('/token')) {
      if (tokenFails) return Response.json({ error: 'No nurse has accepted this handoff yet (requested).' }, { status: 409 });
      return Response.json({ token: 'jwt.test.token', url: 'wss://rtc.example.test', room: 'aftercare-1' });
    }
    return Response.json({ ok: true });
  }));
}
const paths = () => calls.map(c => c.path.replace('/api/handoffs/h1', ''));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('handoff media adapter', () => {
  it('takes the token, connects, enables the microphone, then reports joining', async () => {
    setup();
    const status: string[] = [];
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: s => status.push(s), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    expect(paths()).toEqual(['/token', '/joined']);
    expect(calls[0].body).toMatchObject({ role: 'nurse', nurse: 'Nurse Rivera' });
    expect(sdk.connect).toHaveBeenCalledWith('wss://rtc.example.test', 'jwt.test.token');
    expect(sdk.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    // The server is told only after the media session is actually up.
    expect(paths().indexOf('/joined')).toBeGreaterThan(paths().indexOf('/token'));
    expect(status.at(-1)).toBe('Connected');
  });

  it('never claims to have joined when the media connection fails', async () => {
    setup({ connectFails: true });
    const error = vi.fn();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error, peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    expect(paths()).not.toContain('/joined');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('media server'));
    // A failed media connection is reported as a failure, not a completed handoff.
    expect(calls.find(c => c.path.endsWith('/end'))?.body).toMatchObject({ state: 'failed' });
  });

  it('explains a denied microphone and does not join', async () => {
    setup({ micDenied: true });
    const error = vi.fn();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error, peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Microphone permission was denied'));
    expect(paths()).not.toContain('/joined');
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('surfaces a refused token instead of connecting anyway', async () => {
    setup({ tokenFails: true });
    const error = vi.fn();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error, peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No nurse has accepted'));
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('reports how many other people are actually in the room', async () => {
    setup();
    const peers = vi.fn();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error: vi.fn(), peers, stopped: vi.fn() });
    await call.ready;
    expect(peers).toHaveBeenLastCalledWith(0);
    sdk.remote.set('patient-alvarez', {});
    sdk.handlers.participantConnected?.();
    expect(peers).toHaveBeenLastCalledWith(1);
  });

  it('treats a dropped connection as a failure that keeps the callback task', async () => {
    setup();
    const error = vi.fn();
    const stopped = vi.fn();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error, peers: vi.fn(), stopped });
    await call.ready;
    sdk.handlers.disconnected?.();
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled());
    expect(error).toHaveBeenCalledWith(expect.stringContaining('callback task remains open'));
    expect(calls.find(c => c.path.endsWith('/end'))?.body).toMatchObject({ state: 'failed' });
  });

  it('ends cleanly on request and releases the room once', async () => {
    setup();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    await call.stop('ended');
    await call.stop('ended');
    expect(sdk.disconnect).toHaveBeenCalledTimes(1);
    expect(calls.filter(c => c.path.endsWith('/end'))).toHaveLength(1);
    expect(calls.find(c => c.path.endsWith('/end'))?.body).toMatchObject({ state: 'ended' });
  });

  it('does not let a patient leaving close the case', async () => {
    setup();
    const call = joinHandoffAudio('h1', 'patient', '', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    await call.stop('ended');
    expect(calls.find(c => c.path.endsWith('/end'))).toBeUndefined();
    expect(sdk.disconnect).toHaveBeenCalled();
  });

  it('mutes and unmutes the local microphone', async () => {
    setup();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    await call.setMuted(true);
    expect(sdk.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await call.setMuted(false);
    expect(sdk.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });
});

describe('both seats in the room', () => {
  it('lets a patient and a nurse each take their own seat', async () => {
    setup();
    const nurse = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await nurse.ready;
    expect(calls.find(c => c.path.endsWith('/joined'))?.body).toMatchObject({ role: 'nurse' });

    setup();
    const patient = joinHandoffAudio('h1', 'patient', '', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await patient.ready;
    expect(calls.find(c => c.path.endsWith('/token'))?.body).toMatchObject({ role: 'patient' });
    expect(calls.find(c => c.path.endsWith('/joined'))?.body).toMatchObject({ role: 'patient' });
  });
});

describe('hearing the other person', () => {
  it('asks the browser to start playback and reports when it is blocked', async () => {
    setup();
    const status: string[] = [];
    const error = vi.fn();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: s => status.push(s), error, peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    // Playback is requested inside the join, while the click gesture still counts.
    expect(sdk.startAudio).toHaveBeenCalled();
    expect(call.audioBlocked()).toBe(false);

    // Browser refuses playback: the user must be told, not left in silence.
    sdk.canPlaybackAudio = false;
    sdk.handlers.audioPlaybackChanged?.();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('blocked audio playback'));
    expect(call.audioBlocked()).toBe(true);

    // Resuming from a button clears it.
    sdk.canPlaybackAudio = true;
    expect(await call.resumeAudio()).toBe(true);
    expect(call.audioBlocked()).toBe(false);
  });
});

describe('hearing the other side', () => {
  /** livekit-client does not play remote audio itself; the app must attach it. */
  const audioTrack = () => {
    const element = { autoplay: false, setAttribute: vi.fn(), play: vi.fn(async () => {}), remove: vi.fn() };
    return { track: { kind: 'audio', attachedElements: [], attach: vi.fn(() => element), detach: vi.fn(() => [element]) }, element };
  };

  it('attaches a subscribed audio track and plays it', async () => {
    setup();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await call.ready;

    const { track, element } = audioTrack();
    sdk.handlers.trackSubscribed?.(track);
    expect(track.attach).toHaveBeenCalled();
    expect(element.autoplay).toBe(true);
    expect(sdk.appendChild).toHaveBeenCalledWith(element);
    expect(element.play).toHaveBeenCalled();
  });

  it('ignores non-audio tracks and never double-attaches', async () => {
    setup();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await call.ready;

    const video = { kind: 'video', attachedElements: [], attach: vi.fn(), detach: vi.fn(() => []) };
    sdk.handlers.trackSubscribed?.(video);
    expect(video.attach).not.toHaveBeenCalled();

    const already = { kind: 'audio', attachedElements: [{}], attach: vi.fn(), detach: vi.fn(() => []) };
    sdk.handlers.trackSubscribed?.(already);
    expect(already.attach).not.toHaveBeenCalled();
  });

  it('releases the audio element when the call ends', async () => {
    setup();
    const call = joinHandoffAudio('h1', 'nurse', 'Nurse Rivera', { status: vi.fn(), error: vi.fn(), peers: vi.fn(), stopped: vi.fn() });
    await call.ready;
    const { track, element } = audioTrack();
    sdk.handlers.trackSubscribed?.(track);
    await call.stop('ended');
    expect(track.detach).toHaveBeenCalled();
    expect(element.remove).toHaveBeenCalled();
  });
});
