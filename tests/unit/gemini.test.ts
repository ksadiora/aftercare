import { describe, expect, it, vi } from 'vitest';
import { briefingModel, geminiCapability, generateJson, type Schema } from '../../server/gemini';

const schema: Schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
const ask = (fetcher: typeof fetch, apiKey = 'test-key') => generateJson<{ reply: string }>({ apiKey }, { system: 's', user: 'u', schema }, fetcher);
const reply = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
const ok = (payload: unknown, extra: Record<string, unknown> = {}) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(payload) }] } }], ...extra });

describe('gemini client', () => {
  it('reports unavailability without a key and never invents a model claim', () => {
    expect(geminiCapability({})).toMatchObject({ enabled: false });
    expect(geminiCapability({}).reason).toContain('GEMINI_API_KEY');
    expect(geminiCapability({ apiKey: 'k' })).toMatchObject({ enabled: true, model: 'gemini-flash-lite-latest' });
    expect(geminiCapability({ apiKey: 'k', model: 'gemini-2.0-flash' }).model).toBe('gemini-2.0-flash');
  });

  it('uses a fast model in the voice turn and a stronger one for the briefing', () => {
    // A clarification runs inside a turn bounded by the 10s ElevenLabs tool timeout.
    expect(geminiCapability({ apiKey: 'k' }).model).toBe('gemini-flash-lite-latest');
    expect(briefingModel({ apiKey: 'k' })).toBe('gemini-3.6-flash');
    expect(briefingModel({ apiKey: 'k', briefingModel: 'gemini-3.1-pro-preview' })).toBe('gemini-3.1-pro-preview');
  });

  it('sends the per-request model override when one is given', async () => {
    const fetcher = reply(ok({ reply: 'x' }));
    await generateJson({ apiKey: 'k' }, { system: 's', user: 'u', schema, model: 'gemini-3.6-flash' }, fetcher);
    expect((fetcher.mock.calls[0] as [string])[0]).toContain('gemini-3.6-flash:generateContent');
  });

  it('refuses to call the provider with no key configured', async () => {
    const fetcher = vi.fn();
    await expect(ask(fetcher, '')).rejects.toThrow('GEMINI_API_KEY');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns parsed output plus model metadata for demo evidence', async () => {
    const fetcher = reply(ok({ reply: 'hello' }, { modelVersion: 'gemini-2.5-flash-001', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } }));
    const result = await ask(fetcher);
    expect(result.value.reply).toBe('hello');
    expect(result.meta).toMatchObject({ model: 'gemini-2.5-flash-001', promptTokens: 12, responseTokens: 3 });
    expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the key as a header and requests schema-constrained JSON', async () => {
    const fetcher = reply(ok({ reply: 'x' }));
    await ask(fetcher, 'secret-key');
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('gemini-flash-lite-latest:generateContent');
    expect(url).not.toContain('secret-key');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
    expect(JSON.parse(String(init.body)).generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0 });
  });

  it('maps credential, quota, and model errors without leaking the key', async () => {
    await expect(ask(reply('secret-key leaked in body', 401), 'secret-key')).rejects.toThrow(/credentials/);
    await expect(ask(reply({}, 429))).rejects.toThrow(/quota/);
    await expect(ask(reply({}, 404))).rejects.toThrow(/GEMINI_MODEL/);
    await expect(ask(reply({}, 400))).rejects.toThrow(/rejected the request/);
    await expect(ask(reply('secret-key', 401), 'secret-key').catch(e => e.message)).resolves.not.toContain('secret-key');
  });

  it('retries a temporary capacity failure once, then gives up honestly', async () => {
    // Google returns 503 when a model is oversubscribed; this is common in practice.
    const recovers = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok({ reply: 'second attempt' }))));
    const result = await ask(recovers as unknown as typeof fetch);
    expect(recovers).toHaveBeenCalledTimes(2);
    expect(result.value.reply).toBe('second attempt');

    const persists = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(ask(persists as unknown as typeof fetch)).rejects.toThrow(/oversubscribed/);
    expect(persists).toHaveBeenCalledTimes(2);
  });

  it('does not retry a credential, quota, or model error', async () => {
    for (const status of [401, 404, 429, 400]) {
      const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status }));
      await expect(ask(fetcher as unknown as typeof fetch)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('reads the answer from a thinking model and ignores its reasoning part', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, text: 'Internal reasoning that is not JSON at all.' },
        { text: JSON.stringify({ reply: 'clean' }), thoughtSignature: 'abc123' },
      ] } }],
      modelVersion: 'gemini-3.6-flash',
    })));
    const result = await ask(fetcher as unknown as typeof fetch);
    expect(result.value.reply).toBe('clean');
  });

  it('treats a timeout as an explicit failure, never as an answer', async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(ask(fetcher)).rejects.toThrow(/did not respond in time/);
  });

  it('rejects blocked, truncated, and malformed responses instead of guessing', async () => {
    await expect(ask(reply({ promptFeedback: { blockReason: 'SAFETY' } }))).rejects.toThrow(/declined/);
    await expect(ask(reply({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }))).rejects.toThrow(/declined/);
    await expect(ask(reply({ candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] }))).rejects.toThrow(/unusable/);
    await expect(ask(reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{not json' }] } }] }))).rejects.toThrow(/malformed/);
    await expect(ask(reply({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '"a string"' }] } }] }))).rejects.toThrow(/malformed/);
    await expect(ask(reply({ candidates: [] }))).rejects.toThrow(/malformed/);
  });
});

describe('retry budget', () => {
  const slowThenOk = (firstDelayMs: number) => {
    let call = 0;
    return vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) {
        // Emulate a slow generation that consumes most of the budget.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, firstDelayMs);
          init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'TimeoutError')); });
        });
        return new Response('{}', { status: 503 });
      }
      return new Response(JSON.stringify(ok({ reply: 'recovered' })));
    });
  };

  it('gives the first attempt the whole budget rather than a reserved slice', async () => {
    // A 3.8s call must succeed inside an 8s budget; an even split would abort it.
    const fetcher = vi.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 3800));
      return new Response(JSON.stringify(ok({ reply: 'slow but fine' })));
    });
    const result = await generateJson<{ reply: string }>({ apiKey: 'k' }, { system: 's', user: 'u', schema }, fetcher as unknown as typeof fetch);
    expect(result.value.reply).toBe('slow but fine');
    expect(fetcher).toHaveBeenCalledTimes(1);
  }, 15000);

  it('retries a fast failure because budget remains', async () => {
    const fetcher = slowThenOk(50);
    const result = await generateJson<{ reply: string }>({ apiKey: 'k' }, { system: 's', user: 'u', schema }, fetcher as unknown as typeof fetch);
    expect(result.value.reply).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  }, 15000);

  it('does not retry when the budget is already spent', async () => {
    const fetcher = slowThenOk(5000);
    await expect(generateJson({ apiKey: 'k' }, { system: 's', user: 'u', schema, timeoutMs: 5200 }, fetcher as unknown as typeof fetch)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }, 15000);
});
