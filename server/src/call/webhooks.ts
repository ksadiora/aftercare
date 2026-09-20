import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { config } from "../config.ts";
import { audit } from "../store.ts";
import {
  addTranscript,
  advanceCallStatus,
  applyConversationStatus,
  applyTwilioStatus,
  bindProviderIds,
  callIdForCallSid,
  callIdForConversation,
  isCallFinished,
  syncTranscript,
} from "./provider.ts";
import type { ConversationStatus, ConversationTurn } from "./elevenlabs.ts";

/**
 * ELEVENLABS / TWILIO WEBHOOKS  (owner: Voice lane)
 *
 * Mounted at /api/webhooks.
 *  - POST /api/webhooks/elevenlabs      ElevenLabs post-call webhook
 *      https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
 *      Types handled: post_call_transcription (authoritative transcript + status),
 *      call_initiation_failure (→ failed). post_call_audio is acknowledged and dropped.
 *      Signature: header `ElevenLabs-Signature: t=<unix secs>,v0=<hex>` where
 *      v0 = HMAC-SHA256(secret, `${t}.${rawBody}`), 30 minute tolerance, any v0
 *      matching is accepted (secret rotation). Mirrors the SDK's constructEvent:
 *      https://github.com/elevenlabs/elevenlabs-js/blob/main/src/wrapper/webhooks.ts
 *  - POST /api/webhooks/twilio/status   Twilio StatusCallback (form-encoded CallSid, CallStatus)
 *      https://www.twilio.com/docs/voice/api/call-resource
 *
 * Webhooks never throw. Anything unexpected is logged and answered with a 2xx
 * so the provider does not retry, except a bad signature which is a 401.
 */
export const webhooksRouter = Router();

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

interface PostCallWebhook {
  type?: "post_call_transcription" | "post_call_audio" | "call_initiation_failure" | string;
  event_timestamp?: number;
  data?: {
    agent_id?: string;
    conversation_id?: string;
    status?: ConversationStatus;
    transcript?: ConversationTurn[];
    metadata?: {
      call_duration_secs?: number;
      termination_reason?: string;
      phone_call?: { call_sid?: string; [k: string]: unknown };
      [k: string]: unknown;
    };
    analysis?: { transcript_summary?: string; call_successful?: string };
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
    // call_initiation_failure
    failure_reason?: string;
    [k: string]: unknown;
  };
}

webhooksRouter.post("/elevenlabs", (req, res) => {
  try {
    const sig = verifyElevenLabsSignature(req);
    if (!sig.ok) {
      console.warn(`[webhook] elevenlabs rejected: ${sig.reason}`);
      return res.status(401).json({ ok: false, error: sig.reason });
    }

    const body = (req.body ?? {}) as PostCallWebhook;
    const data = body.data ?? {};
    const conversationId = data.conversation_id;
    const callId =
      callIdForConversation(conversationId) ??
      stringOrUndefined(data.conversation_initiation_client_data?.dynamic_variables?.callsign_call_id);

    if (!callId) {
      // Not one of ours (e.g. a test call from the ElevenLabs dashboard). Ack and move on.
      console.log(`[webhook] elevenlabs ${body.type ?? "?"} for unknown conversation ${conversationId ?? "?"}`);
      return res.json({ ok: true, ignored: true });
    }
    if (conversationId) bindProviderIds(callId, { conversationId, callSid: data.metadata?.phone_call?.call_sid });

    switch (body.type) {
      case "post_call_transcription": {
        const added = syncTranscript(callId, data.transcript);
        if (added > 0) advanceCallStatus(callId, "in-progress");
        applyConversationStatus(callId, data.status ?? "done", {
          error: data.metadata?.termination_reason ? `ElevenLabs: ${data.metadata.termination_reason}` : undefined,
        });
        if (!isCallFinished(callId)) advanceCallStatus(callId, "ended");
        const summary = data.analysis?.transcript_summary;
        audit("call", `Post-call webhook received (${data.metadata?.call_duration_secs ?? "?"} s)`, callId, {
          conversationId,
          summary,
          callSuccessful: data.analysis?.call_successful,
        });
        break;
      }
      case "call_initiation_failure": {
        const reason = data.failure_reason ?? "call could not be initiated";
        addTranscript(callId, { role: "system", text: `Call failed to connect: ${reason}` });
        advanceCallStatus(callId, "failed", { error: `ElevenLabs: ${reason}` });
        break;
      }
      case "post_call_audio":
        break; // we do not store audio
      default:
        console.log(`[webhook] elevenlabs unhandled type ${body.type ?? "?"} for ${callId}`);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("[webhook] elevenlabs handler error", (e as Error).message);
    return res.status(200).json({ ok: false, error: "handler error" });
  }
});

const SIGNATURE_TOLERANCE_MS = 30 * 60 * 1000;

function verifyElevenLabsSignature(req: Request): { ok: true } | { ok: false; reason: string } {
  const secret = config.calls.elevenLabsWebhookSecret;
  if (!secret) return { ok: true }; // not configured: accept (demo behind an unguessable tunnel URL)

  const header = req.get("elevenlabs-signature");
  if (!header) return { ok: false, reason: "missing ElevenLabs-Signature header" };

  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith("v0=")).map((p) => p.slice(3));
  if (!t || sigs.length === 0) return { ok: false, reason: "malformed ElevenLabs-Signature header" };

  const ts = Number(t) * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: "signature timestamp outside 30 minute window" };
  }

  // The HMAC is over the exact bytes ElevenLabs sent. express.json() has already
  // consumed the stream by the time we run, so we prefer a rawBody captured by a
  // `verify` hook in index.ts and fall back to re-serialising the parsed body,
  // which matches only when the sender emitted compact JSON. See docs/voice-setup.md.
  const raw = rawBodyOf(req) ?? JSON.stringify(req.body ?? {});
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const match = sigs.some((s) => {
    const buf = Buffer.from(s, "utf8");
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
  if (!match) {
    return {
      ok: false,
      reason: rawBodyOf(req) ? "signature mismatch" : "signature mismatch (raw body unavailable; add express.json verify hook, see docs/voice-setup.md)",
    };
  }
  return { ok: true };
}

function rawBodyOf(req: Request): string | undefined {
  const r = req as Request & { rawBody?: Buffer | string };
  if (r.rawBody === undefined) return undefined;
  return typeof r.rawBody === "string" ? r.rawBody : r.rawBody.toString("utf8");
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

// ---------------------------------------------------------------------------
// Twilio status callback (only fires if the ElevenLabs-owned call carries a
// StatusCallback, or a teammate points a Twilio number's status webhook here).
// Body is application/x-www-form-urlencoded; index.ts already parses it.
// ---------------------------------------------------------------------------

webhooksRouter.post("/twilio/status", (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const callSid = body.CallSid;
    const status = body.CallStatus;
    const callId = callIdForCallSid(callSid);
    if (!callId) {
      console.log(`[webhook] twilio status ${status ?? "?"} for unknown CallSid ${callSid ?? "?"}`);
      return res.sendStatus(204);
    }
    // Never log From/To: they are the judge's number.
    console.log(`[webhook] twilio ${status} for ${callId}`);
    applyTwilioStatus(callId, status);
    return res.sendStatus(204);
  } catch (e) {
    console.error("[webhook] twilio handler error", (e as Error).message);
    return res.sendStatus(204);
  }
});
