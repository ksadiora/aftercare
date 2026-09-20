/**
 * Ring a real phone, no server needed. Uses CALLS_PROVIDER from .env:
 *   twilio      Twilio dials and speaks the update (needs only Twilio creds)
 *   elevenlabs  ElevenLabs Agents over an imported Twilio number
 * Pass --elevenlabs to force the ElevenLabs path.
 *
 *   npm run test-call -- +15405551234          place a call with the demo variables
 *   npm run test-call -- --numbers             list phone numbers imported into ElevenLabs
 *
 * Needs ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID in
 * the repo-root .env (docs/voice-setup.md). Prints status + transcript as the
 * call runs by polling GET /v1/convai/conversations/{id}. The number is only
 * ever printed masked.
 */
import { maskPhone } from "@callsign/shared";
import { config } from "../config.ts";
import { doctor, todaysUpdate } from "../seed/data.ts";
import { ElevenLabsError, getConversation, listPhoneNumbers, outboundCall } from "../call/elevenlabs.ts";

const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function requireEnv() {
  const missing = (
    [
      ["ELEVENLABS_API_KEY", config.calls.elevenLabsApiKey],
      ["ELEVENLABS_AGENT_ID", config.calls.elevenLabsAgentId],
      ["ELEVENLABS_PHONE_NUMBER_ID", config.calls.elevenLabsPhoneNumberId],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) die(`Missing in .env: ${missing.join(", ")}. See docs/voice-setup.md.`);
}

if (flags.has("--numbers")) {
  if (!config.calls.elevenLabsApiKey) die("Missing ELEVENLABS_API_KEY in .env");
  const numbers = await listPhoneNumbers().catch((e: Error) => die(e.message));
  if (!numbers.length) console.log("No phone numbers imported into ElevenLabs yet (Agents → Phone numbers → Import).");
  for (const n of numbers) {
    console.log(`${n.phone_number_id}  ${n.label.padEnd(24)}  ${n.provider.padEnd(9)}  ${maskPhone(n.phone_number)}  agent=${n.assigned_agent?.agent_name ?? "-"}`);
  }
  process.exit(0);
}

const to = normalizePhone(arg ?? "");
if (!to) die("Usage: npm run test-call -- +1XXXXXXXXXX   (or --numbers)");

// ---------------------------------------------------------------------------
// Twilio-direct provider (CALLS_PROVIDER=twilio): Twilio dials and speaks the
// update by itself. Needs only TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM_NUMBER. With a public PUBLIC_BASE_URL the call is two-way.
// ---------------------------------------------------------------------------
if (config.calls.provider === "twilio" && !flags.has("--elevenlabs")) {
  const { twilioAccountSid: sid, twilioAuthToken: token, twilioFromNumber: from } = config.calls;
  const missing = [["TWILIO_ACCOUNT_SID", sid], ["TWILIO_AUTH_TOKEN", token], ["TWILIO_FROM_NUMBER", from]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) die(`Missing in .env: ${missing.join(", ")}. See docs/voice-setup.md (Twilio-only section).`);

  const voice = process.env.TWILIO_VOICE?.trim() || "Polly.Joanna-Neural";
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const line = `${doctor.name}, this is the verified Stelazio agent, calling through Callsign. ${todaysUpdate.summary} ${todaysUpdate.affectedPatients} of your patients are affected. This is a test call. Have a good clinic.`;
  const form = new URLSearchParams({ To: to, From: from, Timeout: "25", Twiml: `<Response><Say voice="${voice}">${esc(line)}</Say><Hangup/></Response>` });
  console.log(`
Dialing ${maskPhone(to)} from ${maskPhone(from)} via Twilio…`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
  if (!res.ok || !json.sid) die(`Twilio refused the call: ${json.message ?? `HTTP ${res.status}`}${json.code ? ` (code ${json.code}, see https://www.twilio.com/docs/api/errors/${json.code})` : ""}`);
  console.log(`  accepted  CallSid ${json.sid}  status ${json.status}`);
  let last = "";
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${json.sid}.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
    });
    const c = (await r.json().catch(() => ({}))) as { status?: string; duration?: string };
    if (c.status && c.status !== last) {
      last = c.status;
      console.log(`  ${new Date().toISOString().slice(11, 19)}  ${c.status}${c.duration ? `  (${c.duration}s)` : ""}`);
    }
    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(last)) break;
  }
  process.exit(0);
}

requireEnv();

// Same five variables placeCall() sends, hard-coded to the demo story.
const dynamic_variables = {
  doctor_name: doctor.name,
  brand: "Stelazio",
  update_summary: todaysUpdate.summary,
  affected_patients: String(todaysUpdate.affectedPatients),
  specialty: doctor.specialty,
  callsign_call_id: `test_${Date.now().toString(36)}`,
};

console.log(`\nCalling ${maskPhone(to)} with agent ${config.calls.elevenLabsAgentId} ...`);
let conversationId: string | null = null;
try {
  const res = await outboundCall({
    agent_id: config.calls.elevenLabsAgentId,
    agent_phone_number_id: config.calls.elevenLabsPhoneNumberId,
    to_number: to,
    conversation_initiation_client_data: { dynamic_variables },
    telephony_call_config: { ringing_timeout_secs: 30 },
  });
  if (!res.success) die(`ElevenLabs refused: ${res.message}`);
  conversationId = res.conversation_id;
  console.log(`accepted  conversation=${res.conversation_id ?? "?"}  callSid=${res.callSid ?? "?"}`);
} catch (e) {
  if (e instanceof ElevenLabsError) die(`${e.message}${hint(e)}`);
  die((e as Error).message);
}

if (!conversationId) die("No conversation_id in the response; check the ElevenLabs call history.");

console.log("Phone should be ringing. Polling transcript (Ctrl+C to stop):\n");
let shown = 0;
let lastStatus = "";
const started = Date.now();
while (Date.now() - started < 10 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const conv = await getConversation(conversationId);
    if (conv.status !== lastStatus) {
      lastStatus = conv.status;
      console.log(`  [status] ${conv.status}`);
    }
    for (let i = shown; i < (conv.transcript?.length ?? 0); i++) {
      const t = conv.transcript[i];
      if (t.message?.trim()) console.log(`  ${t.role === "agent" ? "AGENT " : "DOCTOR"}  ${t.message.trim()}`);
      const tools = (t.tool_calls ?? []) as { tool_name?: string }[];
      for (const c of tools) if (c.tool_name) console.log(`  [tool]  ${c.tool_name}`);
    }
    shown = conv.transcript?.length ?? shown;
    if (conv.status === "done" || conv.status === "failed") {
      console.log(`\nCall ${conv.status}. ${conv.metadata?.call_duration_secs ?? "?"} s. ${conv.analysis?.transcript_summary ?? ""}\n`);
      process.exit(conv.status === "done" ? 0 : 1);
    }
  } catch (e) {
    if (e instanceof ElevenLabsError && e.status === 404) continue; // not materialised yet
    console.warn(`  poll error: ${(e as Error).message}`);
  }
}
die("Timed out waiting for the conversation to finish.");

function hint(e: ElevenLabsError): string {
  if (e.status === 401) return "\n  → ELEVENLABS_API_KEY is wrong or lacks the Agents permission.";
  if (e.status === 422) return "\n  → Check ELEVENLABS_AGENT_ID / ELEVENLABS_PHONE_NUMBER_ID (run with --numbers) and that the number is E.164.";
  if (e.status === 402 || e.status === 429) return "\n  → ElevenLabs plan/minutes or concurrency limit. See docs/voice-setup.md.";
  return "";
}

function normalizePhone(input: string): string | undefined {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (input.trim().startsWith("+") && digits.length >= 8) return `+${digits}`;
  return undefined;
}
