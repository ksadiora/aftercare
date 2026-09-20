import { Router } from "express";
import type {
  AgentCard,
  ImpostorBody,
  PolicyUpdateBody,
  ProofBundle,
  DemoTriggerResponse,
  LabelLookupBody,
  LabelLookupResponse,
  ReachRequest,
  ReachResponse,
  RequestSamplesBody,
  RequestSamplesResponse,
  SetPhoneBody,
} from "@callsign/shared";
import { config, effectiveModes } from "./config.ts";
import { handleReach } from "./agent.ts";
import { buildBrandReach, buildImpostorReach } from "./agents/brand.ts";
import { labelLookup } from "./label/index.ts";
import { requestSamplesFromCall } from "./negotiate/index.ts";
import { audit, getRequest, getVerification, reset, setPhone, snapshot } from "./store.ts";
import { getPolicy, updatePolicy } from "./policy.ts";
import { broadcast, resetNetwork } from "./network.ts";
import { sha256 } from "./verify/sign.ts";
import { hcpIdentity } from "./seed/data.ts";

export const api = Router();
export const a2a = Router();

// ---------------------------------------------------------------------------
// A2A surface: what other agents talk to
// ---------------------------------------------------------------------------

a2a.get("/.well-known/agent.json", (_req, res) => {
  const card: AgentCard = {
    name: hcpIdentity.name,
    displayName: hcpIdentity.displayName,
    description: "Callsign agent for a physician. Verifies senders through ANS before anything reaches the doctor.",
    url: config.publicBaseUrl,
    protocols: ["a2a"],
    capabilities: ["reach", "negotiate"],
    ans: { registered: effectiveModes().ans === "real" },
  };
  res.json(card);
});

a2a.post("/reach", async (req, res) => {
  const body: unknown = req.body;
  if (!isReachRequest(body)) {
    const r: ReachResponse = { requestId: "", accepted: false, message: "malformed ReachRequest" };
    return res.status(400).json(r);
  }
  const r: ReachResponse = { requestId: body.id, accepted: true, message: "verifying" };
  res.status(202).json(r);
  void handleReach(body).catch(() => audit("verification", "Request verification could not complete; no delivery confirmed", body.id));
});

// ---------------------------------------------------------------------------
// Demo panel
// ---------------------------------------------------------------------------

api.get("/state", (_req, res) => res.json(snapshot()));

api.post("/demo/phone", (req, res) => {
  const { phone } = req.body as SetPhoneBody;
  const e164 = normalizePhone(phone ?? "");
  if (!e164) return res.status(400).json({ error: "Enter a US number with 10 digits." });
  setPhone(e164);
  audit("demo", "Phone number set for the demo (not stored)");
  res.json({ ok: true, masked: e164.replace(/\d(?=\d{2})/g, "*") });
});

api.post("/demo/phone/clear", (_req, res) => {
  setPhone(undefined);
  res.json({ ok: true });
});

api.post("/demo/impostor", (req, res) => {
  const { variant } = (req.body ?? {}) as ImpostorBody;
  const reach = buildImpostorReach(variant ?? "no-record");
  const r: DemoTriggerResponse = { requestId: reach.id };
  res.json(r);
  void handleReach(reach);
});

api.post("/demo/brand-call", (_req, res) => {
  const reach = buildBrandReach();
  const r: DemoTriggerResponse = { requestId: reach.id };
  res.json(r);
  void handleReach(reach);
});

api.post("/demo/reset", (_req, res) => {
  reset();
  resetNetwork();
  res.json({ ok: true });
});

/** The brand reaches every physician on the network; Dr. Patel's is the live one. */
api.post("/demo/broadcast", (_req, res) => {
  const reach = buildBrandReach();
  res.json({ requestId: reach.id });
  void broadcast(reach);
});

api.get("/policy", (_req, res) => res.json(getPolicy()));
api.post("/policy", (req, res) => res.json(updatePolicy((req.body ?? {}) as PolicyUpdateBody)));

/** Everything a third party needs to re-check a verdict. Public by design. */
api.get("/proof/:requestId", (req, res) => {
  const id = String(req.params.requestId);
  const request = getRequest(id);
  const result = getVerification(id);
  if (!request || !result) return res.status(404).json({ error: "unknown request" });
  const bundle: ProofBundle = {
    request: {
      id: request.id,
      from: request.from,
      to: request.to,
      claimedDisplayName: request.claimedDisplayName,
      kind: request.kind,
      ts: request.ts,
      signature: request.signature,
      payloadHash: sha256(JSON.stringify(request.payload)),
    },
    result,
    registry: { mode: effectiveModes().ans, base: effectiveModes().ans === "local" ? `${config.publicBaseUrl}/ans` : undefined },
    generatedAt: new Date().toISOString(),
  };
  res.json(bundle);
});

// ---------------------------------------------------------------------------
// ElevenLabs webhook tools (the voice agent calls these mid-conversation)
// ---------------------------------------------------------------------------

api.post("/tools/label_lookup", async (req, res) => {
  const { question } = req.body as LabelLookupBody;
  audit("tool", `label_lookup: "${question}"`);
  const out: LabelLookupResponse = await labelLookup(question ?? "");
  res.json(out);
});

api.post("/tools/request_samples", async (req, res) => {
  const { request } = req.body as RequestSamplesBody;
  audit("tool", `request_samples: "${request}"`);
  const out: RequestSamplesResponse = await requestSamplesFromCall(request ?? "samples");
  res.json(out);
});

// ---------------------------------------------------------------------------

function normalizePhone(input: string): string | undefined {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (input.trim().startsWith("+") && digits.length >= 8) return `+${digits}`;
  return undefined;
}

function isReachRequest(value: unknown): value is ReachRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const text = (item: unknown, max: number) => typeof item === "string" && item.trim().length > 0 && item.length <= max;
  const optionalText = (item: unknown, max: number) => item === undefined || (typeof item === "string" && item.length <= max);
  if (!text(body.id, 256) || !text(body.from, 253) || !text(body.to, 253) || !text(body.claimedDisplayName, 200) || !text(body.ts, 64)) return false;
  if (typeof body.kind !== "string" || !["label_update", "sample_offer", "general"].includes(body.kind)) return false;
  if (!optionalText(body.signature, 1024) || !optionalText(body.certificatePem, 32768)) return false;
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) return false;
  const payload = body.payload as Record<string, unknown>;
  return text(payload.summary, 2000) && optionalText(payload.detail, 20000) && optionalText(payload.specialty, 200) &&
    (payload.affectedPatients === undefined || (typeof payload.affectedPatients === "number" && Number.isFinite(payload.affectedPatients) && payload.affectedPatients >= 0));
}
