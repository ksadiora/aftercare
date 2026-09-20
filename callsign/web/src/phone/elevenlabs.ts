import type { LabelLookupResponse, RequestSamplesResponse } from "@callsign/shared";
import { setExternalLevelSource } from "./audio.ts";
import type { CallView } from "./engine.ts";

/**
 * Optional real-time engine: when GET /api/phone/session returns a signed
 * ElevenLabs Agents URL, the phone talks to that agent directly (WebSocket,
 * mic in, audio out, barge-in). The agent's two tools run here as client
 * tools and hit this server over the LAN. The SDK is imported lazily so the
 * browser engine never pays for it.
 *
 * API used (from node_modules/@elevenlabs/client 1.25, dist/BaseConnection.d.ts):
 *   Conversation.startSession({ signedUrl, connectionType: "websocket",
 *     clientTools, onMessage({message, role}), onModeChange({mode}),
 *     onDisconnect(details), onError(message) })
 *   conversation.endSession()
 */

export interface ElevenLabsHandle {
  stop(): Promise<void>;
}

export interface ElevenLabsEvents {
  update(patch: Partial<CallView>): void;
  /** The agent or the network ended the session. */
  disconnected(): void;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json() as Promise<T>;
}

export async function startElevenLabs(signedUrl: string, ev: ElevenLabsEvents): Promise<ElevenLabsHandle> {
  const { Conversation } = await import("@elevenlabs/client");
  let closed = false;
  ev.update({ mic: "thinking", note: "Connecting to the voice agent…" });

  const conversation = await Conversation.startSession({
    signedUrl,
    connectionType: "websocket",
    clientTools: {
      label_lookup: async (p: { question?: string }) => {
        try {
          const out = await postJson<LabelLookupResponse>("/api/tools/label_lookup", { question: p?.question ?? "" });
          return JSON.stringify(out);
        } catch (e) {
          return JSON.stringify({ found: false, answer: "The label lookup is unavailable right now.", error: (e as Error).message });
        }
      },
      request_samples: async (p: { request?: string }) => {
        try {
          const out = await postJson<RequestSamplesResponse>("/api/tools/request_samples", { request: p?.request ?? "samples" });
          return JSON.stringify(out);
        } catch (e) {
          return JSON.stringify({ status: "failed", confirmation: "I couldn't file that request right now.", error: (e as Error).message });
        }
      },
    },
    onConnect: () => ev.update({ note: undefined }),
    onMessage: ({ message, role }) => {
      if (role === "agent") ev.update({ agentLine: message, interim: "" });
      else ev.update({ doctorLine: message, interim: "" });
    },
    onModeChange: ({ mode }) => ev.update({ mic: mode === "speaking" ? "speaking" : "listening" }),
    onError: (message) => ev.update({ note: message }),
    onDisconnect: () => {
      if (closed) return;
      closed = true;
      setExternalLevelSource(undefined);
      ev.disconnected();
    },
  });

  // The orb follows the SDK's own meters (0..1) instead of our analysers.
  setExternalLevelSource((kind) => {
    try {
      const v = kind === "playback" ? conversation.getOutputVolume() : conversation.getInputVolume();
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;
    } catch {
      return undefined;
    }
  });

  return {
    async stop() {
      if (closed) return;
      closed = true;
      setExternalLevelSource(undefined);
      try {
        await conversation.endSession();
      } catch {
        /* already gone */
      }
    },
  };
}
