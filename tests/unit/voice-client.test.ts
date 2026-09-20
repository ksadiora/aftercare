import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../server/store';
import { createInAppCall, startBrowserVoice } from '../../src/voice';
const sdk = vi.hoisted(() => ({ options: null as Record<string, any> | null, speakOnStart: false, endSession: vi.fn(), setMicMuted: vi.fn(), setVolume: vi.fn(), getInputVolume: vi.fn(() => .4) }));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: vi.fn(async (options: Record<string, any>) => { sdk.options = options; options.onConnect({ conversationId: 'provider-test' }); if (sdk.speakOnStart) options.onModeChange({ mode: 'speaking' }); return { endSession: sdk.endSession, setMicMuted: sdk.setMicMuted, setVolume: sdk.setVolume, getInputVolume: sdk.getInputVolume }; }) } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); sdk.speakOnStart = false; });
describe('browser voice adapter with a mocked provider', () => {
  it('uses original transcript callbacks, server instructions, and waits for final audio before ending', async () => {
    vi.useFakeTimers();
    const store = new Store(':memory:'); const s = store.start('alvarez', 'voice', 'en', null);
    const trackStop = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) });
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/voice-url')) return Response.json({ signedUrl: 'wss://test.invalid/signed' });
      if (path.endsWith('/connected')) return Response.json(store.connect(s.id, body.providerId));
      if (path.endsWith('/events')) return Response.json(store.ingest(s.id, body.eventId, body.role, body.text));
      if (path.endsWith('/end')) return Response.json(store.finish(s.id, body.reason));
      if (path.endsWith('/heartbeat')) return Response.json({ status: store.session(s.id).status });
      return Response.json(store.session(s.id));
    }));
    const callbacks = { status: vi.fn(), error: vi.fn(), stopped: vi.fn(), level: vi.fn() };
    const handle = await startBrowserVoice(s, 'Miguel Alvarez', callbacks);
    handle.setMuted(true); expect(sdk.setMicMuted).toHaveBeenLastCalledWith(true);
    handle.setVolume(.3); expect(sdk.setVolume).toHaveBeenLastCalledWith({volume: .3});
    await vi.advanceTimersByTimeAsync(150); expect(callbacks.level).toHaveBeenLastCalledWith(0);
    handle.setMuted(false); await vi.advanceTimersByTimeAsync(150); expect(callbacks.level).toHaveBeenLastCalledWith(.4);
    const options = sdk.options!;
    // The permission stream is held for the whole call: it is what the barge-in
    // gate reads while the microphone is shut, and it is released on stop.
    expect(options.connectionType).toBe('websocket'); expect(trackStop).not.toHaveBeenCalled();
    options.onMessage({ role: 'user', message: 'Yes, that is me. You can continue.', event_id: 1 });
    const next = JSON.parse(await options.clientTools.get_next_step()); expect(next.instruction).toContain('incision');
    options.onMessage({ role: 'user', message: 'My chest hurts and I cannot breathe.', event_id: 2 });
    const emergency = JSON.parse(await options.clientTools.get_next_step()); expect(emergency).toMatchObject({ done: true, reason: 'emergency' });
    expect(store.patient('alvarez').severity).toBe('emergency');
    options.onMessage({ role: 'agent', message: emergency.instruction, event_id: 3 });
    options.onModeChange({ mode: 'speaking' }); await options.clientTools.finish_session();
    await vi.advanceTimersByTimeAsync(1000); expect(sdk.endSession).not.toHaveBeenCalled();
    options.onModeChange({ mode: 'listening' }); await vi.advanceTimersByTimeAsync(400);
    expect(sdk.endSession).toHaveBeenCalledOnce(); expect(store.session(s.id).status).toBe('emergency');
    expect(callbacks.error).not.toHaveBeenCalled(); expect(callbacks.stopped).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    await handle.stop(); store.close();
  });
});

it('ends a call while microphone permission is pending and releases a late stream', async () => {
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), setTimeout });
  let grant!: (value: unknown) => void;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
  const fetch = vi.fn(async (_path: string) => Response.json({status:'interrupted'})); vi.stubGlobal('fetch', fetch);
  const callbacks = { status: vi.fn(), error: vi.fn(), stopped: vi.fn() };
  const store = new Store(':memory:'); const session = store.start('alvarez', 'voice', 'en', null);
  const call = createInAppCall(session, 'Miguel', callbacks);
  await call.stop(); await call.ready;
  const trackStop = vi.fn(); grant({getTracks: () => [{stop:trackStop}]}); await Promise.resolve();
  expect(trackStop).toHaveBeenCalledOnce(); expect(callbacks.stopped).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0][0])).toContain('/end');
  expect(callbacks.error).not.toHaveBeenCalled(); store.close();
});

for (const language of ['en', 'es'] as const) it(`completes a full ${language} intake from participant transcript events`, async () => {
  const { responses } = await import('../../shared/protocol');
  vi.useFakeTimers();
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), setTimeout });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({getTracks: () => [{stop:vi.fn()}]}) } });
  const store = new Store(':memory:'); const session = store.start('alvarez', 'voice', language, null);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (path.endsWith('/voice-url')) return Response.json({signedUrl:'wss://test.invalid'});
    if (path.endsWith('/connected')) return Response.json(store.connect(session.id, body.providerId));
    if (path.endsWith('/events')) return Response.json(store.ingest(session.id, body.eventId, body.role, body.text));
    if (path.endsWith('/end')) return Response.json(store.finish(session.id, body.reason));
    return Response.json(store.session(session.id));
  }));
  const callbacks = {status:vi.fn(),error:vi.fn(),stopped:vi.fn()};
  const call = await startBrowserVoice(session, 'Miguel', callbacks); const options = sdk.options!;
  expect(options.overrides.agent.language).toBe(language);
  let index = 0;
  for (const text of responses[language].recovery) {
    options.onMessage({role:'user', message:text, event_id:index++});
    const next = JSON.parse(await options.clientTools.get_next_step());
    options.onMessage({role:'agent',message:next.instruction,event_id:index++});
  }
  expect(store.session(session.id).next.done).toBe(true);
  options.onModeChange({mode:'speaking'}); await options.clientTools.finish_session();
  options.onModeChange({mode:'listening'}); await vi.advanceTimersByTimeAsync(400);
  expect(store.session(session.id).status).toBe('completed');
  expect(store.patient('alvarez').severity).toBe('green');
  expect(store.detail('alvarez').turns.filter(t => t.role === 'user')).toHaveLength(responses[language].recovery.length);
  expect(callbacks.error).not.toHaveBeenCalled(); await call.stop(); store.close();
});

/**
 * Reported from a live call: the check-in reached its last question, the agent
 * began its closing line, the participant said thank you over it, and the page
 * showed "Intake recording failed: The intake has ended; no further answers are
 * accepted." — a red alert at the one moment the check-in had actually worked.
 */
it('takes a goodbye over the closing line without alarming anyone', async () => {
  const { responses } = await import('../../shared/protocol');
  vi.useFakeTimers();
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), setTimeout });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({getTracks: () => [{stop:vi.fn()}]}) } });
  const store = new Store(':memory:'); const session = store.start('alvarez', 'voice', 'en', null);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (path.endsWith('/voice-url')) return Response.json({signedUrl:'wss://test.invalid'});
    if (path.endsWith('/connected')) return Response.json(store.connect(session.id, body.providerId));
    if (path.endsWith('/events')) {
      try { return Response.json(store.ingest(session.id, body.eventId, body.role, body.text)); }
      catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as {status?: number}).status ?? 500 }); }
    }
    if (path.endsWith('/end')) return Response.json(store.finish(session.id, body.reason));
    return Response.json(store.session(session.id));
  }));
  const callbacks = {status:vi.fn(),error:vi.fn(),stopped:vi.fn()};
  const call = await startBrowserVoice(session, 'Miguel', callbacks); const options = sdk.options!;
  let index = 0;
  for (const text of responses.en.recovery) {
    options.onMessage({role:'user', message:text, event_id:index++});
    const next = JSON.parse(await options.clientTools.get_next_step());
    options.onMessage({role:'agent',message:next.instruction,event_id:index++});
  }
  expect(store.session(session.id).next.done).toBe(true);
  options.onModeChange({mode:'speaking'});
  options.onMessage({role:'user', message:'Thank you so much. Goodbye.', event_id:index++});
  await options.clientTools.finish_session();
  options.onModeChange({mode:'listening'}); await vi.advanceTimersByTimeAsync(400);
  expect(callbacks.error).not.toHaveBeenCalled();
  expect(store.session(session.id).status).toBe('completed');
  // The courtesy is not filed as an answer, and it does not become an eighth turn.
  expect(store.detail('alvarez').turns.filter(t => t.role === 'user')).toHaveLength(responses.en.recovery.length);
  await call.stop(); store.close();
});

it('treats a refused transcript line as an intake already over, not a broken call', async () => {
  vi.useFakeTimers();
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), setTimeout });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({getTracks: () => [{stop:vi.fn()}]}) } });
  const store = new Store(':memory:'); const session = store.start('alvarez', 'voice', 'en', null);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (path.endsWith('/voice-url')) return Response.json({signedUrl:'wss://test.invalid'});
    if (path.endsWith('/connected')) return Response.json(store.connect(session.id, body.providerId));
    // The server has moved on; the browser learns it from the status, not a guess.
    if (path.endsWith('/events')) return Response.json({ error: 'This conversation has ended.' }, { status: 409 });
    if (path.endsWith('/end')) return Response.json(store.finish(session.id, body.reason));
    return Response.json(store.session(session.id));
  }));
  const callbacks = {status:vi.fn(),error:vi.fn(),stopped:vi.fn()};
  const call = await startBrowserVoice(session, 'Miguel', callbacks); const options = sdk.options!;
  options.onMessage({role:'user', message:'Yes, that is me.', event_id:1});
  await vi.advanceTimersByTimeAsync(50);
  expect(callbacks.error).not.toHaveBeenCalled();
  expect(callbacks.stopped).not.toHaveBeenCalled();
  await call.stop(); store.close();
});

/** A stand-in microphone whose level the test drives directly. */
const stubAudio = (level: { value: number }) => vi.stubGlobal('AudioContext', class {
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect: () => undefined }; }
  createAnalyser() {
    return {
      fftSize: 512,
      getByteTimeDomainData: (bytes: Uint8Array) => bytes.fill(128 + Math.round(level.value * 128)),
    };
  }
});

it('holds the microphone shut through a knock and opens it for real speech', async () => {
  vi.useFakeTimers();
  const level = { value: 0.004 };
  stubAudio(level);
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), setTimeout });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({getTracks: () => [{stop:vi.fn()}]}) } });
  const store = new Store(':memory:'); const session = store.start('alvarez', 'voice', 'en', null);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (path.endsWith('/voice-url')) return Response.json({signedUrl:'wss://test.invalid'});
    if (path.endsWith('/connected')) return Response.json(store.connect(session.id, body.providerId));
    if (path.endsWith('/end')) return Response.json(store.finish(session.id, body.reason));
    return Response.json(store.session(session.id));
  }));
  const callbacks = {status:vi.fn(),error:vi.fn(),stopped:vi.fn(),level:vi.fn()};
  const call = await startBrowserVoice(session, 'Miguel', callbacks); const options = sdk.options!;
  sdk.setMicMuted.mockClear();

  options.onModeChange({mode:'speaking'});
  expect(sdk.setMicMuted).toHaveBeenLastCalledWith(true);

  level.value = 0.9; await vi.advanceTimersByTimeAsync(60);   // one sample of a table knock
  level.value = 0.004; await vi.advanceTimersByTimeAsync(600);
  expect(sdk.setMicMuted).not.toHaveBeenLastCalledWith(false);

  level.value = 0.12; await vi.advanceTimersByTimeAsync(400); // someone genuinely cutting in
  expect(sdk.setMicMuted).toHaveBeenLastCalledWith(false);

  // Meanwhile the participant can still see their own level, gate or no gate.
  expect(callbacks.level).toHaveBeenLastCalledWith(expect.any(Number));
  expect(callbacks.level.mock.calls.some(([value]) => value > 0.1)).toBe(true);

  // A new agent turn starts shut again.
  options.onModeChange({mode:'listening'});
  level.value = 0.004; await vi.advanceTimersByTimeAsync(1200);
  options.onModeChange({mode:'speaking'});
  expect(sdk.setMicMuted).toHaveBeenLastCalledWith(true);
  await call.stop(); store.close();
});

it('keeps the opening consent question from being cut off by the room', async () => {
  // The agent starts its first line as soon as the socket opens, which can be
  // before the SDK handle exists here. The gate's decision for that turn still
  // has to reach the SDK, or the consent question plays with the microphone open.
  vi.useFakeTimers();
  const level = { value: 0.9 };            // a noisy room from the first moment
  stubAudio(level);
  sdk.speakOnStart = true;
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), setTimeout });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({getTracks: () => [{stop:vi.fn()}]}) } });
  const store = new Store(':memory:'); const session = store.start('alvarez', 'voice', 'en', null);
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (path.endsWith('/voice-url')) return Response.json({signedUrl:'wss://test.invalid'});
    if (path.endsWith('/connected')) return Response.json(store.connect(session.id, body.providerId));
    if (path.endsWith('/end')) return Response.json(store.finish(session.id, body.reason));
    return Response.json(store.session(session.id));
  }));
  const callbacks = {status:vi.fn(),error:vi.fn(),stopped:vi.fn(),level:vi.fn()};
  const call = await startBrowserVoice(session, 'Miguel', callbacks);
  expect(sdk.setMicMuted).toHaveBeenLastCalledWith(true);
  await call.stop(); store.close();
});
