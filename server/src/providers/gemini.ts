import { setTimeout as delay } from "node:timers/promises";
import { ProviderError, providerHttpError, readProviderBody } from "./http.ts";

// Confirmed against https://ai.google.dev/gemini-api/docs/models on 2026-09-19.
const DEFAULT_MODEL = "gemini-3.8-flash";
const TIMEOUT_MS = 20_000;
const MAX_PROMPT_CHARACTERS = 48_000;

export interface GeminiRequest {
  systemInstruction: string;
  prompt: string;
  schema?: Record<string, unknown>;
}

/** Configuration is not a health check: no provider request is made here. */
export function getGeminiConfiguration() {
  return {
    configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export function isGeminiConfigured(): boolean {
  return getGeminiConfiguration().configured;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function generate(options: GeminiRequest, json: boolean): Promise<string> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new ProviderError("Gemini", "not_configured", "Gemini is not configured. Add GEMINI_API_KEY to the server environment.");
  if (!options.prompt.trim() || !options.systemInstruction.trim()
    || options.prompt.length + options.systemInstruction.length > MAX_PROMPT_CHARACTERS) {
    throw new ProviderError("Gemini", "invalid_input", "Gemini requires a nonempty prompt within the conversation size limit.");
  }
  const { model } = getGeminiConfiguration();
  const controller = new AbortController();
  const deadline = Date.now() + TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const send = () => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        generationConfig: {
          temperature: json ? 0.1 : 0.6,
          maxOutputTokens: 4096,
          // Gemini 3.8 supports low, medium, and high; minimal is unsupported.
          // https://ai.google.dev/gemini-api/docs/generate-content/thinking
          ...(model === DEFAULT_MODEL ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
          ...(json ? {
            responseMimeType: "application/json",
            ...(options.schema ? { responseJsonSchema: options.schema } : {}),
          } : {}),
        },
      }),
    });
    let response = await send();
    if (response.status === 503 && !controller.signal.aborted) {
      // One transient-service retry shares the original 20-second deadline.
      // https://ai.google.dev/gemini-api/docs/troubleshooting
      const retryAfter = response.headers.get("retry-after");
      const requestedDelay = retryAfter === null ? 0 : /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1_000
        : Date.parse(retryAfter) - Date.now();
      const retryDelay = Math.max(1_000 + Math.floor(Math.random() * 250), Number.isFinite(requestedDelay) ? requestedDelay : 0);
      if (deadline - Date.now() > retryDelay + 1_000) {
        await response.body?.cancel();
        await delay(retryDelay, undefined, { signal: controller.signal });
        response = await send();
      }
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw providerHttpError("Gemini", response.status);
    }
    const body = await readProviderBody(response, 1024 * 1024, "Gemini");
    let data: Record<string, unknown> | undefined;
    try {
      data = asRecord(JSON.parse(body.toString("utf8")) as unknown);
    } catch {
      throw new ProviderError("Gemini", "invalid_response", "Gemini returned an unreadable response.");
    }
    if (asRecord(data?.promptFeedback)?.blockReason) {
      throw new ProviderError("Gemini", "invalid_response", "Gemini declined this request; no assessment was generated.");
    }
    const candidate = Array.isArray(data?.candidates) ? asRecord(data.candidates[0]) : undefined;
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      throw new ProviderError("Gemini", "invalid_response", "Gemini did not complete its response; no assessment was generated.");
    }
    const parts = asRecord(candidate?.content)?.parts;
    const text = Array.isArray(parts)
      ? parts.map(asRecord).filter((part) => part && !part.thought)
        .map((part) => typeof part?.text === "string" ? part.text : "").join("").trim()
      : "";
    if (!text) throw new ProviderError("Gemini", "invalid_response", "Gemini returned no usable text.");
    return text;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted) throw new ProviderError("Gemini", "timeout", "Gemini timed out. Please retry the message.");
    throw new ProviderError("Gemini", "unavailable", "Gemini could not be reached. Please retry the message.");
  } finally {
    clearTimeout(timeout);
  }
}

export function generateGeminiText(options: GeminiRequest): Promise<string> {
  return generate(options, false);
}

/** Callers must validate the parsed value before making a screening decision. */
export async function generateGeminiJson<T = unknown>(options: GeminiRequest): Promise<T> {
  const text = await generate(options, true);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError("Gemini", "invalid_response", "Gemini returned invalid assessment JSON.");
  }
}
