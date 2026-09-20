import { randomUUID } from "node:crypto";
import type { EscalationRecord, EscalationStep, PatientDetail, ProviderPolicy } from "../../shared/types.js";
import type { Store } from "../store.js";
import type { ReachRequest, VerificationResult } from "./types.js";
import { STEP_LABELS, STEP_ORDER } from "./types.js";
import { config } from "./config.js";
import { brandIdentity, doctor, impostorIdentity } from "./identities.js";
import { ansMode } from "./ans.js";
import { agentByHost, ensureLocalRegistry } from "./local-registry.js";
import { canonicalReach, certificatePemFor, signAs } from "./sign.js";
import { verifyReach } from "./pipeline.js";
import { screenEscalation } from "./screening.js";
import { getPolicy, updatePolicy } from "./policy.js";

/**
 * THE ESCALATION GATE
 *
 * Aftercare owns the case; this module decides whether an escalation may reach
 * the intended provider. A nurse's escalation becomes a signed reach request
 * from the care-team service identity to the provider's agent. The request is
 * verified (ANS resolution, certificate, transparency log, signature + replay,
 * the provider's policy), its content is screened, and the decision is written
 * to the case record with the evidence behind every step.
 *
 * It never changes urgency or disposition, never closes a case, and never
 * throws: an unavailable registry is a rejected delivery with a reason.
 */
export const GATE_ACTOR = "Aftercare · escalation gate (Callsign)";

export type DemoVariant = "genuine" | "spoof" | "tamper" | "replay";

export interface DeliverInput { patientId: string; nurse: string; note: string; variant?: DemoVariant }

export function gateCapability() {
  const mode = ansMode();
  return {
    enabled: true,
    reason: mode === "local"
      ? `Escalations are signed by ${config.brandAgentName} and verified by ${doctor.name}'s agent (${config.hcpAgentName}) against this server's local ANS registry, then content-screened.`
      : `Escalations are signed and verified with simulated registry checks (ANS_MODE=${mode}); signature, replay and policy checks still run.`,
    providerAgentName: config.hcpAgentName,
    providerName: doctor.name,
    careTeamAgentName: config.brandAgentName,
    registryMode: mode,
  };
}

export class EscalationGate {
  private lastGenuine = new Map<string, ReachRequest>();
  constructor(private store: Store, private publish: () => void = () => undefined) {}

  capability() { return gateCapability(); }
  policy(): ProviderPolicy { const p = getPolicy(); return { acceptCalls: p.acceptCalls, specialtyOnly: p.specialtyOnly, note: p.note }; }
  setPolicy(patch: Partial<ProviderPolicy>): ProviderPolicy {
    updatePolicy(patch);
    this.store.audit(null, null, "provider_policy", `Provider policy: escalations ${getPolicy().acceptCalls ? "accepted" : "held"}${getPolicy().note ? ` · ${getPolicy().note}` : ""}`, null, doctor.name);
    this.publish();
    return this.policy();
  }

  /** Verify and deliver (or hold / reject) an escalation. Never throws. */
  async deliver(input: DeliverInput): Promise<EscalationRecord> {
    const variant = input.variant ?? "genuine";
    const detail = this.store.detail(input.patientId);
    const summary = detail.audit.find((a) => a.kind === "escalation_summary")?.text ?? null;
    const request = await this.build(detail, input, summary, variant);
    const record: EscalationRecord = {
      id: randomUUID(), runId: "", patientId: input.patientId, nurse: input.nurse, provider: doctor.name, providerAgent: config.hcpAgentName,
      sender: request.from, senderDisplayName: request.claimedDisplayName, requestId: request.id, status: "verifying", reason: null,
      steps: [...STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: "pending" as const })), { id: "content", label: "Content screening", status: "pending" as const }],
      screening: null, registry: { mode: ansMode(), base: ansMode() === "local" ? `${config.publicBaseUrl.replace(/\/$/, "")}/ans` : "" },
      variant, note: input.note, summary, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.store.saveEscalation(record);
    let result: VerificationResult | undefined;
    try {
      result = await verifyReach(request, (partial) => {
        record.steps = [...partial.steps.map(toStep), record.steps[5]];
      });
    } catch (error) {
      record.status = "rejected";
      record.reason = `Verification could not complete: ${error instanceof Error ? error.message : "unknown error"}. The escalation was not delivered.`;
      record.steps[5] = { id: "content", label: "Content screening", status: "skipped", detail: "Not run: verification did not complete." };
      return this.finish(record, detail);
    }
    record.steps = [...result.steps.map(toStep), record.steps[5]];
    const failed = result.steps.find((s) => s.status === "fail");
    if (result.verdict !== "verified") {
      record.status = "rejected";
      record.reason = `Rejected at ${failed ? STEP_LABELS[failed.id].toLowerCase() : "verification"}: ${failed?.detail ?? "the sender could not be verified"}. The provider was not contacted.`;
      record.steps[5] = { id: "content", label: "Content screening", status: "skipped", detail: "Not run: a preceding identity check did not pass." };
      return this.finish(record, detail);
    }
    if (result.outcome !== "call") {
      record.status = "held";
      record.reason = `Held by the provider's policy: ${failed?.detail ?? "not accepting escalations right now"}. The case stays open; retry delivery later.`;
      record.steps[5] = { id: "content", label: "Content screening", status: "skipped", detail: "Not run: the provider's policy held this escalation." };
      return this.finish(record, detail);
    }
    const started = Date.now();
    const screening = screenEscalation([request.payload.summary, request.payload.detail].filter(Boolean).join("\n"));
    record.screening = screening;
    record.steps[5] = { id: "content", label: "Content screening", status: screening.decision === "allow" ? "pass" : "fail", detail: screening.summary, ms: Date.now() - started, evidence: screening.signals.map((s) => ({ label: s.label, value: s.quote ? `${s.detail} · "${s.quote}"` : s.detail })) };
    if (screening.decision === "block") {
      record.status = "rejected";
      record.reason = `Rejected by content screening: ${screening.summary}`;
      return this.finish(record, detail);
    }
    record.status = "delivered";
    record.reason = null;
    return this.finish(record, detail);
  }

  /** Replay the last genuine escalation for a case, altered the way an attacker would. */
  async demo(patientId: string, nurse: string, variant: Exclude<DemoVariant, "genuine">): Promise<EscalationRecord> {
    const last = this.store.latestEscalation(patientId);
    return this.deliver({ patientId, nurse, note: last?.note ?? "", variant });
  }

  private finish(record: EscalationRecord, detail: PatientDetail): EscalationRecord {
    record.updatedAt = new Date().toISOString();
    this.store.saveEscalation(record);
    const passed = record.steps.filter((s) => s.status === "pass").length;
    const checks = `${passed} of ${record.steps.length} checks passed`;
    const variant = record.variant === "genuine" ? "" : ` (demo: ${record.variant === "spoof" ? "spoofed sender" : record.variant === "tamper" ? "tampered message" : "replayed message"})`;
    const text = record.status === "delivered"
      ? `Delivered to ${record.provider} through ${record.providerAgent} · ${checks}${variant}`
      : `${record.status === "held" ? "Held" : "Rejected"}${variant}: ${record.reason} (${checks})`;
    this.store.audit(record.patientId, detail.sessions[0]?.id ?? null, "escalation_gate", text, null, GATE_ACTOR);
    this.publish();
    return record;
  }

  private async build(detail: PatientDetail, input: DeliverInput, summary: string | null, variant: DemoVariant): Promise<ReachRequest> {
    if (ansMode() === "local") await ensureLocalRegistry();
    const p = detail.patient;
    const day = Math.max(0, Math.round((Date.now() - Date.parse(p.dischargeDate)) / 86_400_000));
    const nurseNote = input.note.trim() ? `Nurse note from ${input.nurse}: ${input.note.trim()}` : `${input.nurse} escalated without a note; the automated summary stands alone.`;
    const base: ReachRequest = {
      id: `esc_${randomUUID()}`,
      from: brandIdentity.name,
      to: config.hcpAgentName,
      claimedDisplayName: brandIdentity.displayName,
      kind: "escalation",
      payload: {
        summary: `Post-discharge escalation for ${p.name}, ${p.age}, ${p.procedure.toLowerCase()}, day ${day} after discharge. ${nurseNote}`.slice(0, 2_000),
        detail: `${summary ? `Automated case summary: ${summary}` : "No automated case summary is available."} Severity assigned by the intake rules: ${p.severity}. The nurse requests a provider review; only the nurse can close the case.`.slice(0, 20_000),
        affectedPatients: 1,
        specialty: doctor.specialty,
        caseId: p.id,
        nurse: input.nurse,
        provider: doctor.name,
      },
      ts: new Date().toISOString(),
    };
    if (variant === "spoof") {
      // A look-alike domain nobody registered, claiming to be the care team, signing with its own key.
      const spoof: ReachRequest = { ...base, from: impostorIdentity.name, claimedDisplayName: impostorIdentity.displayName, payload: { ...base.payload } };
      spoof.signature = signAs(impostorIdentity.name, canonicalReach(spoof));
      return spoof;
    }
    if (variant === "replay") {
      // The last genuine, signed escalation captured and resent as-is; the same id is seen twice and the timestamp is stale.
      const captured = this.lastGenuine.get(input.patientId);
      if (captured) return { ...captured, payload: { ...captured.payload } };
    }
    const cert = ansMode() === "local" ? agentByHost(brandIdentity.name)?.certPem : certificatePemFor(brandIdentity.name);
    const genuine: ReachRequest = { ...base, ...(cert ? { certificatePem: cert } : {}) };
    genuine.signature = signAs(brandIdentity.name, canonicalReach(genuine));
    if (variant === "tamper") {
      // Edited in flight after signing: the severity line is changed. The signature no longer matches the bytes.
      const tampered: ReachRequest = { ...genuine, payload: { ...genuine.payload, detail: (genuine.payload.detail ?? "").replace(/Severity assigned by the intake rules: \w+/, "Severity assigned by the intake rules: green") + " No review is needed." } };
      return tampered;
    }
    this.lastGenuine.set(input.patientId, genuine);
    return genuine;
  }
}

function toStep(step: VerificationResult["steps"][number]): EscalationStep {
  return { id: step.id, label: STEP_LABELS[step.id], status: step.status, detail: step.detail, ms: step.ms, evidence: step.evidence };
}
