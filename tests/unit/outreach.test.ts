import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import type { GeminiConfig } from '../../server/gemini';

const gemini: GeminiConfig = { apiKey: 'test-gemini-key' };
const model = (clarification: string, onTopic = true) => new Response(JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ onTopic, clarification, rationale: 'r' }) }] } }],
  modelVersion: 'gemini-test',
}));

let store: Store;
let server: ReturnType<typeof createApp>;
const build = (fetcher?: typeof fetch) => { server?.close(); server = createApp(store, { gemini, fetcher, simulationDelay: 5 }); };
const queue = () => request(server.app).get('/api/dashboard').then(r => r.body.outreach);
const waitForInvite = async () => {
  await vi.waitFor(async () => expect((await queue()).length).toBeGreaterThan(0), { timeout: 3000 });
  return (await queue())[0];
};

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { server?.close(); store.close(); });

describe('the service reaches out on its own', () => {
  it('invites a patient who is due without anyone asking', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    expect(invite).toMatchObject({ patientId: 'alvarez', state: 'sent' });
    expect(invite.token).toHaveLength(32);
    expect(store.patient('alvarez').contactStatus).toBe('Invitation sent');
    const audit = store.detail('alvarez').audit.find(a => a.kind === 'outreach_sent');
    // Honest about what actually happened: a link was made, nothing was delivered.
    expect(audit?.text).toContain('No delivery channel is configured');
  });

  it('only invites patients who are actually due', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await waitForInvite();
    const invited = (await queue()).map((o: { patientId: string }) => o.patientId);
    // Johnson and Chen already have a documented contact; the cohort is not callable.
    expect(invited).toEqual(['alvarez']);
  });

  it('does not invite the same patient twice', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const first = await waitForInvite();
    await new Promise(resolve => setTimeout(resolve, 1200));
    const all = await queue();
    expect(all).toHaveLength(1);
    expect(all[0].token).toBe(first.token);
  });
});

describe('the patient link is scoped to one patient', () => {
  it('shows that patient their own check-in and nothing else', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
    expect(body.patient).toMatchObject({ id: 'alvarez', name: 'Miguel Alvarez', language: 'es' });
    // No worklist, no other patients, no severity, no nurse notes.
    expect(body).not.toHaveProperty('patients');
    expect(JSON.stringify(body)).not.toContain('Evelyn');
    expect(JSON.stringify(body)).not.toContain('severity');
  });

  it('marks the invitation opened the first time it is used', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    expect((await request(server.app).get(`/api/outreach/${invite.token}`)).body.outreach.state).toBe('opened');
    expect(store.detail('alvarez').audit.some(a => a.kind === 'outreach_opened')).toBe(true);
  });

  it('refuses an unknown or tampered token', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await waitForInvite();
    for (const token of ['nope', 'a'.repeat(32), '']) {
      const response = await request(server.app).get(`/api/outreach/${token}`);
      expect([404, 301]).toContain(response.status);
    }
    expect((await request(server.app).post('/api/outreach/nope/start').send({})).status).toBe(404);
  });

  it('runs a whole check-in through the token alone', async () => {
    build(vi.fn().mockResolvedValue(model('¿De qué color está la piel alrededor de la herida?')) as unknown as typeof fetch);
    const invite = await waitForInvite();
    const started = await request(server.app).post(`/api/outreach/${invite.token}/start`).send({ language: 'en' });
    expect(started.status).toBe(201);
    expect(started.body.mode).toBe('chat');

    const script = ['Yes, that is me. You can continue.', 'No, it is not red or warm. There is no drainage.', 'No, I have not had a fever.', 'Yes, all prescriptions are filled and I understand them.', 'No, I have not fallen.', 'Yes, I am eating and drinking normally.', 'Yes, my daughter is taking me.'];
    let last;
    for (const [i, text] of script.entries()) {
      last = await request(server.app).post(`/api/outreach/${invite.token}/message`).send({ eventId: `p${i}`, text });
    }
    expect(last!.body.session.status).toBe('completed');
    expect(store.patient('alvarez')).toMatchObject({ severity: 'green', contactStatus: 'Outreach documented' });
    expect((await queue())[0].state).toBe('completed');
  });

  it('cannot touch a check-in belonging to someone else', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    // A different patient's session is active; the token must not reach it.
    store.start('johnson', 'chat', 'en', null, false, false);
    const response = await request(server.app).post(`/api/outreach/${invite.token}/message`).send({ eventId: 'x', text: 'hello' });
    expect(response.status).toBe(409);
    expect(store.detail('johnson').turns).toHaveLength(1);
  });

  it('refuses to start a check-in when the model is not configured', async () => {
    server?.close(); server = createApp(store, { gemini: {} });
    const invite = await waitForInvite();
    const response = await request(server.app).post(`/api/outreach/${invite.token}/start`).send({});
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('GEMINI_API_KEY');
  });

  it('a reset clears the queue and the next run invites again', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const first = await waitForInvite();
    await request(server.app).post('/api/demo/reset').send({});
    const second = await waitForInvite();
    expect(second.token).not.toBe(first.token);
    expect(await queue()).toHaveLength(1);
  });
});

describe('escalation reaches a provider', () => {
  it('puts an escalated case in the provider queue with the nurse reason', async () => {
    build(vi.fn() as unknown as typeof fetch);
    expect((await request(server.app).get('/api/provider/queue')).body).toEqual([]);

    await request(server.app).post('/api/patients/johnson/actions')
      .send({ action: 'escalate', note: 'Wound looks worse than day 1. Please advise on antibiotics.' });

    const { body } = await request(server.app).get('/api/provider/queue');
    expect(body).toHaveLength(1);
    expect(body[0].patient.id).toBe('johnson');
    expect(body[0].reason).toContain('Please advise');
    expect(body[0].lastReply).toBe(null);
    expect(body[0].escalatedAt).toBeTruthy();
  });

  it('sends the provider reply back into the nurse audit trail', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: 'Please advise.' });
    const reply = await request(server.app).post('/api/patients/johnson/provider-note')
      .send({ note: 'Start oral antibiotics and review in 24 hours.', provider: 'Dr Okafor' });
    expect(reply.status).toBe(200);

    const audit = (await request(server.app).get('/api/patients/johnson')).body.audit;
    const entry = audit.find((a: { kind: string }) => a.kind === 'provider_note');
    expect(entry).toMatchObject({ actor: 'Dr Okafor' });
    expect(entry.text).toContain('review in 24 hours');
    expect((await request(server.app).get('/api/provider/queue')).body[0].lastReply).toContain('24 hours');
  });

  it('a provider note does not change the disposition; the nurse still decides', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: 'Please advise.' });
    await request(server.app).post('/api/patients/johnson/provider-note').send({ note: 'Agreed, monitor.' });
    expect(store.patient('johnson').disposition).toBe('escalated');
    // And it leaves the queue only when a nurse resolves it.
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'resolve', note: 'Provider advice actioned.' });
    expect((await request(server.app).get('/api/provider/queue')).body).toEqual([]);
  });

  /**
   * Reported after two live tests: the provider wrote to the nurse and the nurse
   * could not find it, and there was no way for the nurse to answer. Both sides now
   * read and add to one thread, assembled from the audit trail so a case can never
   * hold a discussion the permanent record does not show.
   */
  const thread = (id = 'johnson') => request(server.app).get(`/api/patients/${id}`).then(r => r.body.thread);

  it('carries a message from the nurse to the provider and back again', async () => {
    build(vi.fn() as unknown as typeof fetch);
    expect((await request(server.app).get('/api/dashboard')).body.awaitingNurse).toEqual([]);

    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: 'Wound looks worse. Please advise.' });
    await request(server.app).post('/api/patients/johnson/provider-note').send({ note: 'Start oral antibiotics. Any fever?', provider: 'Dr Okafor' });
    await request(server.app).post('/api/patients/johnson/nurse-note').send({ note: 'No fever recorded today.', nurse: 'Nurse Rivera' });
    await request(server.app).post('/api/patients/johnson/provider-note').send({ note: 'Good. Review again tomorrow.', provider: 'Dr Okafor' });

    expect(await thread()).toMatchObject([
      { role: 'nurse', author: 'Demo nurse', text: 'Wound looks worse. Please advise.' },
      { role: 'provider', author: 'Dr Okafor', text: 'Start oral antibiotics. Any fever?' },
      { role: 'nurse', author: 'Nurse Rivera', text: 'No fever recorded today.' },
      { role: 'provider', author: 'Dr Okafor', text: 'Good. Review again tomorrow.' },
    ]);
    // Both surfaces read the same thread, in the same order.
    expect((await request(server.app).get('/api/provider/queue')).body[0].thread).toEqual(await thread());
  });

  it('says whose turn it is, and stops saying so once the nurse answers', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: 'Please advise.' });
    const awaiting = async () => (await request(server.app).get('/api/dashboard')).body.awaitingNurse;
    expect(await awaiting()).toEqual([]);

    await request(server.app).post('/api/patients/johnson/provider-note').send({ note: 'Start antibiotics.', provider: 'Dr Okafor' });
    expect(await awaiting()).toEqual(['johnson']);

    await request(server.app).post('/api/patients/johnson/nurse-note').send({ note: 'Started, thank you.', nurse: 'Nurse Rivera' });
    expect(await awaiting()).toEqual([]);
  });

  it('leaves the automated summary out of the conversation', async () => {
    // It is context, not something a person said. The two must never read as one voice.
    build(vi.fn() as unknown as typeof fetch);
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: '' });
    const messages = await thread();
    expect(messages).toEqual([]);
    // ...and the escalation with no note leaves no empty message standing in for one.
    const item = (await request(server.app).get('/api/provider/queue')).body[0];
    expect(item.summary).toBeTruthy();
    expect(item.thread).toEqual([]);
  });

  it('a nurse message does not close the case either', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: 'Please advise.' });
    await request(server.app).post('/api/patients/johnson/nurse-note').send({ note: 'Any thoughts?', nurse: 'Nurse Rivera' });
    expect(store.patient('johnson').disposition).toBe('escalated');
    expect((await request(server.app).get('/api/provider/queue')).body).toHaveLength(1);
  });

  it('rejects an empty nurse message', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: 'Please advise.' });
    expect((await request(server.app).post('/api/patients/johnson/nurse-note').send({ note: '  ' })).status).toBe(400);
  });

  it('rejects an empty provider note', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: 'Please advise.' });
    expect((await request(server.app).post('/api/patients/johnson/provider-note').send({ note: '  ' })).status).toBe(400);
  });
});

describe('the patient can call, not only type', () => {
  it('offers both modes and tells the patient why one is unavailable', async () => {
    server?.close();
    server = createApp(store, { gemini, voice: { apiKey: 'k', agentId: 'a' } });
    const invite = await waitForInvite();
    const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
    expect(body.can).toMatchObject({ voice: true, chat: true });

    server.close();
    server = createApp(store, { gemini: {} });
    const off = await request(server.app).get(`/api/outreach/${invite.token}`);
    expect(off.body.can).toMatchObject({ voice: false, chat: false });
    expect(off.body.can.voiceReason).toContain('ElevenLabs');
    expect(off.body.can.chatReason).toContain('GEMINI_API_KEY');
  });

  it('starts a voice check-in and issues a signed URL through the token alone', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ platform_settings: { privacy: { record_voice: false }, auth: { enable_auth: true } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ signed_url: 'wss://provider.test/signed' })));
    server?.close();
    server = createApp(store, { gemini, voice: { apiKey: 'k', agentId: 'a' }, fetcher: fetcher as unknown as typeof fetch });
    const invite = await waitForInvite();

    const started = await request(server.app).post(`/api/outreach/${invite.token}/start`).send({ mode: 'voice' });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ mode: 'voice', status: 'connecting' });

    const url = await request(server.app).post(`/api/outreach/${invite.token}/voice-url`).send({});
    expect(url.body.signedUrl).toBe('wss://provider.test/signed');

    // The agent's client tool reads the next instruction through the same token.
    await request(server.app).post(`/api/outreach/${invite.token}/connected`).send({ providerId: 'conv-1' });
    await request(server.app).post(`/api/outreach/${invite.token}/events`).send({ eventId: 'v1', role: 'user', text: 'Yes, that is me. You can continue.' });
    const next = await request(server.app).get(`/api/outreach/${invite.token}/next`);
    expect(next.body.next.instruction).toContain('incisi');
  });

  it('refuses a voice check-in when no voice provider is configured', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    const response = await request(server.app).post(`/api/outreach/${invite.token}/start`).send({ mode: 'voice' });
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('ElevenLabs');
  });

  it('shows the patient their own record but not the clinical judgement about them', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
    // Their own chart: yes.
    expect(body.patient).toMatchObject({ name: 'Miguel Alvarez', age: 71, surgeon: 'Dr. Morgan Lee' });
    expect(body.patient.medications.length).toBeGreaterThan(0);
    expect(body.patient.appointment).toBeTruthy();
    // The care team's assessment of them: no.
    for (const hidden of ['severity', 'disposition', 'quote', 'action', 'contactStatus']) {
      expect(body.patient).not.toHaveProperty(hidden);
    }
  });
});

describe('a nurse callback rings the patient', () => {
  const withMedia = () => {
    server?.close();
    server = createApp(store, { gemini, media: { apiKey: 'k', apiSecret: 's', url: 'wss://rtc.test' } });
    return server;
  };

  it('records a task only, when there is no live audio route', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    await request(server.app).post('/api/patients/alvarez/actions').send({ action: 'callback' });
    expect(store.activeHandoff()).toBe(null);
    const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
    expect(body.handoff).toBe(null);
    expect(store.patient('alvarez').action).toBe('Nurse callback requested');
  });

  it('rings the patient page when a live route exists', async () => {
    withMedia();
    const invite = await waitForInvite();
    await request(server.app).post('/api/patients/alvarez/actions').send({ action: 'callback' });

    const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
    expect(body.handoff).toMatchObject({ state: 'requested', patientId: 'alvarez' });
    expect(body.handoff.reason).toContain('calling you back');
    // The task is still recorded, so nothing is lost if nobody answers.
    expect(store.patient('alvarez').action).toBe('Nurse callback requested');
  });

  it('lets the patient answer only once a nurse is actually on the call', async () => {
    withMedia();
    const invite = await waitForInvite();
    await request(server.app).post('/api/patients/alvarez/actions').send({ action: 'callback' });
    const handoff = store.activeHandoff()!;

    const early = await request(server.app).post(`/api/outreach/${invite.token}/handoff/token`).send({ role: 'patient' });
    expect(early.status).toBe(409);

    await request(server.app).post(`/api/handoffs/${handoff.id}/accept`).send({ nurse: 'Rivera' });
    const granted = await request(server.app).post(`/api/outreach/${invite.token}/handoff/token`).send({ role: 'patient' });
    expect(granted.status).toBe(200);
    expect(granted.body.room).toBe(handoff.room);

    const joined = await request(server.app).post(`/api/outreach/${invite.token}/handoff/joined`).send({});
    expect(joined.body.state).toBe('connecting');
    await request(server.app).post(`/api/handoffs/${handoff.id}/joined`).send({ role: 'nurse' });
    expect(store.handoff(handoff.id).state).toBe('active');
  });

  it('never hands a patient token a call belonging to someone else', async () => {
    withMedia();
    const invite = await waitForInvite();
    await request(server.app).post('/api/patients/johnson/actions').send({ action: 'callback' });
    const response = await request(server.app).post(`/api/outreach/${invite.token}/handoff/token`).send({ role: 'patient' });
    expect(response.status).toBe(404);
  });
});

describe('inviting the other patients', () => {
  it('lets a nurse invite a patient the day-3 rule skipped', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await waitForInvite();
    // Johnson and Chen have a prior contact, so the scheduler leaves them alone.
    expect((await queue()).map((o: { patientId: string }) => o.patientId)).toEqual(['alvarez']);

    for (const id of ['johnson', 'chen']) {
      expect((await request(server.app).post(`/api/patients/${id}/outreach`).send({})).status).toBe(201);
    }
    const tokens = await queue();
    expect(tokens.map((o: { patientId: string }) => o.patientId).sort()).toEqual(['alvarez', 'chen', 'johnson']);
    // Each gets their own link, and each link opens their own record.
    expect(new Set(tokens.map((o: { token: string }) => o.token)).size).toBe(3);
    const chen = tokens.find((o: { patientId: string }) => o.patientId === 'chen');
    const { body } = await request(server.app).get(`/api/outreach/${chen.token}`);
    expect(body.patient).toMatchObject({ name: 'Robert Chen', language: 'en' });
  });

  it('is idempotent and refuses the illustrative cohort', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const first = await request(server.app).post('/api/patients/johnson/outreach').send({});
    const again = await request(server.app).post('/api/patients/johnson/outreach').send({});
    expect(again.body.token).toBe(first.body.token);

    const cohort = await request(server.app).post('/api/patients/cohort-1/outreach').send({});
    expect(cohort.status).toBe(400);
    expect(cohort.body.error).toContain('featured');
  });
});

describe('probes are grounded in the operation', () => {
  it('tells the model which operation the patient had', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('Is the redness spreading past the incision on your knee?'));
    build(fetcher as unknown as typeof fetch);
    const invite = await waitForInvite();
    await request(server.app).post(`/api/outreach/${invite.token}/start`).send({ mode: 'chat', language: 'en' });
    await request(server.app).post(`/api/outreach/${invite.token}/message`).send({ eventId: 'c0', text: 'Yes, that is me. You can continue.' });
    await request(server.app).post(`/api/outreach/${invite.token}/message`).send({ eventId: 'c1', text: 'It is red and warm, and I had a fever last night.' });

    const sent = JSON.parse(String((fetcher.mock.calls.at(-1) as [string, RequestInit])[1].body));
    expect(sent.contents[0].parts[0].text).toContain('Total knee replacement');
    expect(sent.contents[0].parts[0].text).toMatch(/\d+ days ago/);
    // Prompts are hard-wrapped, so compare on normalised whitespace.
    const system = String(sent.systemInstruction.parts[0].text).replace(/\s+/g, ' ');
    expect(system).toContain('name the body part the operation was on');
    expect(system).toContain('never licence to assess');
  });

  it('knowing the operation still does not license clinical advice', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('After a knee replacement you should take your antibiotic; is it helping?'));
    build(fetcher as unknown as typeof fetch);
    const invite = await waitForInvite();
    await request(server.app).post(`/api/outreach/${invite.token}/start`).send({ mode: 'chat', language: 'en' });
    await request(server.app).post(`/api/outreach/${invite.token}/message`).send({ eventId: 'd0', text: 'Yes, that is me. You can continue.' });
    const flagged = await request(server.app).post(`/api/outreach/${invite.token}/message`).send({ eventId: 'd1', text: 'It is red and warm, and I had a fever last night.' });
    expect(flagged.body.session.next.instruction).not.toContain('antibiotic');
    expect(store.detail('alvarez').audit.some(a => a.kind === 'adaptive_skipped' && a.text.includes('treatment'))).toBe(true);
  });
});

describe('the care team can ring a patient for their check-in', () => {
  it('rings the patient, and it is the agent they will talk to, not a nurse', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    const rung = await request(server.app).post('/api/patients/alvarez/ring').send({});
    expect(rung.status).toBe(201);
    expect(rung.body.ringingSince).toBeTruthy();

    const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
    expect(body.outreach.ringingSince).toBeTruthy();
    // No human handoff is created; this is the automated check-in.
    expect(body.handoff).toBe(null);
    expect(store.patient('alvarez').contactStatus).toBe('Check-in call ringing');
    expect(store.detail('alvarez').audit.some(a => a.kind === 'checkin_ring')).toBe(true);
  });

  it('creates a link first if the patient did not have one', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await waitForInvite();
    expect((await queue()).map((o: { patientId: string }) => o.patientId)).toEqual(['alvarez']);
    await request(server.app).post('/api/patients/chen/ring').send({});
    const chen = (await queue()).find((o: { patientId: string }) => o.patientId === 'chen');
    expect(chen.ringingSince).toBeTruthy();
  });

  it('stops ringing once the patient answers', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const invite = await waitForInvite();
    await request(server.app).post('/api/patients/alvarez/ring').send({});
    await request(server.app).post(`/api/outreach/${invite.token}/start`).send({ mode: 'chat', language: 'en' });
    const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
    expect(body.outreach.ringingSince).toBe(null);
    expect(body.session.mode).toBe('chat');
  });

  it('gives up honestly when nobody answers, leaving the link usable', async () => {
    server?.close();
    server = createApp(store, { gemini, ringMs: 40, simulationDelay: 5 });
    const invite = await waitForInvite();
    await request(server.app).post('/api/patients/alvarez/ring').send({});
    await vi.waitFor(async () => {
      const { body } = await request(server.app).get(`/api/outreach/${invite.token}`);
      expect(body.outreach.ringingSince).toBe(null);
    }, { timeout: 3000 });
    expect(store.patient('alvarez').contactStatus).toBe('No answer to check-in call');
    expect(store.detail('alvarez').audit.some(a => a.kind === 'checkin_no_answer')).toBe(true);
    // The invitation itself still works; they can take it in their own time.
    expect((await request(server.app).get(`/api/outreach/${invite.token}`)).status).toBe(200);
  });

  it('refuses to ring while another conversation is running', async () => {
    build(vi.fn() as unknown as typeof fetch);
    await waitForInvite();
    store.start('johnson', 'chat', 'en', null, false, false);
    const response = await request(server.app).post('/api/patients/alvarez/ring').send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('already running');
  });

  it('refuses to ring an illustrative cohort record', async () => {
    build(vi.fn() as unknown as typeof fetch);
    expect((await request(server.app).post('/api/patients/cohort-3/ring').send({})).status).toBe(400);
  });
});
