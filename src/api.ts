/**
 * Not every response carries JSON. A proxy returning 502 while the app restarts,
 * a gateway timeout, an empty body — calling response.json() on any of those threw
 * "Unexpected end of JSON input", which tells the user nothing about what happened.
 * Read the body once as text, parse it only if it looks like JSON, and always fail
 * with a sentence that names the problem.
 */
/** Carries the status alongside the sentence, so a caller can tell "already over" from "broken". */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  const text = await response.text().catch(() => '');
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }

  if (!response.ok) {
    const message = (parsed as { error?: string } | undefined)?.error;
    throw new ApiError(message || serverMessage(response.status), response.status);
  }
  return parsed as T;
}

/** Used when the server said nothing useful, so the status is all we have. */
function serverMessage(status: number) {
  if (status === 401 || status === 403) return 'You are not signed in for that. Reload the page and sign in again.';
  if (status === 404) return 'That is no longer available. It may have ended or been reset.';
  if (status === 429) return 'Too many requests in a short time. Wait a moment and try again.';
  if (status === 502 || status === 503 || status === 504) return 'The server is restarting or unreachable. This usually clears in a few seconds.';
  return `The request could not be completed (${status}).`;
}
