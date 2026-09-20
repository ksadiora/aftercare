import type { DeskSession, DeskStreamEvent } from "@callsign/shared/src/desk.ts";

/** Request-scoped progress prevents unrelated sessions from sharing transcripts. */
export async function streamContact(path: string, body: unknown, onProgress: (session: DeskSession) => void, signal: AbortSignal): Promise<DeskSession> {
  const response = await fetch(`/api/desk${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error ?? "The request could not be verified.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Live verification is unavailable. No delivery was confirmed.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Verification was interrupted. Reload to check the session before retrying.");
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6)) as DeskStreamEvent;
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "complete") return event.session;
        onProgress(event.session);
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
