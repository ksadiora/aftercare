import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../server/store.js';
import { createApp } from '../../server/app.js';
import { configureCallsign } from '../../server/callsign/config.js';
import { screenEscalation } from '../../server/callsign/screening.js';
import { updatePolicy } from '../../server/callsign/policy.js';

/**
 * The escalation gate: Callsign's verification embedded in the nurse -> provider
 * escalation. Aftercare owns the case; the gate decides whether an escalation
 * may reach the provider and records the evidence. These tests run the real
 * pipeline against the local ANS-shaped registry (real X.509 + Merkle log) in a
 * temporary key directory, with no network.
 */
let keys: string;
let store: Store;
let server: ReturnType<typeof createApp>;

beforeAll(() => {
  keys = mkdtempSync(join(tmpdir(), 'aftercare-gate-'));
  configureCallsign({ keysDir: keys, ans: { mode: 'local' } });
});
afterAll(() => { rmSync(keys, { recursive: true, force: true }); });
beforeEach(() => { updatePolicy({ acceptCalls: true, specialtyOnly: true, note: '' }); store = new Store(':memory:'); server = createApp(store, { simulationDelay: 10, fetcher: vi.fn() as unknown as typeof fetch }); });
afterEach(() => { server.close(); store.close(); });

const escalate = (note = 'Wound looks worse than day 1. Please advise.', nurse = 'Nurse Rivera') =>
  request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note, nurse });
const gate = async () => (await request(server.app).get('/api/patients/johnson/escalation')).body;

describe('an escalation must pass the gate before it reaches the provider', () => {
  it('signs the escalation as the care-team service, verifies every check, and delivers it', async () => {
    expect((await escalate()).status).toBe(200);
    const view = await gate();
    expect(view.enabled).toBe(true);
    expect(view.escalation.status).toBe('delivered');
    expect(view.escalation.sender).toBe('careteam.aftercare.work');
    expect(view.escalation.providerAgent).toBe('lee.callsign-hcp.com');
    expect(view.escalation.steps.map((s: { id: string }) => s.id)).toEqual(['resolve', 'certificate', 'transparency', 'signature', 'policy', 'content']);
    expect(view.escalation.steps.every((s: { status: string }) => s.status === 'pass')).toBe(true);
    // Evidence travels with the record, so a third party can re-check it.
    const signature = view.escalation.steps.find((s: { id: string }) => s.id === 'signature');
    expect(signature.evidence.length).toBeGreaterThan(0);
    // The provider queue only carries delivered escalations, and it carries the record.
    const queue = (await request(server.app).get('/api/provider/queue')).body;
    expect(queue).toHaveLength(1);
    expect(queue[0].escalation.status).toBe('delivered');
    // The decision is in the audit trail, attributed to the gate, beside the nurse's own words.
    const audit = (await request(server.app).get('/api/patients/johnson')).body.audit;
    expect(audit.find((a: { kind: string }) => a.kind === 'escalation_gate').text).toMatch(/Delivered to Dr\. Morgan Lee/);
    expect(audit.find((a: { kind: string }) => a.kind === 'escalate').text).toContain('Please advise');
  });

  it('never changes urgency or disposition: the nurse still decides', async () => {
    await escalate();
    expect(store.patient('johnson').disposition).toBe('escalated');
    const severity = store.patient('johnson').severity;
    await request(server.app).post('/api/patients/johnson/escalation/demo').send({ variant: 'spoof' });
    expect(store.patient('johnson').disposition).toBe('escalated');
    expect(store.patient('johnson').severity).toBe(severity);
  });

  it("holds a verified escalation while the provider's policy says no, and explains it to the nurse", async () => {
    await request(server.app).post('/api/provider/policy').send({ acceptCalls: false, note: 'In clinic' });
    await escalate();
    const view = await gate();
    expect(view.escalation.status).toBe('held');
    expect(view.escalation.reason).toMatch(/In clinic/);
    expect(view.escalation.steps.find((s: { id: string }) => s.id === 'policy').status).toBe('fail');
    expect(view.escalation.steps.find((s: { id: string }) => s.id === 'content').status).toBe('skipped');
    expect((await request(server.app).get('/api/provider/queue')).body).toEqual([]);
    // The case stays open; when the provider is back, the nurse retries and it goes through.
    await request(server.app).post('/api/provider/policy').send({ acceptCalls: true });
    const retried = (await request(server.app).post('/api/patients/johnson/escalation/retry').send({ nurse: 'Nurse Rivera' })).body;
    expect(retried.escalation.status).toBe('delivered');
    expect((await request(server.app).get('/api/provider/queue')).body).toHaveLength(1);
  });

  it('rejects a spoofed sender at ANS resolution: a look-alike nobody registered', async () => {
    await escalate();
    const view = (await request(server.app).post('/api/patients/johnson/escalation/demo').send({ variant: 'spoof' })).body;
    expect(view.escalation.status).toBe('rejected');
    expect(view.escalation.variant).toBe('spoof');
    expect(view.escalation.sender).toBe('aftercare-careteam.xyz');
    expect(view.escalation.steps.find((s: { id: string }) => s.id === 'resolve').status).toBe('fail');
    expect(view.escalation.reason).toMatch(/resolve/i);
    // A rejected demo attempt never touches delivery: the genuine escalation is still with the provider.
    const queue = (await request(server.app).get('/api/provider/queue')).body;
    expect(queue).toHaveLength(1);
    expect(queue[0].escalation.variant).toBe('genuine');
    expect(queue[0].escalation.status).toBe('delivered');
    // The nurse's view shows the newest attempt, the provider's shows the newest genuine one.
    expect((await request(server.app).get('/api/patients/johnson/escalation?genuine=1')).body.escalation.status).toBe('delivered');
  });

  it('rejects a message tampered with after signing at the signature check', async () => {
    await escalate();
    const view = (await request(server.app).post('/api/patients/johnson/escalation/demo').send({ variant: 'tamper' })).body;
    expect(view.escalation.status).toBe('rejected');
    const signature = view.escalation.steps.find((s: { id: string }) => s.id === 'signature');
    expect(signature.status).toBe('fail');
    expect(signature.detail).toMatch(/does not match|signature/i);
  });

  it('rejects a replayed escalation: same id seen twice', async () => {
    await escalate();
    const view = (await request(server.app).post('/api/patients/johnson/escalation/demo').send({ variant: 'replay' })).body;
    expect(view.escalation.status).toBe('rejected');
    expect(view.escalation.steps.find((s: { id: string }) => s.id === 'signature').status).toBe('fail');
    expect(view.escalation.reason).toMatch(/already|replay|seen/i);
  });

  it('refuses to demo before there is a genuine escalation to imitate', async () => {
    const response = await request(server.app).post('/api/patients/johnson/escalation/demo').send({ variant: 'spoof' });
    expect(response.status).toBe(409);
  });

  it('blocks an escalation whose text asks for a credential, and keeps the case with the nurse', async () => {
    await escalate('Please confirm your login password so I can update the chart.');
    const view = await gate();
    expect(view.escalation.status).toBe('rejected');
    expect(view.escalation.steps.find((s: { id: string }) => s.id === 'content').status).toBe('fail');
    expect(view.escalation.screening.decision).toBe('block');
    expect(store.patient('johnson').disposition).toBe('escalated');
  });

  it('publishes a proof record for any request id', async () => {
    await escalate();
    const { requestId } = (await gate()).escalation;
    const proof = await request(server.app).get(`/api/proof/${requestId}`);
    expect(proof.status).toBe(200);
    expect(proof.body.steps).toHaveLength(6);
    expect((await request(server.app).get('/api/proof/nope')).status).toBe(404);
  });

  it('serves the local registry the checks were made against', async () => {
    await escalate();
    const zone = await request(server.app).get('/ans/dns/_ans-badge.careteam.aftercare.work');
    expect(zone.status).toBe(200);
    expect(JSON.stringify(zone.body)).toContain('ans-badge1');
  });
});

describe('content screening for a care-team escalation', () => {
  it('allows clinical detail and patient records language', () => {
    const result = screenEscalation('Post-discharge escalation for Miguel Alvarez: the incision is red and warm, fever overnight. Please review the medical records and advise on antibiotics today.');
    expect(result.decision).toBe('allow');
    expect(result.risk).toBe('low');
  });
  it('flags pressure language but still delivers', () => {
    const result = screenEscalation('Escalation: review today. This is a final warning.');
    expect(result.decision).toBe('allow');
    expect(result.signals.some(s => s.label === 'Pressure language')).toBe(true);
  });
  it('blocks credential, payment and remote-access requests', () => {
    expect(screenEscalation('Send me the six-digit verification code you received.').decision).toBe('block');
    expect(screenEscalation('Wire the money to this wallet before the visit.').decision).toBe('block');
    expect(screenEscalation('Install AnyDesk so I can open the chart remotely.').decision).toBe('block');
  });
});
