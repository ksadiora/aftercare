import type { ReachRequest, Scenario, VerificationResult } from "@callsign/shared";
import { SCENARIOS } from "@callsign/shared";
import { config } from "../config.ts";
import { id, nowIso } from "../events.ts";
import { brandIdentity, hcpIdentity, impostorIdentity, todaysUpdate } from "../seed/data.ts";
import { canonicalReach, certificatePemFor, signAs } from "../verify/sign.ts";
import { issueUnsealedCert, tamperLog } from "../verify/local-registry.ts";
import { ansMode } from "../verify/ans.ts";
import { getPolicy, updatePolicy } from "../policy.ts";
import { handleReach } from "../agent.ts";
import { audit } from "../store.ts";
import { buildBrandReach, buildImpostorReach, ensureForgedCert } from "./brand.ts";

/**
 * THE SCENARIO CATALOG, server side.
 *
 * shared/src/index.ts lists the scenarios a judge can fire; this file is
 * where each one becomes a real ReachRequest. Every scenario goes through
 * handleReach(), the same entry point as anything that arrives on POST
 * /reach, so the trust card, the inbox and the phone react exactly as they
 * would to a stranger on the network. Two scenarios change server state
 * first (the doctor's policy, the local log) and put it back when the
 * verification has finished, whatever happened in between.
 *
 * Keys: the brand and the doctor's agent have registered keys; every other
 * name gets a fresh P-256 key on first use (server/keys/<name>.key), which
 * is precisely the situation of a real look-alike: a key nobody vouches for.
 */

const brandHost = brandIdentity.name.toLowerCase();
const ROGUE_KEY = "judge-spoof.workbench.invalid";
const JUNK_PEM = "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGUsIGp1c3QgYmFzZTY0IG9mIHRoaXMgc2VudGVuY2U=\n-----END CERTIFICATE-----\n";

export function scenarioById(sid: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === sid);
}

/** Whether this server can run the scenario at all (two of them forge inside the local CA / log). */
export function scenarioAvailable(s: Scenario): boolean {
  return s.needs !== "local" || ansMode() === "local";
}

export interface Fired {
  requestId: string;
  scenario: Scenario;
  /** Resolves when the doctor's agent has finished with the request and any prep has been undone. */
  done: Promise<VerificationResult | undefined>;
}

/** Build the request for a scenario, do its prep, send it, undo the prep. Never throws after the build. */
export async function fireScenario(sid: string): Promise<Fired> {
  const scenario = scenarioById(sid);
  if (!scenario) throw new Error(`unknown scenario "${sid}"`);
  if (!scenarioAvailable(scenario)) throw new Error(`"${scenario.label}" needs ANS_MODE=local (this server runs ANS_MODE=${ansMode()})`);
  const reach = await build(sid);
  audit("demo", `Scenario "${scenario.label}" (${sid})${scenario.prep ? ` · ${scenario.prep}` : ""}`, reach.id);

  const undo = prep(sid);
  const done = handleReach(reach)
    .catch((e) => {
      console.warn("[scenario] handleReach failed", (e as Error).message);
      return undefined;
    })
    .finally(undo);
  return { requestId: reach.id, scenario, done };
}

// ---------------------------------------------------------------------------
// Prep: state the scenario needs, and how to put it back
// ---------------------------------------------------------------------------

function prep(sid: string): () => void {
  if (sid === "in-clinic") {
    const before = getPolicy();
    if (before.acceptCalls) updatePolicy({ acceptCalls: false, note: "In clinic (scenario)" });
    return () => {
      if (before.acceptCalls) updatePolicy({ acceptCalls: true, note: before.note ?? "" });
    };
  }
  if (sid === "log-tampered") {
    tamperLog(true);
    return () => {
      tamperLog(false);
      audit("demo", "Transparency log restored");
    };
  }
  return () => undefined;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

async function build(sid: string): Promise<ReachRequest> {
  switch (sid) {
    // resolve
    case "lookalike":
      return buildImpostorReach("no-record");
    case "typosquat":
      return strangerRequest("stelazi0.brand-demo.com");
    case "subdomain-trick":
      return strangerRequest(`${brandHost}.update-portal.xyz`);
    case "borrowed-cert": {
      const req = strangerRequest(impostorIdentity.name);
      const cert = certificatePemFor(brandHost);
      if (cert) req.certificatePem = cert;
      return req;
    }

    // certificate
    case "forged-cert":
      await ensureForgedCert().catch(() => undefined);
      return buildImpostorReach("forged-cert");
    case "wrong-cert": {
      // The doctor's own agent name is the one other registered name in every registry mode.
      const req = base(hcpIdentity.name, brandIdentity.displayName, phishing());
      req.signature = signAs(brandHost, canonicalReach(req));
      const cert = certificatePemFor(brandHost);
      if (cert) req.certificatePem = cert;
      return req;
    }
    case "garbage-cert": {
      const req = base(brandIdentity.name, brandIdentity.displayName, phishing());
      req.signature = signAs(ROGUE_KEY, canonicalReach(req));
      req.certificatePem = JUNK_PEM;
      return req;
    }
    case "expired-cert": {
      // Minted by the local CA in every mode: the mock verifier checks dates too, the local one checks the chain as well.
      const req = genuine();
      req.certificatePem = await issueUnsealedCert(brandHost, brandHost, { notAfter: new Date(Date.now() - 30 * 86400_000) });
      return req;
    }

    // transparency
    case "unsealed-cert": {
      const req = base(brandIdentity.name, brandIdentity.displayName, phishing());
      req.signature = signAs(impostorIdentity.name, canonicalReach(req));
      req.certificatePem = await issueUnsealedCert(brandHost, impostorIdentity.name);
      return req;
    }
    case "log-tampered":
      return genuine();

    // signature
    case "tampered":
      return buildImpostorReach("tampered");
    case "replay":
      return buildImpostorReach("replay");
    case "wrong-key": {
      const req = base(brandIdentity.name, brandIdentity.displayName, phishing());
      req.signature = signAs(ROGUE_KEY, canonicalReach(req));
      return req;
    }
    case "unsigned": {
      const req = genuine();
      delete req.signature;
      return req;
    }
    case "future-dated": {
      const req = base(brandIdentity.name, brandIdentity.displayName, todaysUpdate);
      req.ts = new Date(Date.now() + 10 * 60_000).toISOString();
      req.signature = signAs(brandHost, canonicalReach(req));
      const cert = certificatePemFor(brandHost);
      if (cert) req.certificatePem = cert;
      return req;
    }

    // policy
    case "wrong-specialty":
      return buildImpostorReach("wrong-specialty");
    case "in-clinic":
      return genuine();

    // control
    case "brand":
      return genuine();
    default:
      throw new Error(`no builder for scenario "${sid}"`);
  }
}

/** The genuine brand's update, freshly signed, with its registered certificate. */
function genuine(): ReachRequest {
  return buildBrandReach();
}

/** A sender nobody registered: its own key, claiming to be the brand. */
function strangerRequest(from: string): ReachRequest {
  const req = base(from, brandIdentity.displayName, phishing());
  req.signature = signAs(from, canonicalReach(req));
  return req;
}

function base(from: string, claimedDisplayName: string, body: { summary: string; detail?: string; affectedPatients?: number; specialty?: string }): ReachRequest {
  return {
    id: id("req"),
    from,
    to: config.hcpAgentName,
    claimedDisplayName,
    kind: "label_update",
    payload: { summary: body.summary, detail: body.detail, affectedPatients: body.affectedPatients ?? 7, specialty: body.specialty ?? "Cardiology" },
    ts: nowIso(),
  };
}

/** What impostors actually send: urgency and a request for credentials. */
function phishing() {
  return {
    summary: "URGENT: Stelazio dosing has changed. Confirm your NPI and DEA number to receive the updated prescribing information.",
    detail: "This is a time-sensitive safety communication. Reply within 24 hours to keep your patients' prescriptions active.",
    affectedPatients: 7,
    specialty: "Cardiology",
  };
}
