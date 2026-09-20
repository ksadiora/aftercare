import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';

let store: Store;
let server: ReturnType<typeof createApp>;
const build = (trustedHosts: string[] = []) => { server?.close(); server = createApp(store, { trustedHosts, simulationDelay: 5 }); return server; };

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { server?.close(); store.close(); });

describe('host and origin policy', () => {
  it('keeps the localhost-only default when no hosts are configured', async () => {
    build();
    expect((await request(server.app).get('/api/dashboard')).status).toBe(200);
    expect((await request(server.app).get('/api/dashboard').set('Host', 'aftercare.example')).status).toBe(403);
    expect((await request(server.app).get('/api/dashboard').set('Host', 'evil.example')).body.error).toContain('localhost only');
  });

  it('answers for a configured deployment host', async () => {
    build(['app.aftercare.example']);
    expect((await request(server.app).get('/api/dashboard').set('Host', 'app.aftercare.example')).status).toBe(200);
    const refused = await request(server.app).get('/api/dashboard').set('Host', 'other.aftercare.example');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('not configured for this deployment');
  });

  it('requires https for a deployed origin and http for localhost', async () => {
    build(['app.aftercare.example']);
    const post = (host: string, origin: string) => request(server.app).post('/api/demo/reset').set('Host', host).set('Origin', origin).send({});
    expect((await post('app.aftercare.example', 'https://app.aftercare.example')).status).toBe(200);
    // The same host over plain http is refused even though the host is trusted.
    expect((await post('app.aftercare.example', 'http://app.aftercare.example')).status).toBe(403);
    // A trusted host cannot be used as an origin for a different host.
    expect((await post('app.aftercare.example', 'https://evil.example')).status).toBe(403);
    expect((await post('127.0.0.1', 'http://127.0.0.1')).status).toBe(200);
    expect((await post('127.0.0.1', 'https://127.0.0.1')).status).toBe(403);
  });

  it('still rejects cross-site requests and non-JSON mutations on a deployment', async () => {
    build(['app.aftercare.example']);
    const cross = await request(server.app).post('/api/demo/reset').set('Host', 'app.aftercare.example').set('Sec-Fetch-Site', 'cross-site').send({});
    expect(cross.status).toBe(403);
    const form = await request(server.app).post('/api/demo/reset').set('Host', 'app.aftercare.example').type('form').send('a=b');
    expect(form.status).toBe(415);
  });
});

describe('rate limits on provider-spending routes', () => {
  it('stops a runaway caller before it drains model quota', async () => {
    server?.close();
    server = createApp(store, { gemini: { apiKey: 'k' }, fetcher: vi.fn().mockResolvedValue(new Response('{}', { status: 500 })) as unknown as typeof fetch });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await request(server.app).post('/api/patients/alvarez/briefing/ask').send({ question: 'What happened here?' })).status);
    }
    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 20).every(s => s !== 429)).toBe(true);
  });

  it('does not rate limit ordinary dashboard reads', async () => {
    build();
    for (let i = 0; i < 40; i++) expect((await request(server.app).get('/api/dashboard')).status).toBe(200);
  });
});

describe('partner origin allowlist', () => {
  const partner = 'https://provider.partner.example';
  const withPartner = () => {
    server?.close();
    server = createApp(store, { trustedHosts: ['app.aftercare.work'], allowedOrigins: [partner] });
    return server;
  };

  it('changes nothing when it is empty, which is the default', async () => {
    build(['app.aftercare.work']);
    const refused = await request(server.app).get('/api/dashboard')
      .set('Host', 'app.aftercare.work').set('Origin', partner);
    expect(refused.status).toBe(403);
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets a named partner call the API from a browser', async () => {
    withPartner();
    const response = await request(server.app).get('/api/provider/queue')
      .set('Host', 'app.aftercare.work').set('Origin', partner).set('Sec-Fetch-Site', 'cross-site');
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(partner);
    expect(response.headers.vary).toContain('Origin');
  });

  it('answers the browser preflight', async () => {
    withPartner();
    const response = await request(server.app).options('/api/patients/johnson/provider-note')
      .set('Host', 'app.aftercare.work').set('Origin', partner);
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('never shares credentials across origins', async () => {
    withPartner();
    const response = await request(server.app).get('/api/provider/queue')
      .set('Host', 'app.aftercare.work').set('Origin', partner);
    // No Allow-Credentials: a partner authenticates itself, it cannot ride a session.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('still refuses an origin that is not on the list', async () => {
    withPartner();
    for (const origin of ['https://evil.example', 'https://provider.partner.example.evil.test', 'http://provider.partner.example']) {
      const response = await request(server.app).get('/api/dashboard')
        .set('Host', 'app.aftercare.work').set('Origin', origin);
      expect(response.status).toBe(403);
    }
  });

  it('leaves server-to-server callers alone, with or without the list', async () => {
    withPartner();
    expect((await request(server.app).get('/api/provider/queue').set('Host', 'app.aftercare.work')).status).toBe(200);
  });
});
