import type { InboxItem, ReachRequest, VerificationResult } from "@callsign/shared";
import { id, nowIso } from "./events.ts";
import { addInbox, audit, getPhone, rememberRequest, upsertVerification } from "./store.ts";
import { verifyReach } from "./verify/pipeline.ts";
import { placeCall } from "./call/provider.ts";
import { phonePaired } from "./call/app.ts";
import { config, effectiveModes } from "./config.ts";
import type { StepReporter } from "./verify/pipeline.ts";
import { STEP_ORDER } from "@callsign/shared";
import { screenConversation } from "./screening.ts";
import { evaluatePolicy } from "./policy.ts";
import { doctor } from "./seed/data.ts";

interface DeskReachOptions {
  delivery: "desk";
  onStep: StepReporter;
  screen: () => Promise<"allow" | "ask" | "block">;
}

/**
 * THE DOCTOR'S CALLSIGN AGENT
 *
 * One entry point: handleReach(). Runs verification (trust card animates),
 * then does exactly one of three things: place a call, drop it in the inbox,
 * or quarantine it. This file is the seam between the lanes and should stay
 * small. It is owned by whoever is integrating at the time; announce edits.
 */
export async function handleReach(req: ReachRequest, options?: DeskReachOptions): Promise<VerificationResult> {
  // Desk conversations belong to their request-scoped stream, not the public
  // identity workbench's snapshots, proof endpoints, or WebSocket broadcasts.
  if (!options) {
    rememberRequest(req);
    audit("reach", `Inbound request from ${req.from} claiming to be "${req.claimedDisplayName}"`, req.id, {
      kind: req.kind,
      summary: req.payload.summary,
    });
  }

  const result = await verifyReach(req, (partial) => {
    if (options) options.onStep(partial);
    else upsertVerification(partial);
  });
  // The desk owns its receiver. No legacy call, inbox delivery, or content
  // processing may happen before every trust and policy check passes.
  if (options) {
    if (result.verdict === "verified" && result.outcome === "call" && STEP_ORDER.every((id) => result.steps.some((step) => step.id === id && step.status === "pass"))) {
      const decision = await options.screen();
      if (decision !== "allow") result.outcome = decision === "block" ? "quarantine" : "inbox";
    }
    return result;
  }
  // The legacy workbench and /reach endpoint must meet the content gate too.
  let contentReason: string | undefined;
  if (result.outcome === "call") {
    try {
      const content = await screenConversation([{ role: "caller", text: [req.payload.summary, req.payload.detail].filter(Boolean).join("\n") }]);
      result.content = { decision: content.assessment.decision, summary: content.assessment.summary, source: content.assessment.source };
      if (content.assessment.decision !== "allow") {
        result.outcome = content.assessment.decision === "block" ? "quarantine" : "inbox";
        contentReason = `Content screening: ${content.assessment.summary}`;
      }
    } catch {
      result.outcome = "inbox";
      contentReason = "Content screening unavailable · held in inbox";
      result.content = { decision: "ask", summary: contentReason, source: "local" };
    }
    const policy = evaluatePolicy({ specialty: req.payload.specialty, doctorSpecialty: doctor.specialty, doctorName: doctor.name, hasReceipt: true });
    if (result.outcome === "call" && !policy.ok) {
      result.outcome = "inbox";
      const step = result.steps.find((step) => step.id === "policy")!;
      Object.assign(step, { status: "fail", detail: policy.detail, evidence: policy.evidence });
    }
  }
  upsertVerification(result, true);

  const failing = result.steps.find((s) => s.status === "fail");
  audit(
    "verification",
    result.verdict === "verified"
      ? `Verified ${req.from} in ${totalMs(result)} ms → ${result.outcome}`
      : `Quarantined ${req.from}: ${failing?.detail ?? "failed"}`,
    req.id,
  );

  const item: InboxItem = {
    id: id("inb"),
    requestId: req.id,
    from: req.from,
    displayName: req.claimedDisplayName,
    verdict: result.verdict ?? "quarantined",
    reason: contentReason ?? failing?.detail,
    kind: req.kind,
    summary: req.payload.summary,
    detail: req.payload.detail,
    ts: nowIso(),
    outcome: result.outcome ?? "quarantine",
  };

  if (result.outcome === "call") {
    const app = config.calls.provider === "app";
    const phone = getPhone();
    if (!app && effectiveModes().calls === "real" && !phone) {
      item.outcome = "inbox";
      audit("call", "No phone number set; delivered to inbox instead", req.id);
    } else {
      if (app && !phonePaired()) audit("call", "No phone paired; running the simulated call", req.id);
      const call = await placeCall(req, phone ?? "+10000000000");
      item.callId = call.id;
    }
  }

  addInbox(item);
  return result;
}

function totalMs(r: VerificationResult) {
  return r.steps.reduce((n, s) => n + (s.ms ?? 0), 0);
}
