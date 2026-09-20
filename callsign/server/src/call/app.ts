import os from "node:os";
import { Router } from "express";
import type { PhoneRegisterBody, PhoneSessionResponse, PhoneState, PhoneTurnBody, PhoneTurnResponse } from "@callsign/shared";
import { config, setPhonePairedProbe } from "../config.ts";
import { emit, nowIso } from "../events.ts";
import { audit, getCall } from "../store.ts";
import { brandIdentity } from "../seed/data.ts";
import { addTranscript, advanceCallStatus, callDeliveryAllowed, callVariables, isCallFinished, setCallStatus, type CallVariables } from "./provider.ts";
import { openingLine, respond } from "./dialogue.ts";
import { callerOpening, endCallerSession, isHumanCaller, nextCallerLine, announceHumanCaller } from "./caller.ts";

/**
 * IN-APP CALL PROVIDER  ("app", the default)
 *
 * The doctor's phone is a browser on the same Wi-Fi that opened /phone and
 * paired itself. When the agent decides to call, we flip the call to
 * "ringing" and the phone (which holds a WebSocket) shows an incoming-call
 * screen. Accept → in-progress; the phone plays the agent's lines (ElevenLabs
 * TTS through /api/phone/tts when a key is set, otherwise the browser's own
 * voice) and posts what the doctor says to /api/phone/turn; the reply comes
 * from call/dialogue.ts. No carrier, no number, no public URL.
 */

const RING_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Pairing state (one phone at a time; the newest registration wins)
// ---------------------------------------------------------------------------

const phone: { deviceName?: string; lastSeen?: string } = {};
const turns = new Map<string, number>();

/**
 * A paired phone heartbeats every 15 s. One that has been silent this long
 * (tab closed, phone locked, Wi-Fi dropped) is treated as gone, so a brand
 * call runs the simulated path instead of ringing nothing for 45 s, and the
 * console goes back to offering the QR / docked phone.
 */
const PAIRING_TTL_MS = 50_000;

function pairingFresh(): boolean {
  if (!phone.deviceName) return false;
  if (!phone.lastSeen) return true;
  return Date.now() - Date.parse(phone.lastSeen) < PAIRING_TTL_MS;
}

/** Drop a stale pairing. Returns true when something changed. */
function expirePairing(): boolean {
  if (!phone.deviceName || pairingFresh()) return false;
  audit("demo", `Phone unpaired: ${phone.deviceName} stopped responding`);
  phone.deviceName = undefined;
  phone.lastSeen = undefined;
  return true;
}

// Sweep so the console learns about a vanished phone without anyone asking.
setInterval(() => {
  if (expirePairing()) broadcastPhone();
}, 10_000).unref();

export function phoneState(): PhoneState {
  expirePairing();
  return {
    paired: Boolean(phone.deviceName),
    deviceName: phone.deviceName,
    lastSeen: phone.lastSeen,
    urls: phoneUrls(),
    voice: config.calls.elevenLabsApiKey ? "elevenlabs" : "browser",
  };
}

export function phonePaired(): boolean {
  expirePairing();
  return Boolean(phone.deviceName);
}
setPhonePairedProbe(phonePaired);

function broadcastPhone() {
  emit({ type: "phone.update", phone: phoneState() });
}

/**
 * Which scheme the phone page is actually served on. Vite runs https by
 * default (the phone needs it for the microphone) but can be started with
 * VITE_NO_SSL=1; the QR must match or the phone gets a connection error.
 * Probed on demand and cached for 10 s.
 */
let schemeCache: { scheme: "https" | "http"; at: number } | undefined;
export async function detectPhoneScheme(port: string): Promise<"https" | "http"> {
  const forced = process.env.PHONE_SCHEME?.trim();
  if (forced === "http" || forced === "https") return forced;
  if (schemeCache && Date.now() - schemeCache.at < 10_000) return schemeCache.scheme;
  const probe = async (scheme: "https" | "http") => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    try {
      // Node's fetch rejects self-signed certs; any TLS-shaped failure still means https is up.
      await fetch(`${scheme}://127.0.0.1:${port}/phone`, { signal: ctrl.signal });
      return true;
    } catch (e) {
      const msg = String((e as Error)?.cause ?? (e as Error)?.message ?? e);
      return scheme === "https" && /certificate|self[- ]signed|SSL|TLS|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg);
    } finally {
      clearTimeout(t);
    }
  };
  const scheme: "https" | "http" = (await probe("https")) ? "https" : (await probe("http")) ? "http" : "https";
  schemeCache = { scheme, at: Date.now() };
  return scheme;
}

/** URLs a phone on the same network can open. Vite dev serves /phone on 5173. */
export function phoneUrls(): string[] {
  const port = process.env.PHONE_PORT?.trim() || "5173";
  const scheme = schemeCache?.scheme ?? process.env.PHONE_SCHEME?.trim() ?? "https";
  void detectPhoneScheme(port); // refresh in the background for the next call
  const out: string[] = [];
  const ifaces = Object.entries(os.networkInterfaces());
  const rank = (name: string) => (/wi-?fi|wlan|ethernet|^en|^eth/i.test(name) ? 0 : /vethernet|wsl|hyper|virtual|vmware|docker|loopback|tailscale|zerotier/i.test(name) ? 2 : 1);
  ifaces.sort((x, y) => rank(x[0]) - rank(y[0]));
  for (const [, addrs] of ifaces) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254")) out.push(`${scheme}://${a.address}:${port}/phone`);
    }
  }
  if (process.env.PHONE_URL?.trim()) out.unshift(process.env.PHONE_URL.trim());
  if (phoneUrlOverride) out.unshift(phoneUrlOverride);
  return out;
}

/** A public URL (e.g. a cloudflared tunnel) set at runtime by `npm run tunnel`; shown first in the QR. */
let phoneUrlOverride: string | undefined;
export function setPhoneUrlOverride(url: string | undefined) {
  phoneUrlOverride = url?.trim() || undefined;
  broadcastPhone();
}

// ---------------------------------------------------------------------------
// Placing the call
// ---------------------------------------------------------------------------

export async function placeCallApp(callId: string, vars: CallVariables): Promise<void> {
  const call = getCall(callId);
  if (!call || !callDeliveryAllowed(callId)) return;
  if (!phonePaired()) {
    setCallStatus(callId, "failed", { error: "No phone paired. Open the phone URL from the demo panel on a device first.", endReason: "error" });
    return;
  }
  call.provider = "app";
  call.callerName = vars.brand;
  call.callerAgent = brandIdentity.name;
  turns.set(callId, 0);
  prewarm([
    openingLine(vars),
    `${vars.update_summary} That's section 2.3 of the label. Want me to send samples, or is there a patient you want to check?`,
    "Sorry, I didn't catch that. Want the one-line change, or should I send it to your inbox?",
    "You're welcome. It's in your inbox too. Have a good clinic.",
  ]);
  advanceCallStatus(callId, "dialing");
  await new Promise((r) => setTimeout(r, 400));
  if (!callDeliveryAllowed(callId)) return;
  advanceCallStatus(callId, "ringing");
  addTranscript(callId, { role: "system", text: `Ringing ${phone.deviceName ?? "the doctor's phone"}` });

  setTimeout(() => {
    const c = getCall(callId);
    if (c && c.status === "ringing") {
      addTranscript(callId, { role: "system", text: "No answer. Sent to inbox." });
      setCallStatus(callId, "ended", { endReason: "no-answer" });
    }
  }, RING_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// HTTP API the phone uses
// ---------------------------------------------------------------------------

export const phoneRouter = Router();

phoneRouter.get("/state", (_req, res) => res.json(phoneState()));

/** `npm run tunnel` posts the public URL here so the console's QR points at it. */
phoneRouter.post("/url", (req, res) => {
  const { url } = (req.body ?? {}) as { url?: string };
  if (url && !/^https?:\/\//.test(url)) return res.status(400).json({ error: "url must be http(s)" });
  setPhoneUrlOverride(url);
  audit("demo", url ? `Phone URL set to ${url}` : "Phone URL override cleared");
  res.json(phoneState());
});

phoneRouter.post("/register", (req, res) => {
  const { deviceName } = (req.body ?? {}) as PhoneRegisterBody;
  phone.deviceName = (deviceName || "Phone").toString().slice(0, 40);
  phone.lastSeen = nowIso();
  audit("demo", `Phone paired: ${phone.deviceName}`);
  broadcastPhone();
  res.json(phoneState());
});

phoneRouter.post("/heartbeat", (_req, res) => {
  if (phone.deviceName) phone.lastSeen = nowIso();
  res.json({ ok: true });
});

phoneRouter.post("/unregister", (_req, res) => {
  phone.deviceName = undefined;
  phone.lastSeen = undefined;
  broadcastPhone();
  res.json(phoneState());
});

/** The phone accepted. Returns the opening line for the phone to speak. */
phoneRouter.post("/answer", (req, res) => {
  const { callId } = (req.body ?? {}) as { callId?: string };
  const call = callId ? getCall(callId) : undefined;
  const vars = callId ? callVariables(callId) : undefined;
  if (!call || !vars || call.status !== "ringing") return res.status(409).json({ error: "no ringing call with that id" });
  if (!callDeliveryAllowed(call.id)) return res.status(409).json({ error: "The call is no longer approved by the doctor's policy." });
  call.answeredAt = nowIso();
  advanceCallStatus(callId!, "in-progress");
  audit("call", `Answered on ${phone.deviceName ?? "phone"}`, callId);
  const human = isHumanCaller(callId!);
  const line = human ? (callerOpening(callId!) ?? openingLine(vars)) : openingLine(vars);
  if (human) announceHumanCaller(callId!);
  addTranscript(callId!, { role: "agent", text: line });
  const out: PhoneTurnResponse = { reply: line, end: false };
  res.json(out);
});

phoneRouter.post("/decline", (req, res) => {
  const { callId } = (req.body ?? {}) as { callId?: string };
  const call = callId ? getCall(callId) : undefined;
  if (!call || isCallFinished(callId!)) return res.json({ ok: true });
  addTranscript(callId!, { role: "system", text: "Declined. Sent to inbox." });
  setCallStatus(callId!, "ended", { endReason: "declined" });
  res.json({ ok: true });
});

phoneRouter.post("/turn", async (req, res) => {
  const { callId, text } = (req.body ?? {}) as PhoneTurnBody;
  const call = callId ? getCall(callId) : undefined;
  const vars = callId ? callVariables(callId) : undefined;
  if (!call || !vars || call.status !== "in-progress") return res.status(409).json({ error: "call is not in progress" });
  if (!callDeliveryAllowed(callId)) return res.json({ reply: "", end: true } satisfies PhoneTurnResponse);
  const heard = (text ?? "").toString().trim();
  const turn = (turns.get(callId) ?? 0) + 1;
  turns.set(callId, turn);
  if (heard) addTranscript(callId, { role: "doctor", text: heard });

  // A human is on the other end: wait for what they say next instead of asking the AI.
  if (isHumanCaller(callId)) {
    const line = await nextCallerLine(callId, 20_000);
    if (!callDeliveryAllowed(callId)) return res.json({ reply: "", end: true } satisfies PhoneTurnResponse);
    // Empty reply = nothing yet; the phone keeps listening and polls again.
    return res.json({ reply: line ?? "", end: false } satisfies PhoneTurnResponse);
  }

  const out = await respond(callId, vars, heard, turn);
  if (!callDeliveryAllowed(callId)) return res.json({ reply: "", end: true } satisfies PhoneTurnResponse);
  addTranscript(callId, { role: "agent", text: out.reply });
  if (out.end) {
    // Give the phone time to speak the last line before the call reads as ended.
    setTimeout(() => {
      if (!isCallFinished(callId)) setCallStatus(callId, "ended", { endReason: "hangup" });
    }, 6000);
  }
  const body: PhoneTurnResponse = out;
  res.json(body);
});

phoneRouter.post("/hangup", (req, res) => {
  const { callId } = (req.body ?? {}) as { callId?: string };
  if (callId && !isCallFinished(callId)) {
    addTranscript(callId, { role: "system", text: "Call ended by doctor" });
    setCallStatus(callId, "ended", { endReason: "hangup" });
  }
  if (callId) endCallerSession(callId);
  res.json({ ok: true });
});

/**
 * Text-to-speech through ElevenLabs when a key is present. Returns audio/mpeg,
 * or 204 so the phone falls back to the browser's speechSynthesis.
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 *
 * Audio is cached by text so a line is synthesized once per process, and the
 * opening line is pre-generated the moment a call is placed, so it plays the
 * instant the judge taps Accept.
 */
const ttsCache = new Map<string, Buffer>();
const ttsInflight = new Map<string, Promise<Buffer | undefined>>();
const TTS_CACHE_MAX = 200;

function ttsKey(text: string) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM";
  return `${voiceId}|${text}`;
}

export async function synthesize(text: string): Promise<Buffer | undefined> {
  const key = config.calls.elevenLabsApiKey;
  text = text.slice(0, 1000);
  if (!key || !text) return undefined;
  const k = ttsKey(text);
  const hit = ttsCache.get(k);
  if (hit) return hit;
  const inflight = ttsInflight.get(k);
  if (inflight) return inflight;

  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const model = process.env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_flash_v2_5";
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        console.warn("[tts] elevenlabs", r.status, (await r.text().catch(() => "")).slice(0, 200));
        return undefined;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (ttsCache.size >= TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value as string);
      ttsCache.set(k, buf);
      return buf;
    } catch (e) {
      console.warn("[tts] failed", (e as Error).message);
      return undefined;
    } finally {
      clearTimeout(timer);
      ttsInflight.delete(k);
    }
  })();
  ttsInflight.set(k, p);
  return p;
}

/** Fire-and-forget: warm the cache for lines we know are coming. */
export function prewarm(lines: string[]) {
  if (!config.calls.elevenLabsApiKey) return;
  for (const line of lines) void synthesize(line);
}

phoneRouter.get("/tts", async (req, res) => {
  const text = String(req.query.text ?? "");
  const buf = await synthesize(text);
  if (!buf) return res.status(204).end();
  res.setHeader("content-type", "audio/mpeg");
  res.setHeader("cache-control", "private, max-age=600");
  res.end(buf);
});

/**
 * Optional: a real-time ElevenLabs agent session for the phone (voice in and
 * out over WebRTC/WebSocket, interruptions, the works). Needs
 * ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID. The phone's client tools then call
 * /api/tools/* on this server directly over the LAN.
 * https://elevenlabs.io/docs/api-reference/conversations/get-signed-url
 */
phoneRouter.get("/session", async (_req, res) => {
  const { elevenLabsApiKey: key, elevenLabsAgentId: agentId } = config.calls;
  const fallback: PhoneSessionResponse = { engine: "browser" };
  if (!key || !agentId) return res.json(fallback);
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { "xi-api-key": key },
    });
    if (!r.ok) return res.json(fallback);
    const j = (await r.json()) as { signed_url?: string };
    if (!j.signed_url) return res.json(fallback);
    const out: PhoneSessionResponse = { engine: "elevenlabs", signedUrl: j.signed_url, agentId };
    res.json(out);
  } catch {
    res.json(fallback);
  }
});
