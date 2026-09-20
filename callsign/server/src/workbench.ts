import { Router } from "express";
import type { ReachKind, ReachRequest } from "@callsign/shared";
import { config } from "./config.ts";
import { id, nowIso } from "./events.ts";
import { brandIdentity } from "./seed/data.ts";
import { canonicalReach, certificatePemFor, signAs } from "./verify/sign.ts";
import { ensureForgedCert } from "./agents/brand.ts";
import { handleReach } from "./agent.ts";
import { audit, getRequest } from "./store.ts";
import { registerCallerSession } from "./call/caller.ts";
import { fireScenario, scenarioAvailable, scenarioById } from "./agents/scenarios.ts";
import type { ScenarioBody, ScenarioResponse } from "@callsign/shared";

/**
 * THE JUDGE'S WORKBENCH
 *
 * A judge should not have to take our word for it. This lets them BE the
 * sender: any name, any message, and a choice of how to sign it. The
 * request goes through the exact same /reach path and the same five checks
 * as everything else. Whatever they type, only a message signed by the
 * registered brand's key, unaltered, inside the replay window, gets through.
 *
 *  identity
 *    "brand"   send as the real registered brand agent (its key, its cert)
 *    "custom"  send as a domain the judge types; it gets its own fresh key
 *              and no registry record (this is what a look-alike is)
 *    "spoof"   claim the brand's exact name but sign with a different key,
 *              optionally attaching a self-issued certificate for that name
 *  after signing
 *    tamper    edit the summary after the signature was made
 *    replay    resend a previously verified message (same id, old timestamp)
 */

export interface WorkbenchBody {
  identity: "brand" | "custom" | "spoof";
  from?: string; // custom identity: the domain to send as
  displayName?: string;
  kind?: ReachKind;
  summary: string;
  detail?: string;
  specialty?: string;
  affectedPatients?: number;
  attachCert?: boolean; // spoof: attach the forged certificate
  tamper?: boolean;
  replayOf?: string; // request id to resend
  /** A human will be on the line: the message is their opening line and the call is relayed to them. */
  asCaller?: boolean;
}

export const workbenchRouter = Router();

workbenchRouter.post("/send", async (req, res) => {
  const b = (req.body ?? {}) as WorkbenchBody;
  try {
    const reach = await build(b);
    if (b.asCaller) registerCallerSession(reach.id, reach.claimedDisplayName, `${reach.claimedDisplayName} here. ${reach.payload.summary}`);
    audit("reach", `${b.asCaller ? "Caller" : "Workbench"}: ${describe(b)}`, reach.id);
    res.json({ requestId: reach.id, from: reach.from, signed: Boolean(reach.signature), certificate: Boolean(reach.certificatePem) });
    void handleReach(reach);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * One of the catalogued scenarios (shared SCENARIOS), built and sent by the
 * server because the keys, certificates and the log live here. Same path as
 * everything else: handleReach(). Responds as soon as the request is in
 * flight; the verdict arrives over the WebSocket and in /api/proof/:id.
 */
workbenchRouter.post("/scenario", async (req, res) => {
  const { id: sid } = (req.body ?? {}) as ScenarioBody;
  const scenario = sid ? scenarioById(sid) : undefined;
  if (!scenario) return res.status(400).json({ error: `unknown scenario "${sid ?? ""}"` });
  if (!scenarioAvailable(scenario)) return res.status(409).json({ error: `"${scenario.label}" needs ANS_MODE=local` });
  try {
    const fired = await fireScenario(sid);
    const out: ScenarioResponse = { requestId: fired.requestId, scenario: fired.scenario };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** What the judge can pick from, so the page never guesses names. */
workbenchRouter.get("/options", (_req, res) => {
  res.json({
    brand: { name: brandIdentity.name, displayName: brandIdentity.displayName },
    doctorSpecialty: "Cardiology",
    examples: {
      lookalike: "stelazio-updates.xyz",
      summary: "New renal dosing guidance for Stelazio: reduce to 5 mg once daily when eGFR is below 45.",
      phishing: "URGENT: dosing has changed. Reply with your NPI and DEA number to confirm.",
    },
  });
});

async function build(b: WorkbenchBody): Promise<ReachRequest> {
  if (b.replayOf) {
    const prior = getRequest(b.replayOf);
    if (!prior) throw new Error("nothing to replay: unknown request id");
    // Same id, same signature, same everything; only time has passed.
    return { ...prior, ts: prior.ts };
  }
  const summary = (b.summary ?? "").toString().trim();
  if (!summary) throw new Error("write a message first");
  const kind: ReachKind = b.kind ?? "label_update";
  const specialty = b.specialty?.trim() || "Cardiology";
  const base: Omit<ReachRequest, "from" | "claimedDisplayName" | "signature" | "certificatePem"> = {
    id: id("req"),
    to: config.hcpAgentName,
    kind,
    payload: { summary, detail: b.detail?.trim() || undefined, specialty, affectedPatients: b.affectedPatients ?? 2 },
    ts: nowIso(),
  };

  let reach: ReachRequest;
  if (b.identity === "brand") {
    reach = { ...base, from: brandIdentity.name, claimedDisplayName: b.displayName?.trim() || brandIdentity.displayName };
    reach.signature = signAs(brandIdentity.name, canonicalReach(reach));
    const cert = certificatePemFor(brandIdentity.name);
    if (cert) reach.certificatePem = cert;
  } else if (b.identity === "spoof") {
    reach = { ...base, from: brandIdentity.name, claimedDisplayName: b.displayName?.trim() || brandIdentity.displayName };
    // Sign with a key that is NOT the registered brand's. A fresh key is minted for this name on first use.
    const rogue = "judge-spoof.workbench.invalid";
    reach.signature = signAs(rogue, canonicalReach(reach));
    if (b.attachCert) reach.certificatePem = await ensureForgedCert();
  } else {
    const from = normalizeHost(b.from ?? "");
    if (!from) throw new Error("enter a domain to send as, e.g. stelazio-updates.xyz");
    if (from === brandIdentity.name.toLowerCase()) throw new Error("that is the brand's own name; choose 'Claim the brand's name' to spoof it");
    reach = { ...base, from, claimedDisplayName: b.displayName?.trim() || "Stelazio" };
    reach.signature = signAs(from, canonicalReach(reach)); // its own key; no registry knows it
  }

  if (b.tamper) {
    // Signed above; now change what was signed. Say what changed so the story is on screen.
    reach.payload = { ...reach.payload, summary: tamperText(reach.payload.summary) };
  }
  return reach;
}

function tamperText(s: string): string {
  if (/\b5 mg\b/.test(s)) return s.replace(/\b5 mg\b/, "50 mg");
  if (/\b\d+ mg\b/.test(s)) return s.replace(/\b(\d+) mg\b/, (_m, n) => `${Number(n) * 10} mg`);
  return `${s} Reply with your NPI and DEA number to confirm.`;
}

function normalizeHost(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.-]/g, "");
}

function describe(b: WorkbenchBody): string {
  if (b.replayOf) return `replay of ${b.replayOf}`;
  const who = b.identity === "brand" ? "as the real brand" : b.identity === "spoof" ? `claiming ${brandIdentity.name} with a different key${b.attachCert ? " + forged cert" : ""}` : `as ${b.from}`;
  return `${who}${b.tamper ? ", tampered after signing" : ""} · "${(b.summary ?? "").slice(0, 60)}"`;
}
