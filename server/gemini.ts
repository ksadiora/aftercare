import { AppError } from './store.js';

export interface GeminiConfig { apiKey?: string; model?: string; briefingModel?: string; endpoint?: string }
export interface GeminiMeta { model: string; promptTokens: number; responseTokens: number; latencyMs: number }
export interface GeminiResult<T> { value: T; meta: GeminiMeta }
// Gemini accepts a subset of OpenAPI schema. Kept structural on purpose: meaning is
// checked by the caller, because a schema-valid object can still be clinically wrong.
export type Schema = { type: string; properties?: Record<string, Schema>; items?: Schema; enum?: string[]; required?: string[]; nullable?: boolean; description?: string };

const DEFAULT_MODEL = 'gemini-flash-lite-latest';
const DEFAULT_BRIEFING_MODEL = 'gemini-3.6-flash';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
// The ElevenLabs get_next_step client tool times out at 10s. Stay inside it so a slow
// model surfaces as our own explicit failure rather than a dropped voice turn.
export const GEMINI_TIMEOUT_MS = 8000;

export const geminiModel = (config: GeminiConfig) => config.model || DEFAULT_MODEL;
/** The briefing is not inside a voice turn, so it can afford a slower, stronger model. */
export const briefingModel = (config: GeminiConfig) => config.briefingModel || DEFAULT_BRIEFING_MODEL;
export function geminiCapability(config: GeminiConfig) {
  return {
    enabled: Boolean(config.apiKey),
    model: geminiModel(config),
    reason: config.apiKey
      ? `Conversational intelligence · ${geminiModel(config)}`
      : 'Add GEMINI_API_KEY to .env for adaptive follow-up questions. Scripted intake works now.',
  };
}

export async function generateJson<T>(
  config: GeminiConfig,
  request: { system: string; user: string; schema: Schema; timeoutMs?: number; model?: string },
  fetcher: typeof fetch = fetch,
): Promise<GeminiResult<T>> {
  if (!config.apiKey) throw new AppError(503, geminiCapability(config).reason);
  const ready = config as GeminiConfig & { apiKey: string };
  // Capacity 503s come back in milliseconds, while a slow generation consumes the
  // whole budget. So each attempt gets whatever time is LEFT rather than a fixed
  // slice: a fast failure is retried, and a genuinely slow call is never cut short
  // to reserve time for a retry it has not earned.
  const deadline = Date.now() + (request.timeoutMs ?? GEMINI_TIMEOUT_MS);
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now();
    try { return await attemptOnce<T>(ready, request, fetcher, remaining); }
    catch (thrown) {
      const failure = thrown as { error?: AppError; retryable?: boolean };
      if (!failure?.error) throw thrown;
      const left = deadline - Date.now() - BACKOFF_MS;
      if (!failure.retryable || attempt >= ATTEMPTS || left < MIN_ATTEMPT_MS) throw failure.error;
      await new Promise(resolve => setTimeout(resolve, BACKOFF_MS));
    }
  }
}

const ATTEMPTS = 2;
const BACKOFF_MS = 400;
// Below this there is not enough budget left for a retry to plausibly succeed.
const MIN_ATTEMPT_MS = 2000;
const fail = (status: number, message: string, retryable = false) => ({ error: new AppError(status, message), retryable });

async function attemptOnce<T>(
  config: GeminiConfig & { apiKey: string },
  request: { system: string; user: string; schema: Schema; model?: string },
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<GeminiResult<T>> {
  const model = request.model || geminiModel(config);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(`${config.endpoint || DEFAULT_ENDPOINT}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: request.schema, temperature: 0, candidateCount: 1 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw fail(504, 'The language model did not respond in time. The scripted question was used instead.', true);
  }
  if (!response.ok) throw providerError(response.status);
  const data = await response.json().catch(() => undefined);
  const candidate = data?.candidates?.[0];
  if (data?.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') throw fail(502, 'The language model declined to answer. The scripted question was used instead.');
  if (candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw fail(502, 'The language model returned an unusable response. The scripted question was used instead.');
  // Thinking models return a reasoning part alongside the answer; only the answer is JSON.
  const text = (candidate?.content?.parts || [])
    .filter((p: { thought?: boolean }) => !p.thought)
    .map((p: { text?: string }) => p.text || '').join('') || '';
  let value: T;
  try { value = JSON.parse(text) as T; }
  catch { throw fail(502, 'The language model returned malformed output. The scripted question was used instead.'); }
  if (!value || typeof value !== 'object') throw fail(502, 'The language model returned malformed output. The scripted question was used instead.');
  return {
    value,
    meta: {
      model: String(data?.modelVersion || model),
      promptTokens: Number(data?.usageMetadata?.promptTokenCount || 0),
      responseTokens: Number(data?.usageMetadata?.candidatesTokenCount || 0),
      latencyMs: Date.now() - started,
    },
  };
}

function providerError(status: number) {
  if (status === 400) return fail(502, 'The language model rejected the request. The scripted question was used instead.');
  if (status === 401 || status === 403) return fail(503, 'Google AI rejected the credentials. Check GEMINI_API_KEY. Scripted intake still works.');
  if (status === 404) return fail(503, `The configured Gemini model is unavailable to this key. Set GEMINI_MODEL to a model your key can use (models released before mid-2025, such as gemini-2.5-flash, are refused for keys issued since).`);
  if (status === 429) return fail(503, 'Gemini quota is exhausted. Scripted intake still works.');
  // Google returns this when a model is temporarily oversubscribed.
  if (status === 503) return fail(503, 'The language model is temporarily oversubscribed. The scripted question was used instead.', true);
  return fail(502, 'Google AI is unavailable. The scripted question was used instead.', status >= 500);
}
