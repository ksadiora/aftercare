/**
 * Contracts of the escalation gate, extracted from Callsign's shared package.
 * Only what the verification pipeline, registry and policy need lives here.
 */
export type AgentRole = "hcp" | "careteam" | "brand" | "impostor";

export interface AgentIdentity {
  name: string; // ANS host, e.g. "lee.callsign-hcp.com"
  role: AgentRole;
  displayName: string;
  organization: string;
  cardUrl: string;
}

export interface DoctorProfile {
  name: string;
  agentName: string;
  specialty: string;
}

export type ReachKind = "escalation" | "label_update" | "sample_offer" | "general";

export interface ReachPayload {
  summary: string;
  detail?: string;
  affectedPatients?: number;
  specialty?: string;
  /** Aftercare case this escalation belongs to. */
  caseId?: string;
  /** The nurse who escalated (self-reported by the care-team service). */
  nurse?: string;
  /** The provider the care team intends to reach. */
  provider?: string;
}

export interface ReachRequest {
  id: string;
  from: string;
  to: string;
  claimedDisplayName: string;
  kind: ReachKind;
  payload: ReachPayload;
  ts: string;
  /** Detached ES256 signature over the canonical JSON of {id,from,to,claimedDisplayName,kind,payload,ts}. */
  signature?: string;
  certificatePem?: string;
}

export type StepId = "resolve" | "certificate" | "transparency" | "signature" | "policy";
export type StepStatus = "pending" | "running" | "pass" | "fail" | "skipped";

export interface VerificationStep {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
  ms?: number;
  evidence?: { label: string; value: string; mono?: boolean }[];
}

export type Verdict = "verified" | "quarantined";
export type Outcome = "call" | "inbox" | "quarantine";

export interface VerificationResult {
  requestId: string;
  sender: string;
  claimedDisplayName: string;
  verdict?: Verdict;
  outcome?: Outcome;
  steps: VerificationStep[];
  startedAt: string;
  finishedAt?: string;
}

export const STEP_LABELS: Record<StepId, string> = {
  resolve: "Resolve agent name",
  certificate: "Verify certificate",
  transparency: "Check transparency log",
  signature: "Verify message signature",
  policy: "Provider's policy",
};

export const STEP_ORDER: StepId[] = ["resolve", "certificate", "transparency", "signature", "policy"];

export function emptyVerification(req: Pick<ReachRequest, "id" | "from" | "claimedDisplayName">): VerificationResult {
  return {
    requestId: req.id,
    sender: req.from,
    claimedDisplayName: req.claimedDisplayName,
    steps: STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: "pending" })),
    startedAt: new Date().toISOString(),
  };
}

export interface DoctorPolicy {
  /** false = the provider is not taking escalations; verified requests are held with a reason. */
  acceptCalls: boolean;
  /** Only escalations addressed to the provider's specialty are delivered. */
  specialtyOnly: boolean;
  requireReceipt: boolean;
  note?: string;
}

export type PolicyUpdateBody = Partial<DoctorPolicy>;

export function nowIso(): string {
  return new Date().toISOString();
}
