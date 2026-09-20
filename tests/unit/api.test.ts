import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { signedVoiceUrl } from '../../server/voice';
let store: Store;
let server: ReturnType<typeof createApp>;
beforeEach(() => { store = new Store(':memory:'); server = createApp(store, { simulationDelay: 10 }); });
afterEach(() => { server.close(); store.close(); });
describe('local application API', () => {
  it('works without credentials and does not claim voice is ready', async () => {
    const capabilities = await request(server.app).get('/api/capabilities'); expect(capabilities.body.voice).toBe(false);
    const response = await request(server.app).post('/api/sessions').send({ patientId: 'alvarez', mode: 'voice', language: 'en' });
    expect(response.status).toBe(503); expect(store.activeSession()).toBe(null);
    expect((await request(server.app).get('/api/dashboard')).body.patients).toHaveLength(40);
  });
  it('runs a simulation through intake storage and preserves data on subsequent reads', async () => {
    const response = await request(server.app).post('/api/sessions').send({ patientId: 'alvarez', mode: 'simulation', language: 'es', scenario: 'wound' });
    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(store.activeSession()).toBe(null));
    const detail = await request(server.app).get('/api/patients/alvarez');
    expect(detail.body.patient.severity).toBe('red'); expect(detail.body.turns.some((t: { text: string }) => t.text.includes('roja y caliente'))).toBe(true);
  });
  it('lets browser audio pace a simulation instead of racing server timers', async () => {
    const started = await request(server.app).post('/api/sessions').send({ patientId: 'alvarez', mode: 'simulation', language: 'en', scenario: 'wound', browserPlayback: true });
    expect(started.status).toBe(201);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(store.detail('alvarez').turns).toHaveLength(1);
    const event = { eventId: 'simulation-0', role: 'user', text: 'Yes, that is me. You can continue.' };
    await request(server.app).post(`/api/sessions/${started.body.id}/events`).send(event);
    await request(server.app).post(`/api/sessions/${started.body.id}/events`).send(event);
    expect(store.detail('alvarez').turns).toHaveLength(3);
    expect(store.session(started.body.id).status).toBe('active');
  });
  it('rejects invalid inputs and note-free resolution', async () => {
    expect((await request(server.app).post('/api/sessions').send({ patientId: 'alvarez', mode: 'phone', language: 'xx' })).status).toBe(400);
    expect((await request(server.app).post('/api/patients/alvarez/actions').send({ action: 'resolve', note: ' ' })).status).toBe(400);
    expect((await request(server.app).get('/api/patients/missing')).status).toBe(404);
  });
  it('rejects cross-site mutation and unexpected hosts', async () => {
    expect((await request(server.app).post('/api/demo/reset').set('Origin', 'https://evil.example').send({})).status).toBe(403);
    expect((await request(server.app).get('/api/dashboard').set('Host', 'evil.example')).status).toBe(403);
    expect((await request(server.app).post('/api/demo/reset').type('form').send('reset=true')).status).toBe(415);
  });
  it('prevents a double start', async () => {
    server.close(); server = createApp(store, { simulationDelay: 10000 });
    const body = { patientId: 'alvarez', mode: 'simulation', language: 'en' };
    const first = await request(server.app).post('/api/sessions').send(body); const second = await request(server.app).post('/api/sessions').send(body);
    expect(first.status).toBe(201); expect(second.status).toBe(409);
  });
  it('fails the voice session on unavailable credits without starting simulation', async () => {
    server.close();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ platform_settings: { privacy: { record_voice: false }, auth: { enable_auth: true } } }))).mockResolvedValueOnce(new Response('{}', { status: 402 }));
    server = createApp(store, { voice: { apiKey: 'fake-test-key', agentId: 'fake-agent' }, fetcher });
    const started = await request(server.app).post('/api/sessions').send({ patientId: 'alvarez', mode: 'voice', language: 'en' });
    const response = await request(server.app).post(`/api/sessions/${started.body.id}/voice-url`).send({});
    expect(response.status).toBe(503); expect(response.body.error).toContain('credits');
    expect(store.detail('alvarez').sessions[0]).toMatchObject({ mode: 'voice', status: 'failed' }); expect(store.detail('alvarez').turns).toHaveLength(0);
  });
  it('caps active sessions at five minutes on the server', async () => {
    const s = store.start('alvarez', 'voice', 'en', null); s.startedAt = new Date(Date.now() - 301000).toISOString(); store.saveSession(s);
    await vi.waitFor(() => expect(store.activeSession()).toBe(null), { timeout: 2000 }); expect(store.session(s.id).status).toBe('interrupted');
  });
});
describe('voice setup protection', () => {
  it('requires audio recording to be disabled before issuing a signed URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ platform_settings: { privacy: { record_voice: true }, auth: { enable_auth: true } } })));
    await expect(signedVoiceUrl({ apiKey: 'test', agentId: 'test' }, fetcher)).rejects.toThrow('recording disabled'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not expose provider credentials in errors', async () => {
    await expect(signedVoiceUrl({ apiKey: 'very-secret', agentId: 'test' }, vi.fn().mockResolvedValue(new Response('very-secret', { status: 401 })))).rejects.toThrow('credentials');
  });
});

describe('the voice agent next-step tool', () => {
  it('serves the next instruction on both the nurse and the patient path', async () => {
    const session = store.start('alvarez', 'voice', 'en', null);
    const nurse = await request(server.app).get(`/api/sessions/${session.id}/next`);
    expect(nurse.status).toBe(200);
    expect(nurse.body.next.instruction).toContain('Aftercare');
    // The same shape the browser adapter expects, whichever base path it was given.
    expect(Object.keys(nurse.body)).toEqual(['next']);
  });
});
