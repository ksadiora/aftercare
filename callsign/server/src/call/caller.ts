import { Router } from "express";
import { emit, nowIso } from "../events.ts";
import { audit, getCall } from "../store.ts";
import { addTranscript, callDeliveryAllowed, isCallFinished, setCallStatus } from "./provider.ts";
import { screenConversation } from "../screening.ts";

/**
 * A HUMAN CALLER
 *
 * Normally the brand's agent is software. Here a person (the presenter, a
 * judge) plays the caller: they choose an identity on the Caller page,
 * write their opening line, and press Call. The request goes through the
 * same five checks. If it is verified, Dr. Patel's phone rings and the two
 * humans talk through a relay: the caller's lines are spoken by her phone,
 * her replies stream back to the caller's screen. Rejected callers hear why.
 *
 * Relay model: her phone long-polls /api/phone/turn (the same endpoint it
 * always uses); in caller mode the "reply" is whatever the caller says next
 * instead of the AI brain. The caller posts lines to /api/caller/say and
 * reads her side from the live transcript (WebSocket).
 */

interface CallerSession {
  callId?: string; // bound once the doctor's agent places the call
  requestId: string;
  displayName: string;
  opening: string; // spoken by her phone the moment she answers
  queue: string[]; // caller lines waiting to be spoken
  waiters: ((line: string | undefined) => void)[]; // phone requests waiting for the next line
}

const byRequest = new Map<string, CallerSession>();
const byCall = new Map<string, CallerSession>();
const screening = new Set<string>();

export function registerCallerSession(requestId: string, displayName: string, opening: string) {
  const s: CallerSession = { requestId, displayName, opening, queue: [], waiters: [] };
  byRequest.set(requestId, s);
  return s;
}

/** Called by placeCall when a call is created for a request. Binds the session to the call. */
export function bindCallerCall(requestId: string, callId: string) {
  const s = byRequest.get(requestId);
  if (!s) return;
  s.callId = callId;
  byCall.set(callId, s);
}

export function isHumanCaller(callId: string): boolean {
  return byCall.has(callId);
}

export function callerOpening(callId: string): string | undefined {
  return byCall.get(callId)?.opening;
}

/** The phone asks for the next thing the caller says. Resolves when a line arrives, or with undefined after `timeoutMs`. */
export function nextCallerLine(callId: string, timeoutMs = 20_000): Promise<string | undefined> {
  const s = byCall.get(callId);
  if (!s) return Promise.resolve(undefined);
  const queued = s.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve) => {
    const done = (line: string | undefined) => {
      clearTimeout(t);
      s.waiters = s.waiters.filter((w) => w !== done);
      resolve(line);
    };
    const t = setTimeout(() => done(undefined), timeoutMs);
    s.waiters.push(done);
  });
}

function deliver(s: CallerSession, line: string) {
  const w = s.waiters.shift();
  if (w) w(line);
  else s.queue.push(line);
}

export function endCallerSession(callId: string) {
  const s = byCall.get(callId);
  if (!s) return;
  for (const w of s.waiters.splice(0)) w(undefined);
  byCall.delete(callId);
  byRequest.delete(s.requestId);
}

// ---------------------------------------------------------------------------

export const callerRouter = Router();

/** Where the caller's request ended up: verifying, rejected, ringing, connected, ended. */
callerRouter.get("/status/:requestId", (req, res) => {
  const s = byRequest.get(String(req.params.requestId));
  if (!s) return res.status(404).json({ error: "unknown request" });
  const call = s.callId ? getCall(s.callId) : undefined;
  res.json({ requestId: s.requestId, callId: s.callId, callStatus: call?.status, endReason: call?.endReason });
});

/** The caller says something. Spoken by her phone as soon as it asks for the next line. */
callerRouter.post("/say", async (req, res) => {
  const { callId, text } = (req.body ?? {}) as { callId?: string; text?: string };
  const s = callId ? byCall.get(callId) : undefined;
  const line = typeof text === "string" ? text.trim() : "";
  if (!s || !callId) return res.status(404).json({ error: "no live call for that id" });
  if (!line || line.length > 2000) return res.status(400).json({ error: "Enter between 1 and 2,000 characters." });
  const call = getCall(callId);
  if (!call || call.status !== "in-progress" || !callDeliveryAllowed(callId)) return res.status(409).json({ error: "call is not in progress" });
  if (screening.has(callId)) return res.status(409).json({ error: "Wait for the current message to finish screening." });
  screening.add(callId);
  try {
    const history = call.transcript.filter((turn) => turn.role === "agent").map((turn) => ({ role: "caller" as const, text: turn.text }));
    const result = await screenConversation([...history, { role: "caller", text: line }]);
    if (!callDeliveryAllowed(callId) || byCall.get(callId) !== s) return res.status(409).json({ error: "call is over" });
    if (result.assessment.decision !== "allow") {
      if (result.assessment.decision === "block") {
        setCallStatus(callId, "ended", { endReason: "error", error: "Caller message blocked by content screening." });
        endCallerSession(callId);
      }
      return res.status(422).json({ error: result.response });
    }
    addTranscript(callId, { role: "agent", text: line });
    deliver(s, line);
    res.json({ ok: true, at: nowIso() });
  } catch {
    res.status(503).json({ error: "Screening is unavailable. The message was not delivered." });
  } finally { screening.delete(callId); }
});

callerRouter.post("/hangup", (req, res) => {
  const { callId } = (req.body ?? {}) as { callId?: string };
  if (callId && !isCallFinished(callId)) {
    addTranscript(callId, { role: "system", text: "Caller hung up" });
    setCallStatus(callId, "ended", { endReason: "hangup" });
    audit("call", "Caller hung up", callId);
  }
  if (callId) endCallerSession(callId);
  res.json({ ok: true });
});

/** Let the console know a human is on the line (cosmetic). */
export function announceHumanCaller(callId: string) {
  const s = byCall.get(callId);
  if (!s) return;
  addTranscript(callId, { role: "system", text: `${s.displayName} is a live caller` });
  emit({ type: "audit.add", entry: { id: `aud_${Date.now().toString(36)}`, ts: nowIso(), type: "call", summary: `Live caller connected: ${s.displayName}`, ref: callId } });
}
