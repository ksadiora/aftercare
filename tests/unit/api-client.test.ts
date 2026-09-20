import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/api';

const respond = (body: string, init: ResponseInit = {}) => vi.fn(async () => new Response(body, init));
afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('parses a normal JSON response', async () => {
    vi.stubGlobal('fetch', respond(JSON.stringify({ ok: true })));
    await expect(api('/health')).resolves.toEqual({ ok: true });
  });

  it('does not choke on an empty body', async () => {
    // Regression: this threw "Unexpected end of JSON input" at the user.
    vi.stubGlobal('fetch', respond('', { status: 200 }));
    await expect(api('/thing')).resolves.toBeUndefined();
  });

  it('explains a proxy error instead of a parse error', async () => {
    vi.stubGlobal('fetch', respond('<html>502 Bad Gateway</html>', { status: 502 }));
    await expect(api('/thing')).rejects.toThrow(/restarting or unreachable/);
  });

  it('still prefers the server error message when there is one', async () => {
    vi.stubGlobal('fetch', respond(JSON.stringify({ error: 'Add a note before resolving.' }), { status: 400 }));
    await expect(api('/thing')).rejects.toThrow('Add a note before resolving.');
  });

  it('names the common failures in plain language', async () => {
    for (const [status, text] of [[401, /signed in/], [404, /no longer available/], [429, /Too many requests/], [504, /restarting or unreachable/]] as const) {
      vi.stubGlobal('fetch', respond('', { status }));
      await expect(api('/thing')).rejects.toThrow(text);
    }
  });

  it('falls back to the status when nothing else is known', async () => {
    vi.stubGlobal('fetch', respond('not json at all', { status: 418 }));
    await expect(api('/thing')).rejects.toThrow(/\(418\)/);
  });

  it('sends a POST with JSON when given a body', async () => {
    const fetcher = respond(JSON.stringify({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await api('/thing', { a: 1 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/thing');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
  });
});
