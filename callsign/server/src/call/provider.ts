import type { CallState, ReachRequest, TranscriptLine } from "@callsign/shared";
import { maskPhone } from "@callsign/shared";
import { config, effectiveModes } from "../config.ts";
import { id, nowIso } from "../events.ts";
import { doctor, brandIdentity } from "../seed/data.ts";
import { upsertCall, getCall, getRequest, audit } from "../store.ts";
import { evaluatePolicy } from "../policy.ts";
import { bindCallerCall } from "./caller.ts";
import { emit } from "../events.ts";
import {
  ElevenLabsError,
  getConversation,
  getTwilioCallStatus,
  outboundCall,
  twilioConfigured,
  type ConversationStatus,
  type ConversationTurn,
  type TwilioCallStatus,
} from "./elevenlabs.ts";

/**
 * CALL PROVIDER  (owner: Voice lane)
 *
 * placeCall() starts an outbound call to the doctor for a verified request.
 * Mock mode simulates dialing → ringing → in-progress with a scripted
 * transcript so the screen works without any keys. Real mode places the call
 * through ElevenLabs Agents over an imported Twilio number
 * (https://elevenlabs.io/docs/api-reference/twilio/outbound-call), then keeps
 * the screen in sync from three sources, any of which may arrive first:
 *
 *   1. a poller on GET /v1/convai/conversations/{id} (works with no public URL)
 *   2. the ElevenLabs post-call webhook  (call/webhooks.ts, authoritative transcript)
 *   3. the Twilio status callback         (call/webhooks.ts, ringing/answered/completed)
 *
 * Status only ever moves forward: queued → dialing → ringing → in-progress → ended | failed.
 * The phone number is never logged; every log line uses the masked `call.to`.
 */

export interface CallVariables {
  doctor_name: string;
  brand: string;
  update_summary: string;
  affected_patients: string;
  specialty: string;
}

export function variablesFor(req: ReachRequest): CallVariables {
  return {
    doctor_name: doctor.name,
    brand: req.claimedDisplayName || brandIdentity.displayName,
    update_summary: req.payload.summary,
    affected_patients: String(req.payload.affectedPatients ?? doctor.patientsOnBrand),
    specialty: doctor.specialty,
  };
}

/** Variables for every call we placed, keyed by callId (used by the Twilio TwiML routes). */
const varsByCall = new Map<string, CallVariables>();
export function callVariables(callId: string): CallVariables | undefined {
  return varsByCall.get(callId);
}

export async function placeCall(req: ReachRequest, toE164: string): Promise<CallState> {
  const call: CallState = {
    id: id("call"),
    requestId: req.id,
    to: config.calls.provider === "app" ? "Dr. Patel's phone" : maskPhone(toE164),
    provider: effectiveModes().calls === "mock" ? "mock" : config.calls.provider,
    callerName: req.claimedDisplayName,
    callerAgent: req.from,
    status: "queued",
    mock: effectiveModes().calls === "mock",
    transcript: [],
    startedAt: nowIso(),
  };
  upsertCall(call);
  varsByCall.set(call.id, variablesFor(req));
  bindCallerCall(req.id, call.id); // no-op unless a human caller started this request
  audit("call", `Placing call to ${call.to} for ${req.claimedDisplayName}`, call.id);

  if (call.mock) {
    void runMockCall(call.id, variablesFor(req));
  } else if (config.calls.provider === "app") {
    void import("./app.ts").then((m) => m.placeCallApp(call.id, variablesFor(req)));
  } else if (config.calls.provider === "twilio") {
    void import("./twilio.ts").then((m) => m.placeCallTwilio(call.id, toE164, variablesFor(req)));
  } else {
    void placeCallReal(call.id, toE164, variablesFor(req));
  }
  return call;
}

export function addTranscript(callId: string, line: Omit<TranscriptLine, "ts">) {
  const call = getCall(callId);
  if (!call) return;
  const full: TranscriptLine = { ...line, ts: nowIso() };
  call.transcript.push(full);
  emit({ type: "call.transcript", callId, line: full });
  upsertCall(call);
}

export function setCallStatus(callId: string, status: CallState["status"], extra: Partial<CallState> = {}) {
  const call = getCall(callId);
  if (!call) return;
  Object.assign(call, extra, { status });
  if (status === "ended" || status === "failed") call.endedAt = nowIso();
  upsertCall(call);
  audit("call", `Call ${status}`, callId);
}

// ---------------------------------------------------------------------------
// Provider id <-> our callId. The webhooks only know the ElevenLabs
// conversation_id or the Twilio CallSid; these maps get them back to a call.
// ---------------------------------------------------------------------------

const byConversation = new Map<string, string>();
const byCallSid = new Map<string, string>();
/** How many ElevenLabs transcript turns we have already pushed for a call (dedupes poller vs webhook). */
const syncedTurns = new Map<string, number>();

export function bindProviderIds(callId: string, ids: { conversationId?: string | null; callSid?: string | null }) {
  if (ids.conversationId) byConversation.set(ids.conversationId, callId);
  if (ids.callSid) byCallSid.set(ids.callSid, callId);
}
export function callIdForConversation(conversationId: string | undefined | null): string | undefined {
  return conversationId ? byConversation.get(conversationId) : undefined;
}
export function callIdForCallSid(callSid: string | undefined | null): string | undefined {
  return callSid ? byCallSid.get(callSid) : undefined;
}

const RANK: Record<CallState["status"], number> = { queued: 0, dialing: 1, ringing: 2, "in-progress": 3, ended: 4, failed: 4 };

/** Like setCallStatus but never moves backwards and never re-ends a finished call. */
export function advanceCallStatus(callId: string, status: CallState["status"], extra: Partial<CallState> = {}): boolean {
  const call = getCall(callId);
  if (!call) return false;
  if (RANK[status] <= RANK[call.status]) return false;
  setCallStatus(callId, status, extra);
  return true;
}

export function isCallFinished(callId: string): boolean {
  const s = getCall(callId)?.status;
  return s === "ended" || s === "failed";
}

/** A call's initial approval does not override a later hangup or policy change. */
export function callDeliveryAllowed(callId: string): boolean {
  const call = getCall(callId);
  if (!call || isCallFinished(callId)) return false;
  const request = getRequest(call.requestId);
  const policy = evaluatePolicy({ specialty: request?.payload.specialty, doctorSpecialty: doctor.specialty, hasReceipt: true });
  if (!request || !policy.ok) {
    setCallStatus(callId, "ended", { endReason: "declined", error: request ? policy.detail : "Verified request is no longer available." });
    return false;
  }
  return true;
}

/**
 * Push any ElevenLabs transcript turns we have not shown yet. Both the poller
 * and the post-call webhook call this with the full turn list, so a turn is
 * only emitted once. Turns without a message (tool-call-only) are skipped but
 * still counted so indexes stay aligned.
 */
export function syncTranscript(callId: string, turns: ConversationTurn[] | undefined | null): number {
  if (!turns || !getCall(callId)) return 0;
  const seen = syncedTurns.get(callId) ?? 0;
  let added = 0;
  for (let i = seen; i < turns.length; i++) {
    const t = turns[i];
    const text = (t.message ?? "").trim();
    if (text) {
      addTranscript(callId, { role: t.role === "agent" ? "agent" : "doctor", text });
      added++;
    }
  }
  if (turns.length > seen) syncedTurns.set(callId, turns.length);
  return added;
}

/** Map an ElevenLabs conversation status onto our status flow. */
export function applyConversationStatus(callId: string, status: ConversationStatus | undefined, extra: Partial<CallState> = {}) {
  switch (status) {
    case "in-progress":
      advanceCallStatus(callId, "in-progress", extra);
      break;
    case "processing":
    case "done":
      advanceCallStatus(callId, "ended", extra);
      break;
    case "failed":
      advanceCallStatus(callId, "failed", { error: extra.error ?? "ElevenLabs reported the conversation failed", ...extra });
      break;
    default:
      break; // "initiated" or unknown: leave whatever we have
  }
}

/** Map a Twilio call status (callback or poll) onto our status flow. */
export function applyTwilioStatus(callId: string, status: TwilioCallStatus | string | undefined) {
  switch (status) {
    case "ringing":
      advanceCallStatus(callId, "ringing");
      break;
    case "in-progress":
      advanceCallStatus(callId, "in-progress");
      break;
    case "completed":
      advanceCallStatus(callId, "ended");
      break;
    case "busy":
    case "no-answer":
    case "canceled":
    case "failed":
      advanceCallStatus(callId, "failed", { error: `Twilio: ${status}` });
      break;
    default:
      break;
  }
}

// ---- REAL -------------------------------------------------------------------
export async function placeCallReal(callId: string, toE164: string, vars: CallVariables): Promise<void> {
  const masked = maskPhone(toE164);
  const { elevenLabsAgentId, elevenLabsPhoneNumberId } = config.calls;
  if (!config.calls.elevenLabsApiKey || !elevenLabsAgentId || !elevenLabsPhoneNumberId) {
    setCallStatus(callId, "failed", { error: "CALLS_MODE=real needs ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID and ELEVENLABS_PHONE_NUMBER_ID" });
    return;
  }

  setCallStatus(callId, "dialing");
  console.log(`[call] dialing ${masked} via ElevenLabs agent ${elevenLabsAgentId} (call ${callId})`);

  let conversationId: string | null;
  let callSid: string | null;
  try {
    // Dynamic variables land in the agent's prompt/first message as {{doctor_name}} etc.
    // https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables
    const res = await outboundCall({
      agent_id: elevenLabsAgentId,
      agent_phone_number_id: elevenLabsPhoneNumberId,
      to_number: toE164,
      conversation_initiation_client_data: {
        dynamic_variables: { ...vars, callsign_call_id: callId },
      },
      telephony_call_config: { ringing_timeout_secs: 30 },
    });
    if (!res.success) {
      setCallStatus(callId, "failed", { error: `ElevenLabs refused the call: ${res.message || "no reason given"}` });
      return;
    }
    conversationId = res.conversation_id;
    callSid = res.callSid;
  } catch (e) {
    const msg = e instanceof ElevenLabsError ? e.message : (e as Error).message;
    setCallStatus(callId, "failed", { error: oneLine(msg) });
    console.error(`[call] ${callId} failed: ${oneLine(msg)}`);
    return;
  }

  bindProviderIds(callId, { conversationId, callSid });
  // ElevenLabs does not report "ringing" separately: the API accepting the call
  // is the closest signal. Twilio (callback or poll) refines it if available.
  advanceCallStatus(callId, "ringing", { providerCallId: conversationId ?? callSid ?? undefined });
  addTranscript(callId, { role: "system", text: `Ringing ${masked} via ElevenLabs Agents` });
  console.log(`[call] ${callId} accepted: conversation=${conversationId ?? "?"} sid=${callSid ?? "?"}`);

  if (conversationId) void pollConversation(callId, conversationId, callSid);
}

const POLL_MS = Number(process.env.ELEVENLABS_POLL_MS?.trim() || 2000);
const POLL_MAX_MS = 15 * 60 * 1000;

/**
 * Keep the screen live without depending on a public webhook URL: read the
 * conversation every couple of seconds, push new turns, follow the status.
 * Stops as soon as the call is finished by any source.
 */
async function pollConversation(callId: string, conversationId: string, callSid: string | null) {
  const started = Date.now();
  let consecutiveErrors = 0;
  let sawTwilioAnswer = false;
  while (!isCallFinished(callId) && Date.now() - started < POLL_MAX_MS) {
    await sleep(POLL_MS);
    if (isCallFinished(callId)) break;

    // Twilio gives us ringing → in-progress precisely, when credentials are set.
    if (callSid && twilioConfigured() && !sawTwilioAnswer) {
      const ts = await getTwilioCallStatus(callSid);
      if (ts === "in-progress" || ts === "completed") sawTwilioAnswer = true;
      applyTwilioStatus(callId, ts);
      if (isCallFinished(callId)) break;
    }

    try {
      const conv = await getConversation(conversationId);
      consecutiveErrors = 0;
      const added = syncTranscript(callId, conv.transcript);
      // The first transcript turn means someone answered, even if Twilio can't tell us.
      if (added > 0) advanceCallStatus(callId, "in-progress");
      applyConversationStatus(callId, conv.status, {
        error: conv.metadata?.termination_reason ? `ElevenLabs: ${conv.metadata.termination_reason}` : undefined,
      });
    } catch (e) {
      consecutiveErrors++;
      const msg = oneLine((e as Error).message);
      if (e instanceof ElevenLabsError && e.status === 404) {
        // Conversation not materialised yet (call still connecting); keep waiting a while.
        if (consecutiveErrors > 20) {
          advanceCallStatus(callId, "failed", { error: "ElevenLabs never created the conversation (did Twilio reject the call?)" });
        }
        continue;
      }
      console.warn(`[call] ${callId} poll error (${consecutiveErrors}): ${msg}`);
      if (consecutiveErrors >= 10) {
        console.warn(`[call] ${callId} giving up polling; waiting for the post-call webhook`);
        return;
      }
    }
  }
  if (!isCallFinished(callId)) {
    advanceCallStatus(callId, "ended");
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ---- MOCK ------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runMockCall(callId: string, vars: CallVariables) {
  await sleep(600);
  if (!callDeliveryAllowed(callId)) return;
  advanceCallStatus(callId, "dialing");
  await sleep(1200);
  if (!callDeliveryAllowed(callId)) return;
  advanceCallStatus(callId, "ringing");
  addTranscript(callId, { role: "system", text: `Ringing ${getCall(callId)?.to} (mock)` });
  await sleep(2500);
  if (!callDeliveryAllowed(callId)) return;
  advanceCallStatus(callId, "in-progress");
  addTranscript(callId, {
    role: "agent",
    text: `${vars.doctor_name}, this is the verified ${vars.brand} agent. ${vars.update_summary} ${vars.affected_patients} of your patients are affected. Want the one-line change, or should I send it to your inbox?`,
  });
  await sleep(3500);
  if (!callDeliveryAllowed(callId)) return;
  addTranscript(callId, { role: "doctor", text: "Give me the one-liner. And send samples for Tuesday." });
  await sleep(1500);
  if (!callDeliveryAllowed(callId)) return;
  addTranscript(callId, {
    role: "agent",
    text: "Below eGFR 45, drop to 5 mg once daily and recheck renal function every three months. Requesting samples for Tuesday now.",
  });
  // The real flow: ElevenLabs calls POST /api/tools/request_samples here.
  await sleep(500);
  if (!callDeliveryAllowed(callId)) return;
  const { requestSamplesFromCall } = await import("../negotiate/index.ts");
  const res = await requestSamplesFromCall("send samples for Tuesday", callId);
  if (!callDeliveryAllowed(callId)) return;
  addTranscript(callId, { role: "agent", text: res.confirmation });
  await sleep(2500);
  if (!callDeliveryAllowed(callId)) return;
  addTranscript(callId, { role: "doctor", text: "Perfect, thanks." });
  await sleep(1000);
  if (!callDeliveryAllowed(callId)) return;
  addTranscript(callId, { role: "agent", text: "Sent to your inbox too. Have a good clinic." });
  await sleep(800);
  if (!callDeliveryAllowed(callId)) return;
  advanceCallStatus(callId, "ended");
}
