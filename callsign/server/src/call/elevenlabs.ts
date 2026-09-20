import { config } from "../config.ts";

/**
 * ELEVENLABS AGENTS REST CLIENT  (owner: Voice lane)
 *
 * Thin fetch wrapper around the three endpoints the call flow needs. No SDK:
 * the shapes are small and the API moves often enough that a pinned SDK
 * would be as much a liability as a help.
 *
 * Docs consulted (Sept 2026):
 *  - Outbound call via Twilio:  https://elevenlabs.io/docs/api-reference/twilio/outbound-call
 *  - Get conversation:          https://elevenlabs.io/docs/api-reference/conversations/get
 *  - List phone numbers:        https://elevenlabs.io/docs/api-reference/phone-numbers/list
 *  - Dynamic variables:         https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables
 */

const BASE = process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io";

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

// ---------------------------------------------------------------------------
// Shapes (only the fields we read; the API returns more)
// ---------------------------------------------------------------------------

/** POST /v1/convai/twilio/outbound-call request body. */
export interface OutboundCallBody {
  agent_id: string;
  agent_phone_number_id: string;
  to_number: string; // E.164
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, string | number | boolean>;
    conversation_config_override?: Record<string, unknown>;
    user_id?: string;
  };
  call_recording_enabled?: boolean;
  telephony_call_config?: {
    ringing_timeout_secs?: number;
    twilio_call_recording_enabled?: boolean;
    twilio_machine_detection?: { mode: "enable" | "detect_message_end" };
  };
}

/** POST /v1/convai/twilio/outbound-call 200 response. */
export interface OutboundCallResponse {
  success: boolean;
  message: string;
  conversation_id: string | null;
  callSid: string | null;
}

export type ConversationStatus = "initiated" | "in-progress" | "processing" | "done" | "failed";

export interface ConversationTurn {
  role: "user" | "agent";
  message?: string | null;
  time_in_call_secs?: number;
  tool_calls?: unknown[];
  tool_results?: unknown[];
}

/** GET /v1/convai/conversations/{id} response (subset). */
export interface Conversation {
  agent_id: string;
  conversation_id: string;
  status: ConversationStatus;
  transcript: ConversationTurn[];
  metadata?: {
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    phone_call?: Record<string, unknown>;
    termination_reason?: string;
  };
  analysis?: { transcript_summary?: string; call_successful?: string };
}

export interface PhoneNumber {
  phone_number: string;
  label: string;
  phone_number_id: string;
  provider: "twilio" | "sip_trunk" | "exotel" | string;
  assigned_agent?: { agent_id: string; agent_name: string } | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function apiKey(): string {
  const key = config.calls.elevenLabsApiKey;
  if (!key) throw new ElevenLabsError("ELEVENLABS_API_KEY is not set", 0);
  return key;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "xi-api-key": apiKey(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      throw new ElevenLabsError(`ElevenLabs ${method} ${path} -> ${res.status}: ${summarizeError(json)}`, res.status, json);
    }
    return json as T;
  } catch (e) {
    if (e instanceof ElevenLabsError) throw e;
    const msg = (e as Error).name === "AbortError" ? `timed out after ${timeoutMs} ms` : (e as Error).message;
    throw new ElevenLabsError(`ElevenLabs ${method} ${path} failed: ${msg}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a one-line reason out of a 4xx/5xx body (422 bodies are {detail: [{loc,msg,type}]} or {detail:{status,message}}). */
function summarizeError(json: unknown): string {
  if (!json) return "no body";
  if (typeof json === "string") return json.slice(0, 200);
  const d = (json as { detail?: unknown }).detail;
  if (Array.isArray(d)) return d.map((x) => `${(x as { loc?: unknown[] }).loc?.join(".") ?? ""}: ${(x as { msg?: string }).msg ?? ""}`).join("; ").slice(0, 300);
  if (d && typeof d === "object") {
    const o = d as { status?: string; message?: string };
    return `${o.status ?? ""} ${o.message ?? ""}`.trim().slice(0, 300) || JSON.stringify(d).slice(0, 300);
  }
  if (typeof d === "string") return d.slice(0, 300);
  return JSON.stringify(json).slice(0, 300);
}

/**
 * Place an outbound call through a Twilio number that has been imported into
 * ElevenLabs. Returns the conversation id and the Twilio CallSid.
 * https://elevenlabs.io/docs/api-reference/twilio/outbound-call
 */
export function outboundCall(body: OutboundCallBody): Promise<OutboundCallResponse> {
  return request<OutboundCallResponse>("POST", "/v1/convai/twilio/outbound-call", body);
}

/**
 * Fetch a conversation. `status` moves initiated -> in-progress -> processing -> done (or failed).
 * `transcript` fills in while the call is live, so polling this is a usable
 * live transcript when the post-call webhook can't reach us.
 * https://elevenlabs.io/docs/api-reference/conversations/get
 */
export function getConversation(conversationId: string): Promise<Conversation> {
  return request<Conversation>("GET", `/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
}

/**
 * List phone numbers imported into the workspace; used by test-call to find
 * ELEVENLABS_PHONE_NUMBER_ID. https://elevenlabs.io/docs/api-reference/phone-numbers/list
 */
export function listPhoneNumbers(): Promise<PhoneNumber[]> {
  return request<PhoneNumber[]>("GET", "/v1/convai/phone-numbers");
}

// ---------------------------------------------------------------------------
// Twilio (optional): only used to observe ringing/answered when the account
// SID + auth token are set. ElevenLabs owns the call; we just read its status.
// https://www.twilio.com/docs/voice/api/call-resource
// ---------------------------------------------------------------------------

export type TwilioCallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "canceled"
  | "completed"
  | "busy"
  | "no-answer"
  | "failed";

export function twilioConfigured(): boolean {
  return Boolean(config.calls.twilioAccountSid && config.calls.twilioAuthToken);
}

export async function getTwilioCallStatus(callSid: string): Promise<TwilioCallStatus | undefined> {
  const { twilioAccountSid: sid, twilioAuthToken: token } = config.calls;
  if (!sid || !token) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { status?: TwilioCallStatus };
    return json.status;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
