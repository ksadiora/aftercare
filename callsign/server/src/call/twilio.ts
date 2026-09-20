import { Router } from "express";
import { config } from "../config.ts";
import { getCall } from "../store.ts";
import { addTranscript, advanceCallStatus, bindProviderIds, callIdForCallSid, callVariables, isCallFinished, setCallStatus, type CallVariables } from "./provider.ts";
import { getTwilioCallStatus } from "./elevenlabs.ts";
import { openingLine, respond } from "./dialogue.ts";

/**
 * TWILIO-DIRECT VOICE PROVIDER
 *
 * Makes the phone ring with nothing but a Twilio account. Twilio places the
 * call and speaks with a neural voice; every time the doctor says something,
 * Twilio posts the speech transcript to /api/twilio/voice/turn and this
 * server decides the reply: answer from the label, run the sample
 * negotiation, or wrap up. No ElevenLabs needed.
 *
 * Two flavours depending on PUBLIC_BASE_URL:
 *  - public https URL: full two-way conversation (TwiML fetched from us).
 *  - localhost: "announce" call built from inline TwiML; the phone still
 *    rings and the agent reads the update, but cannot listen.
 *
 * Docs: https://www.twilio.com/docs/voice/api/call-resource
 *       https://www.twilio.com/docs/voice/twiml/gather
 *       https://www.twilio.com/docs/voice/twiml/say/text-speech
 */

const VOICE = process.env.TWILIO_VOICE?.trim() || "Polly.Joanna-Neural";

const turnsByCall = new Map<string, number>();

export function twilioDirectConfigured(): boolean {
  const c = config.calls;
  return Boolean(c.twilioAccountSid && c.twilioAuthToken && process.env.TWILIO_FROM_NUMBER?.trim());
}

function isPublicBase(): boolean {
  const u = config.publicBaseUrl;
  return /^https:\/\//i.test(u) && !/localhost|127\.0\.0\.1/.test(u);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function say(text: string): string {
  return `<Say voice="${VOICE}">${esc(text)}</Say>`;
}


// ---------------------------------------------------------------------------
// Placing the call
// ---------------------------------------------------------------------------

export async function placeCallTwilio(callId: string, toE164: string, vars: CallVariables): Promise<void> {
  const { twilioAccountSid: sid, twilioAuthToken: token } = config.calls;
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  if (!sid || !token || !from) {
    setCallStatus(callId, "failed", { error: "CALLS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER" });
    return;
  }
  turnsByCall.set(callId, 0);
  advanceCallStatus(callId, "dialing");

  const form = new URLSearchParams({ To: toE164, From: from, Timeout: "25" });
  const pub = isPublicBase();
  if (pub) {
    form.set("Url", `${config.publicBaseUrl}/api/twilio/voice/start?call=${encodeURIComponent(callId)}`);
    form.set("StatusCallback", `${config.publicBaseUrl}/api/webhooks/twilio/status`);
    for (const ev of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", ev);
  } else {
    // Inline TwiML: no public URL required. The phone rings and hears the update.
    const twiml =
      `<Response>${say(openingLine(vars))}<Pause length="1"/>` +
      `${say("Here is the one-line change. " + vars.update_summary + " I have sent the full label section to your inbox. Have a good clinic.")}` +
      `<Hangup/></Response>`;
    form.set("Twiml", twiml);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
    if (!res.ok || !json.sid) {
      const why = json.message ? `${json.message}${json.code ? ` (code ${json.code})` : ""}` : `HTTP ${res.status}`;
      setCallStatus(callId, "failed", { error: `Twilio: ${why}` });
      return;
    }
    bindProviderIds(callId, { callSid: json.sid });
    advanceCallStatus(callId, "ringing", { providerCallId: json.sid });
    addTranscript(callId, { role: "system", text: pub ? "Ringing via Twilio" : "Ringing via Twilio (announce only: set a public PUBLIC_BASE_URL for two-way conversation)" });
    if (!pub) {
      // Nothing will call us back, so narrate what the phone hears and poll for the end.
      addTranscript(callId, { role: "agent", text: openingLine(vars) });
      addTranscript(callId, { role: "agent", text: `Here is the one-line change. ${vars.update_summary} I have sent the full label section to your inbox.` });
    }
    void pollTwilio(callId, json.sid);
  } catch (e) {
    setCallStatus(callId, "failed", { error: `Twilio: ${(e as Error).message}` });
  } finally {
    clearTimeout(timer);
  }
}

/** Status callbacks need a public URL; polling covers the localhost case and doubles as a safety net. */
async function pollTwilio(callId: string, callSid: string) {
  const started = Date.now();
  while (!isCallFinished(callId) && Date.now() - started < 5 * 60_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await getTwilioCallStatus(callSid);
    if (!status) continue;
    if (status === "in-progress") advanceCallStatus(callId, "in-progress");
    else if (status === "completed") advanceCallStatus(callId, "ended");
    else if (status === "busy" || status === "no-answer" || status === "failed" || status === "canceled") {
      advanceCallStatus(callId, "failed", { error: `Twilio call ${status}` });
    }
  }
}

// ---------------------------------------------------------------------------
// TwiML conversation (only reachable when PUBLIC_BASE_URL is public)
// ---------------------------------------------------------------------------

export const twilioVoiceRouter = Router();

function gather(callId: string, prompt: string): string {
  const action = `${config.publicBaseUrl}/api/twilio/voice/turn?call=${encodeURIComponent(callId)}`;
  return (
    `<Gather input="speech" language="en-US" speechTimeout="auto" speechModel="phone_call" enhanced="true" action="${esc(action)}" method="POST">` +
    say(prompt) +
    `</Gather>` +
    // Reached only if the doctor said nothing.
    say("I'll send this to your inbox. Have a good clinic.") +
    `<Hangup/>`
  );
}

function xml(res: import("express").Response, body: string) {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

twilioVoiceRouter.post("/start", (req, res) => {
  const callId = String(req.query.call ?? "");
  const vars = callVariables(callId);
  const callSid = (req.body as { CallSid?: string })?.CallSid;
  if (!vars || !getCall(callId)) return xml(res, say("This call is no longer valid. Goodbye.") + "<Hangup/>");
  if (callSid) bindProviderIds(callId, { callSid });
  advanceCallStatus(callId, "in-progress");
  const line = openingLine(vars);
  addTranscript(callId, { role: "agent", text: line });
  xml(res, gather(callId, line));
});

twilioVoiceRouter.post("/turn", async (req, res) => {
  const callId = String(req.query.call ?? "");
  const vars = callVariables(callId);
  if (!vars || !getCall(callId)) return xml(res, say("Goodbye.") + "<Hangup/>");
  const heard = String((req.body as { SpeechResult?: string })?.SpeechResult ?? "").trim();
  const turn = (turnsByCall.get(callId) ?? 0) + 1;
  turnsByCall.set(callId, turn);
  if (heard) addTranscript(callId, { role: "doctor", text: heard });
  const { reply, end } = await respond(callId, vars, heard, turn);
  addTranscript(callId, { role: "agent", text: reply });
  if (end) return xml(res, say(reply) + "<Hangup/>");
  xml(res, gather(callId, reply));
});

/** Used by the status webhook: is this CallSid one of ours? */
export function twilioCallIdFor(callSid: string | undefined): string | undefined {
  return callIdForCallSid(callSid);
}
