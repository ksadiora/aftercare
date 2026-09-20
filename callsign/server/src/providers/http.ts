/** Provider errors deliberately exclude upstream bodies, request text, and keys. */
export class ProviderError extends Error {
  constructor(
    public readonly provider: "Gemini" | "ElevenLabs",
    public readonly code: "not_configured" | "invalid_input" | "timeout" | "unavailable" | "invalid_response",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Bound the actual streamed bytes, even when Content-Length is absent. */
export async function readProviderBody(
  response: Response,
  maxBytes: number,
  provider: "Gemini" | "ElevenLabs",
): Promise<Buffer> {
  if (!response.body) throw new ProviderError(provider, "invalid_response", `${provider} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ProviderError(provider, "invalid_response", `${provider} returned a response larger than allowed.`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

export function providerHttpError(provider: "Gemini" | "ElevenLabs", status: number): ProviderError {
  const detail = status === 401 || status === 403
    ? "Check the server API key and its permissions."
    : status === 429
      ? "The provider's rate limit or quota was reached."
      : status === 404
        ? "Check the configured model or voice ID."
        : "The provider could not complete the request.";
  return new ProviderError(provider, "unavailable", `${provider} returned HTTP ${status}. ${detail}`, status);
}
