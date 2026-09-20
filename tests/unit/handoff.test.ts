import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { joinToken, mediaCapability, readToken, type MediaConfig } from '../../server/handoff';
import { messages } from '../../shared/protocol';

const media: MediaConfig = { apiKey: 'devkey', apiSecret: 'devsecret-for-tests-only', url: 'wss://rtc.example.test' };
let store: Store;
let server: ReturnType<typeof createApp>;
const build = (config = media, ringMs = 45000) => { server?.close(); server = createApp(store, { media: config, ringMs, simulationDelay: 5 }); };
const ring = (reason = 'A nurse requested a live conversation.') => request(server.app).post('/api/patients/alvarez/handoff').send({ reason });
const accept = (id: string, nurse: string) => request(server.app).post(`/api/handoffs/${id}/accept`).send({ nurse });
const token = (id: string, role: string, nurse = 'Demo nurse') => request(server.app).post(`/api/handoffs/${id}/token`).send({ role, nurse });
const joined = (id: string, role: string) => request(server.app).post(`/api/handoffs/${id}/joined`).send({ role });

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { server?.close(); store.close(); });

describe('livekit join tokens', () => {
  it('reports unavailability until all three settings are present', () => {
    expect(mediaCapability({}).enabled).toBe(false);
    expect(mediaCapability({ apiKey: 'k', apiSecret: 's' }).enabled).toBe(false);
    expect(mediaCapability(media).enabled).toBe(true);
    expect(mediaCapability({}).reason).toContain('LIVEKIT_URL');
  });

  it('mints a short-lived token scoped to one room and one identity', () => {
    const issued = joinToken(media, 'aftercare-room1', 'patient-alvarez', 'Miguel Alvarez');
    const claims = readToken(issued.token) as Record<string, never> & { video: Record<string, unknown>; exp: number; nbf: number };
    expect(claims.video).toMatchObject({ room: 'aftercare-room1', roomJoin: true, canPublish: true, canSubscribe: true });
    // Data channel is off: this is an audio handoff, not a side channel.
    expect(claims.video.canPublishData).toBe(false);
    expect(claims.sub).toBe('patient-alvarez');
    expect(claims.exp - claims.nbf).toBe(600);
    expect(issued.url).toBe('wss://rtc.example.test');
  });

  it('signs with the configured secret so a forged token cannot be substituted', () => {
    const { token: value } = joinToken(media, 'room', 'id', 'Name');
    const [header, payload, signature] = value.split('.');
    expect(createHmac('sha256', media.apiSecret!).update(`${header}.${payload}`).digest('base64url')).toBe(signature);
    expect(createHmac('sha256', 'wrong-secret').update(`${header}.${payload}`).digest('base64url')).not.toBe(signature);
  });

  it('refuses to mint a token with no media configuration', () => {
    expect(() => joinToken({}, 'room', 'id', 'Name')).toThrow('LIVEKIT_URL');
  });
});

describe('nurse handoff lifecycle', () => {
  it('records a callback task instead of ringing when media is not configured', async () => {
    build({});
    const response = await ring();
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('callback task');
    expect(store.activeHandoff()).toBe(null);
  });

  it('is idempotent: a double request rings once', async () => {
    build();
    const first = await ring();
    const second = await ring();
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(store.handoffs()).toHaveLength(1);
  });

  it('lets exactly one nurse claim a request', async () => {
    build();
    const { body: handoff } = await ring();
    const first = await accept(handoff.id, 'Nurse A');
    const second = await accept(handoff.id, 'Nurse B');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: 'accepted', nurse: 'Nurse A' });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('Nurse A');
    // The winner clicking again is harmless.
    expect((await accept(handoff.id, 'Nurse A')).status).toBe(200);
    expect(store.handoff(handoff.id).nurse).toBe('Nurse A');
  });

  it('issues tokens only after acceptance, and only to the accepting nurse', async () => {
    build();
    const { body: handoff } = await ring();
    const early = await token(handoff.id, 'patient');
    expect(early.status).toBe(409);
    expect(early.body.error).toContain('No nurse has accepted');

    await accept(handoff.id, 'Nurse A');
    expect((await token(handoff.id, 'nurse', 'Nurse B')).status).toBe(403);
    const patientToken = await token(handoff.id, 'patient');
    const nurseToken = await token(handoff.id, 'nurse', 'Nurse A');
    expect(readToken(patientToken.body.token).sub).toBe('patient-alvarez');
    expect(readToken(nurseToken.body.token).sub).toBe('nurse-Nurse A');
    // Both participants are scoped to the same room and nothing else.
    expect(patientToken.body.room).toBe(handoff.room);
    expect(nurseToken.body.room).toBe(handoff.room);
  });

  it('only reports a live conversation once both sides have actually joined', async () => {
    build();
    const { body: handoff } = await ring();
    await accept(handoff.id, 'Nurse A');
    const nurseOnly = await joined(handoff.id, 'nurse');
    expect(nurseOnly.body.state).toBe('connecting');
    expect(store.patient('alvarez').contactStatus).not.toContain('Talking');
    const both = await joined(handoff.id, 'patient');
    expect(both.body.state).toBe('active');
    expect(store.patient('alvarez').contactStatus).toBe('Talking with nurse');
    // Rejoining after a reconnect does not duplicate or regress the state.
    expect((await joined(handoff.id, 'patient')).body.state).toBe('active');
  });

  it('refuses to connect a handoff that no nurse has accepted', async () => {
    build();
    const { body: handoff } = await ring();
    const response = await joined(handoff.id, 'patient');
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('No nurse has accepted');
  });

  it('keeps an urgent callback task open when a nurse declines', async () => {
    build();
    const { body: handoff } = await ring();
    const response = await request(server.app).post(`/api/handoffs/${handoff.id}/decline`).send({ nurse: 'Nurse A', note: 'In another room.' });
    expect(response.body.state).toBe('declined');
    expect(store.patient('alvarez')).toMatchObject({ action: 'Nurse callback requested', contactStatus: 'Callback requested' });
    expect(store.detail('alvarez').audit.some(a => a.kind === 'handoff_declined')).toBe(true);
    // A declined request cannot then be accepted.
    expect((await accept(handoff.id, 'Nurse B')).status).toBe(409);
  });

  it('times out an unanswered request and preserves the callback task', async () => {
    build(media, 30);
    const { body: handoff } = await ring();
    await vi.waitFor(() => expect(store.handoff(handoff.id).state).toBe('timed_out'), { timeout: 3000 });
    expect(store.patient('alvarez')).toMatchObject({ action: 'Nurse callback requested', contactStatus: 'No nurse answered' });
    expect((await accept(handoff.id, 'Nurse A')).status).toBe(409);
  });

  it('treats a failed media connection as a failure, never as a completed transfer', async () => {
    build();
    const { body: handoff } = await ring();
    await accept(handoff.id, 'Nurse A');
    const response = await request(server.app).post(`/api/handoffs/${handoff.id}/end`).send({ state: 'failed' });
    expect(response.body.state).toBe('failed');
    expect(response.body.outcome).toContain('callback task remains open');
    expect(store.patient('alvarez').action).toBe('Nurse callback requested');
  });

  it('reopens a resolved case when a handoff fails', async () => {
    build();
    store.action('alvarez', 'resolve', 'Closed earlier.');
    const { body: handoff } = await ring();
    await request(server.app).post(`/api/handoffs/${handoff.id}/decline`).send({ nurse: 'Nurse A' });
    expect(store.patient('alvarez').disposition).toBe('open');
    expect(store.detail('alvarez').audit.some(a => a.text === 'Closed earlier.')).toBe(true);
  });

  it('lets a nurse join while the patient intake is still the one active session', async () => {
    build();
    const session = store.start('alvarez', 'voice', 'en', null, false, true);
    const { body: handoff } = await ring();
    const accepted = await accept(handoff.id, 'Nurse A');
    expect(accepted.status).toBe(200);
    // The global one-intake lock is untouched by a nurse joining.
    expect(store.activeSession()?.id).toBe(session.id);
    expect((await token(handoff.id, 'nurse', 'Nurse A')).status).toBe(200);
  });
});

describe('patient request for a person', () => {
  const askForPerson = async (handoffReady: boolean) => {
    build(handoffReady ? media : {});
    const session = store.start('alvarez', 'voice', 'en', null, false, handoffReady);
    store.ingest(session.id, 'e0', 'user', 'Yes, that is me. You can continue.');
    await request(server.app).post(`/api/sessions/${session.id}/events`).send({ eventId: 'e1', role: 'user', text: 'Can I speak to a nurse, please?' });
    return store.session(session.id);
  };

  it('promises only a callback when there is no live route', async () => {
    const session = await askForPerson(false);
    expect(session.next.instruction).toBe(messages.en.callback);
    expect(session.next.instruction).toContain('cannot transfer you');
    expect(store.activeHandoff()).toBe(null);
  });

  it('rings the care team and says so when a live route exists', async () => {
    const session = await askForPerson(true);
    expect(session.next.instruction).toBe(messages.en.handoff);
    expect(session.next.reason).toBe('callback');
    expect(store.activeHandoff()).toMatchObject({ state: 'requested', patientId: 'alvarez' });
    expect(store.activeHandoff()?.reason).toContain('asked to speak with a person');
  });

  it('never delays an emergency instruction behind a handoff', async () => {
    build();
    const session = store.start('alvarez', 'voice', 'en', null, false, true);
    store.ingest(session.id, 'e0', 'user', 'Yes, that is me. You can continue.');
    const response = await request(server.app).post(`/api/sessions/${session.id}/events`).send({ eventId: 'e1', role: 'user', text: 'My chest hurts and I cannot breathe.' });
    expect(response.body.session.next.instruction).toContain('911');
    expect(response.body.session.next.reason).toBe('emergency');
    expect(store.activeHandoff()).toBe(null);
  });
});

describe('handoff visibility after it ends', () => {
  it('keeps the outcome on the dashboard so the nurse is never left guessing', async () => {
    build();
    const { body: handoff } = await ring();
    await request(server.app).post(`/api/handoffs/${handoff.id}/decline`).send({ nurse: 'Nurse A' });
    // No longer live, so it cannot block a new request...
    expect(store.activeHandoff()).toBe(null);
    // ...but the outcome is still shown.
    const dashboard = await request(server.app).get('/api/dashboard');
    expect(dashboard.body.handoff).toMatchObject({ id: handoff.id, state: 'declined' });
    expect(dashboard.body.handoff.outcome).toContain('callback task remains open');
  });

  it('shows the newest handoff when a case is escalated twice', async () => {
    build();
    const { body: first } = await ring();
    await request(server.app).post(`/api/handoffs/${first.id}/decline`).send({ nurse: 'Nurse A' });
    const { body: second } = await ring();
    expect(second.id).not.toBe(first.id);
    expect((await request(server.app).get('/api/dashboard')).body.handoff.id).toBe(second.id);
  });
});
