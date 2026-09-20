import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { ansCapability, parseAnsName, verifyCareTeam, type AnsConfig } from '../../server/ans';
import type { MediaConfig } from '../../server/handoff';

const media: MediaConfig = { apiKey: 'devkey', apiSecret: 'devsecret-for-tests-only', url: 'wss://rtc.example.test' };
const ENDPOINT = 'https://careteam.aftercare.example/api/handoff';
const ans: AnsConfig = { apiKey: 'ans-test-key', careTeamName: 'ans://v1.0.0.careteam.aftercare.example' };

const record = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  ansId: '8f1c0a1e-0000-4000-8000-000000000001',
  ansName: 'ans://v1.0.0.careteam.aftercare.example',
  agentHost: 'careteam.aftercare.example',
  status: 'ACTIVE',
  endpoints: [{ protocol: 'A2A', agentUrl: ENDPOINT }],
  ...overrides,
}));

let store: Store;
let server: ReturnType<typeof createApp>;
const build = (fetcher?: typeof fetch, config: AnsConfig = ans) => {
  server?.close();
  server = createApp(store, { media, ans: config, careTeamEndpoint: ENDPOINT, fetcher, ringMs: 45000 });
};
const ring = () => request(server.app).post('/api/patients/alvarez/handoff').send({ reason: 'Nurse requested a live conversation.' });

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { server?.close(); store.close(); });

describe('ANS name parsing and capability', () => {
  it('parses the versioned naming form from ANS-2', () => {
    expect(parseAnsName('ans://v1.0.0.careteam.aftercare.example')).toMatchObject({ version: '1.0.0', agentHost: 'careteam.aftercare.example' });
    expect(parseAnsName('ans://v2.15.3.intake.example.com')?.version).toBe('2.15.3');
  });

  it('rejects names that are not ANSNames', () => {
    for (const bad of ['careteam.example.com', 'ans://careteam.example.com', 'ans://v1.0.careteam.example.com', 'https://careteam.example.com', 'ans://v1.0.0.localhost']) {
      expect(parseAnsName(bad)).toBe(null);
    }
  });

  it('stays disabled, and says why, until both a key and a valid name are set', () => {
    expect(ansCapability({}).enabled).toBe(false);
    expect(ansCapability({}).reason).toContain('ANS_CARE_TEAM_NAME');
    expect(ansCapability({ careTeamName: 'not-an-ans-name', apiKey: 'k' }).reason).toContain('ans://v1.0.0');
    expect(ansCapability({ careTeamName: ans.careTeamName }).reason).toContain('ANS_API_KEY');
    expect(ansCapability(ans).enabled).toBe(true);
  });
});

describe('care-team verification', () => {
  const verify = (fetcher: typeof fetch, endpoint = ENDPOINT, config = ans) => verifyCareTeam(config, endpoint, fetcher);

  it('verifies a live record that lists the destination endpoint', async () => {
    const result = await verify(vi.fn().mockResolvedValue(record()) as unknown as typeof fetch);
    expect(result.verified).toBe(true);
    expect(result.detail).toContain('ACTIVE');
    expect(result.service).toBe(ans.careTeamName);
    expect(result.at).toMatch(/^\d{4}-/);
  });

  it('sends the API key as a bearer token and asks for the requested name', async () => {
    const fetcher = vi.fn().mockResolvedValue(record());
    await verify(fetcher as unknown as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(encodeURIComponent('ans://v1.0.0.careteam.aftercare.example'));
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ans-test-key');
  });

  it('rejects a record whose name or host does not match what was asked for', async () => {
    const wrongName = await verify(vi.fn().mockResolvedValue(record({ ansName: 'ans://v1.0.0.attacker.example' })) as unknown as typeof fetch);
    expect(wrongName.verified).toBe(false);
    expect(wrongName.detail).toContain('different agent name');

    const wrongHost = await verify(vi.fn().mockResolvedValue(record({ agentHost: 'attacker.example' })) as unknown as typeof fetch);
    expect(wrongHost.verified).toBe(false);
    expect(wrongHost.detail).toContain('does not match');
  });

  it('rejects an agent that is revoked, pending, or otherwise not active', async () => {
    for (const status of ['REVOKED', 'PENDING_DNS', 'EXPIRED', 'FAILED']) {
      const result = await verify(vi.fn().mockResolvedValue(record({ status })) as unknown as typeof fetch);
      expect(result.verified).toBe(false);
      expect(result.detail).toContain('not active');
    }
  });

  it('rejects a destination the registry does not list for this agent', async () => {
    const elsewhere = await verify(vi.fn().mockResolvedValue(record()) as unknown as typeof fetch, 'https://attacker.example/api/handoff');
    expect(elsewhere.verified).toBe(false);
    expect(elsewhere.detail).toContain('does not list');

    // A matching path on a different host is still a different destination.
    const lookalike = await verify(vi.fn().mockResolvedValue(record({ endpoints: [{ agentUrl: 'https://careteam.aftercare.example.attacker.test/api/handoff' }] })) as unknown as typeof fetch);
    expect(lookalike.verified).toBe(false);

    // So is the right host over the wrong scheme.
    const insecure = await verify(vi.fn().mockResolvedValue(record({ endpoints: [{ agentUrl: 'http://careteam.aftercare.example/api/handoff' }] })) as unknown as typeof fetch);
    expect(insecure.verified).toBe(false);
  });

  it('reports registry outages and bad keys as unverified, never as verified', async () => {
    const cases: [typeof fetch, string][] = [
      [vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch, 'could not be reached'],
      [vi.fn().mockResolvedValue(new Response('{}', { status: 404 })) as unknown as typeof fetch, 'no record'],
      [vi.fn().mockResolvedValue(new Response('{}', { status: 403 })) as unknown as typeof fetch, 'rejected the API key'],
      [vi.fn().mockResolvedValue(new Response('{}', { status: 500 })) as unknown as typeof fetch, 'HTTP 500'],
      [vi.fn().mockResolvedValue(new Response('not json')) as unknown as typeof fetch, 'unreadable'],
    ];
    for (const [fetcher, expected] of cases) {
      const result = await verify(fetcher);
      expect(result.verified).toBe(false);
      expect(result.detail).toContain(expected);
    }
  });

  it('is unverified, not verified, when ANS is not configured at all', async () => {
    const result = await verifyCareTeam({}, ENDPOINT, vi.fn() as unknown as typeof fetch);
    expect(result.verified).toBe(false);
  });
});

describe('handoff gating on verification', () => {
  it('records the verification on the handoff when the service checks out', async () => {
    build(vi.fn().mockResolvedValue(record()) as unknown as typeof fetch);
    const response = await ring();
    expect(response.status).toBe(201);
    expect(response.body.state).toBe('requested');
    expect(response.body.verification).toMatchObject({ verified: true, service: ans.careTeamName });
    expect(store.detail('alvarez').audit.some(a => a.kind === 'handoff_verification' && a.text.startsWith('Verified'))).toBe(true);
  });

  it('refuses the handoff and keeps a callback task when verification fails', async () => {
    build(vi.fn().mockResolvedValue(record({ agentHost: 'attacker.example' })) as unknown as typeof fetch);
    const response = await ring();
    expect(response.status).toBe(502);
    expect(response.body.error).toContain('No patient context was sent.');
    // Nothing is left ringing, and the case still demands a nurse.
    expect(store.activeHandoff()).toBe(null);
    expect(store.patient('alvarez').action).toBe('Nurse callback requested');
    const audit = store.detail('alvarez').audit;
    expect(audit.some(a => a.kind === 'handoff_verification' && a.text.startsWith('Rejected'))).toBe(true);
    expect(audit.some(a => a.kind === 'handoff_failed')).toBe(true);
  });

  it('proceeds with verification marked unavailable when ANS is not configured', async () => {
    const fetcher = vi.fn();
    build(fetcher as unknown as typeof fetch, {});
    const response = await ring();
    expect(response.status).toBe(201);
    // Never fabricated: absent, not true.
    expect(response.body.verification).toBe(null);
    expect(fetcher).not.toHaveBeenCalled();
    const capabilities = await request(server.app).get('/api/capabilities');
    expect(capabilities.body.ans).toBe(false);
  });

  it('exposes the configured care-team name through capabilities', async () => {
    build(vi.fn().mockResolvedValue(record()) as unknown as typeof fetch);
    const { body } = await request(server.app).get('/api/capabilities');
    expect(body).toMatchObject({ ans: true, careTeam: ans.careTeamName });
    expect(body.ansReason).toContain('ANS');
  });
});
