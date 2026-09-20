/**
 * Callsign shared contracts.
 *
 * Every module in server/ and web/ speaks these types. If you need to change
 * one, change it here and fix both sides in the same commit.
 */

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

export type AgentRole = "hcp" | "brand" | "impostor";

/** An agent as the rest of the system sees it. `name` is the ANS name (an FQDN). */
export interface AgentIdentity {
  name: string; // e.g. "patel.callsign-hcp.com"
  role: AgentRole;
  displayName: string; // e.g. "Dr. Priya Patel" or "Stelazio"
  organization: string;
  /** Agent Card URL, normally https://<name>/.well-known/agent.json */
  cardUrl: string;
}

export interface DoctorProfile {
  name: string; // "Dr. Priya Patel"
  agentName: string; // ANS name of her Callsign agent
  specialty: string; // "Cardiology"
  npi: string; // 10 digits, fake
  state: string; // "VA"
  licenseNumber: string;
  phone?: string; // E.164, set from the demo panel, never persisted
  callWindow: { start: string; end: string; tz: string }; // "08:00", "18:00"
  patientsOnBrand: number;
}

// ---------------------------------------------------------------------------
// Reach request: the A2A-style message a sender posts to the doctor's agent
// ---------------------------------------------------------------------------

export type ReachKind = "label_update" | "sample_offer" | "general";

export interface ReachPayload {
  summary: string; // one line, read aloud on the call
  detail?: string; // longer text for the inbox
  affectedPatients?: number;
  specialty?: string; // the audience the sender is targeting
}

export interface ReachRequest {
  id: string;
  from: string; // sender's ANS name as claimed in the message
  to: string; // recipient ANS name
  claimedDisplayName: string; // what the sender says it is, e.g. "Stelazio"
  kind: ReachKind;
  payload: ReachPayload;
  ts: string; // ISO
  /** Detached signature over the canonical JSON of {id,from,to,claimedDisplayName,kind,payload,ts}. */
  signature?: string;
  /** PEM of the certificate the sender claims. The verifier never trusts this alone. */
  certificatePem?: string;
}

// ---------------------------------------------------------------------------
// Verification pipeline: what the trust card animates
// ---------------------------------------------------------------------------

export type StepId =
  | "resolve" // ANS name -> DNS records exist for the claimed name
  | "certificate" // cert chain valid and SAN matches the claimed name
  | "transparency" // transparency log receipt checks out
  | "signature" // message signature verifies against the cert key
  | "policy"; // doctor's agent policy: relevance, call window, not muted

export type StepStatus = "pending" | "running" | "pass" | "fail" | "skipped";

export interface VerificationStep {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string; // one line shown under the step, e.g. "no ANS record for stelazio-updates.xyz"
  ms?: number;
  /**
   * The proof behind the verdict, shown when a judge clicks the step.
   * Ordered key/value pairs; values are the real bytes/strings the check saw
   * (DNS record text, certificate subject/SAN/issuer/fingerprint, Merkle leaf
   * index + root hash, signature algorithm + key fingerprint, policy inputs).
   */
  evidence?: { label: string; value: string; mono?: boolean }[];
}

export type Verdict = "verified" | "quarantined";

/** What the doctor's agent decided to do after verification. */
export type Outcome = "call" | "inbox" | "quarantine";

export interface VerificationResult {
  requestId: string;
  sender: string;
  claimedDisplayName: string;
  verdict?: Verdict; // undefined while running
  outcome?: Outcome;
  steps: VerificationStep[];
  startedAt: string;
  finishedAt?: string;
  content?: { decision: "allow" | "ask" | "block"; summary: string; source: "gemini" | "local" };
}

export const STEP_LABELS: Record<StepId, string> = {
  resolve: "Resolve agent name",
  certificate: "Verify certificate",
  transparency: "Check transparency log",
  signature: "Verify message signature",
  policy: "Doctor's policy",
};

export const STEP_ORDER: StepId[] = ["resolve", "certificate", "transparency", "signature", "policy"];

/**
 * Ways an attacker tries to reach the doctor. Each fails at a different
 * step, which is the point: the trust card shows depth, not one red light.
 *  no-record        look-alike domain with no ANS record          → fails resolve
 *  forged-cert      claims the brand's name, presents its own cert → fails certificate
 *  tampered         real brand message, payload edited in flight   → fails signature
 *  replay           real brand message captured earlier, resent    → fails signature (stale/seen)
 *  wrong-specialty  genuine brand, but a nephrology update         → verified, held by policy
 */
export type ImpostorVariant = "no-record" | "forged-cert" | "tampered" | "replay" | "wrong-specialty";

export const IMPOSTOR_VARIANTS: { id: ImpostorVariant; label: string; failsAt: StepId | "none"; blurb: string }[] = [
  { id: "no-record", label: "Look-alike domain", failsAt: "resolve", blurb: "stelazio-updates.xyz has no ANS record" },
  { id: "forged-cert", label: "Forged certificate", failsAt: "certificate", blurb: "claims the brand's name with a self-issued cert" },
  { id: "tampered", label: "Tampered message", failsAt: "signature", blurb: "real signature, edited dosing text" },
  { id: "replay", label: "Replayed message", failsAt: "signature", blurb: "a genuine message captured earlier, resent" },
  { id: "wrong-specialty", label: "Off-topic brand", failsAt: "none", blurb: "verified, but not for a cardiologist" },
];

/** POST /api/demo/impostor */
export interface ImpostorBody {
  variant?: ImpostorVariant;
}

// ---------------------------------------------------------------------------
// Scenario catalog: several ways to exercise each of the five checks.
// One list, read by the /try page (one-click cards), the server (which
// builds and sends each request) and `npm run scenarios` (which asserts
// every verdict). Adding a scenario means adding it here and in
// server/src/agents/scenarios.ts.
// ---------------------------------------------------------------------------

/** Which check a scenario is about; "pass" is the control that should ring the phone. */
export type ScenarioCheck = StepId | "pass";

export interface Scenario {
  id: string;
  check: ScenarioCheck;
  label: string;
  /** What the sender does, in one line. */
  blurb: string;
  /** What actually goes on the wire, for the card's small print. */
  sends: string;
  expect: { verdict: Verdict; outcome: Outcome; failsAt?: StepId };
  /** The server changes something first (a policy toggle, the log) and puts it back afterwards. */
  prep?: string;
  /** Only possible against the self-hosted registry (ANS_MODE=local): the scenario forges inside the CA or the log. */
  needs?: "local";
}

export const SCENARIO_CHECKS: { id: ScenarioCheck; title: string; question: string }[] = [
  { id: "resolve", title: "Resolve agent name", question: "Does the claimed name exist in the Agent Name Service at all?" },
  { id: "certificate", title: "Verify certificate", question: "Did the registry's CA issue a certificate binding that exact name?" },
  { id: "transparency", title: "Check transparency log", question: "Is that certificate sealed in a public, append-only log?" },
  { id: "signature", title: "Verify message signature", question: "Was this message signed by that key, unaltered, recently, once?" },
  { id: "policy", title: "Doctor's policy", question: "Does Dr. Patel want this call right now?" },
  { id: "pass", title: "Control", question: "The genuine brand: every check green, the phone rings." },
];

export const SCENARIOS: Scenario[] = [
  // resolve ------------------------------------------------------------------
  {
    id: "lookalike",
    check: "resolve",
    label: "Look-alike domain",
    blurb: "stelazio-updates.xyz claims to be Stelazio. Its own key, no registry record.",
    sends: "from stelazio-updates.xyz · signed with its own key · no certificate",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "resolve" },
  },
  {
    id: "typosquat",
    check: "resolve",
    label: "Typo-squat",
    blurb: "stelazi0.brand-demo.com: one character off the real name.",
    sends: "from stelazi0.brand-demo.com · signed with its own key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "resolve" },
  },
  {
    id: "subdomain-trick",
    check: "resolve",
    label: "Real name as a prefix",
    blurb: "stelazio.brand-demo.com.update-portal.xyz reads like the brand until the end.",
    sends: "from stelazio.brand-demo.com.update-portal.xyz · signed with its own key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "resolve" },
  },
  {
    id: "borrowed-cert",
    check: "resolve",
    label: "Stolen certificate, wrong domain",
    blurb: "The look-alike attaches the brand's real (public) certificate. A certificate does not make a name exist.",
    sends: "from stelazio-updates.xyz · the brand's genuine certificate attached · signed with the look-alike's key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "resolve" },
  },
  // certificate ---------------------------------------------------------------
  {
    id: "forged-cert",
    check: "certificate",
    label: "Forged certificate",
    blurb: "Claims the brand's exact name and presents a certificate for it, minted by the attacker's own CA.",
    sends: "from stelazio.brand-demo.com · certificate from \"Stelazio Updates Root CA\" · signed with the key inside it",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "certificate" },
  },
  {
    id: "wrong-cert",
    check: "certificate",
    label: "Someone else's certificate",
    blurb: "A registered agent (the doctor's own name, here) presents the brand's certificate. The SAN does not bind its name.",
    sends: "from patel.callsign-hcp.com · the brand's certificate attached · signed with the brand's key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "certificate" },
  },
  {
    id: "garbage-cert",
    check: "certificate",
    label: "Unparseable certificate",
    blurb: "The brand's name with a PEM block that is not a certificate at all.",
    sends: "from stelazio.brand-demo.com · certificatePem is junk · signed with a different key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "certificate" },
  },
  {
    id: "expired-cert",
    check: "certificate",
    label: "Expired certificate",
    blurb: "A certificate the real CA issued for the brand, over the brand's key, that ran out last month.",
    sends: "from stelazio.brand-demo.com · CA-issued certificate, notAfter 30 days ago · signed with the brand's key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "certificate" },
  },
  // transparency --------------------------------------------------------------
  {
    id: "unsealed-cert",
    check: "transparency",
    label: "Mis-issued, never logged",
    blurb: "The CA was tricked into signing the brand's name over the attacker's key. The chain is valid; the log never sealed it.",
    sends: "from stelazio.brand-demo.com · CA-issued certificate that is in no log · signed with the attacker's key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "transparency" },
    needs: "local",
  },
  {
    id: "log-tampered",
    check: "transparency",
    label: "Transparency log altered",
    blurb: "An insider edits one entry of the log. The hash chain breaks, and even the genuine brand cannot get through until it is restored.",
    sends: "the genuine brand message · one chain hash in the local log rewritten for the duration of this send",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "transparency" },
    prep: "log tampered, then restored",
    needs: "local",
  },
  // signature -----------------------------------------------------------------
  {
    id: "tampered",
    check: "signature",
    label: "Tampered in flight",
    blurb: "A genuine brand message whose dose was edited after signing: 5 mg became 50 mg.",
    sends: "from stelazio.brand-demo.com · real certificate · real signature over the original bytes · payload changed",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "signature" },
  },
  {
    id: "replay",
    check: "signature",
    label: "Replayed message",
    blurb: "A genuine message captured earlier and resent unchanged, eleven minutes later.",
    sends: "the last verified brand message · same id · timestamp 11 min in the past",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "signature" },
  },
  {
    id: "wrong-key",
    check: "signature",
    label: "Right name, wrong key",
    blurb: "Claims the brand's name, presents nothing, signs with a key the registry never saw.",
    sends: "from stelazio.brand-demo.com · no certificate · signed with a stranger's key",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "signature" },
  },
  {
    id: "unsigned",
    check: "signature",
    label: "Unsigned",
    blurb: "The brand's name and a plausible message, with no signature at all.",
    sends: "from stelazio.brand-demo.com · real certificate attached · signature missing",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "signature" },
  },
  {
    id: "future-dated",
    check: "signature",
    label: "Dated in the future",
    blurb: "Genuinely signed by the brand, but timestamped ten minutes ahead: outside the clock-skew allowance.",
    sends: "from stelazio.brand-demo.com · real key · ts = now + 10 min",
    expect: { verdict: "quarantined", outcome: "quarantine", failsAt: "signature" },
  },
  // policy --------------------------------------------------------------------
  {
    id: "wrong-specialty",
    check: "policy",
    label: "Off-topic brand",
    blurb: "The genuine brand, a nephrology update. Identity passes; a cardiologist's agent holds it in the inbox.",
    sends: "from stelazio.brand-demo.com · real key · payload.specialty = Nephrology",
    expect: { verdict: "verified", outcome: "inbox" },
  },
  {
    id: "in-clinic",
    check: "policy",
    label: "Doctor in clinic",
    blurb: "The genuine brand while Dr. Patel is not taking calls. Verified, delivered to the inbox, phone silent.",
    sends: "the genuine brand message · policy.acceptCalls = false for the duration of this send",
    expect: { verdict: "verified", outcome: "inbox" },
    prep: "calls held, then restored",
  },
  // control -------------------------------------------------------------------
  {
    id: "brand",
    check: "pass",
    label: "The genuine brand",
    blurb: "Registered name, CA-issued and logged certificate, fresh signature, relevant update. The phone rings.",
    sends: "from stelazio.brand-demo.com · real certificate · real signature · Cardiology",
    expect: { verdict: "verified", outcome: "call" },
  },
];

/** POST /api/workbench/scenario */
export interface ScenarioBody {
  id: string;
}
export interface ScenarioResponse {
  requestId: string;
  scenario: Scenario;
}

// ---------------------------------------------------------------------------
// The doctor's policy: what her agent lets through, beyond identity
// ---------------------------------------------------------------------------

export interface DoctorPolicy {
  /** false = in clinic; verified requests go to the inbox, the phone stays silent. */
  acceptCalls: boolean;
  /** Only requests targeted at her specialty may call; others go to the inbox. */
  specialtyOnly: boolean;
  /** Only senders with a transparency-log receipt may call (always true in this demo). */
  requireReceipt: boolean;
  /** Free text shown on the trust card when calls are held, e.g. "In clinic until 2:00 PM". */
  note?: string;
}

/** POST /api/policy (partial update) */
export type PolicyUpdateBody = Partial<DoctorPolicy>;

// ---------------------------------------------------------------------------
// Network fan-out: the brand reaches every physician on Callsign at once.
// Only Dr. Patel's agent is live; the others are simulated with their own policy.
// ---------------------------------------------------------------------------

export type ReachStatus = "pending" | "verifying" | "called" | "inbox" | "quarantined";

export interface NetworkReach {
  agentName: string;
  doctor: string;
  specialty: string;
  status: ReachStatus;
  reason?: string; // e.g. "in clinic", "not relevant to Nephrology", "called"
  ms?: number;
}

export interface NetworkState {
  broadcastId?: string;
  startedAt?: string;
  reaches: NetworkReach[];
}

/** GET /api/proof/:requestId — everything a third party needs to check the verdict themselves. */
export interface ProofBundle {
  request: Pick<ReachRequest, "id" | "from" | "to" | "claimedDisplayName" | "kind" | "ts" | "signature"> & { payloadHash: string };
  result: VerificationResult;
  registry: { mode: "mock" | "local" | "real"; base?: string };
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export interface InboxItem {
  id: string;
  requestId: string;
  from: string;
  displayName: string;
  verdict: Verdict;
  reason?: string; // for quarantined items, the failing step's detail
  kind: ReachKind;
  summary: string;
  detail?: string;
  ts: string;
  outcome: Outcome;
  callId?: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type CallStatus = "queued" | "dialing" | "ringing" | "in-progress" | "ended" | "failed";

/** How the call is carried. "app" is the in-browser call over Wi-Fi (default). */
export type CallProvider = "app" | "twilio" | "elevenlabs" | "mock";

export interface TranscriptLine {
  role: "agent" | "doctor" | "system";
  text: string;
  ts: string;
}

export interface CallState {
  id: string; // our id
  providerCallId?: string; // ElevenLabs conversation id / Twilio call sid
  requestId: string;
  to: string; // masked for display, e.g. "+1 (540) ***-**42"
  status: CallStatus;
  mock: boolean; // true when no provider keys are set
  provider?: CallProvider;
  /** Display name of the caller the phone shows, e.g. "Stelazio" */
  callerName?: string;
  callerAgent?: string; // ANS name
  transcript: TranscriptLine[];
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  endReason?: "hangup" | "declined" | "no-answer" | "error";
  error?: string;
}

// ---------------------------------------------------------------------------
// The doctor's phone: a browser on the same Wi-Fi, paired to the agent
// ---------------------------------------------------------------------------

export interface PhoneState {
  paired: boolean;
  deviceName?: string; // e.g. "iPhone" or "Judge's phone"
  lastSeen?: string;
  /** URLs the demo panel shows as a QR code so a phone can open the call app. */
  urls: string[];
  /** Voice engine the phone will use. "elevenlabs" needs an API key on the server. */
  voice: "elevenlabs" | "browser";
}

// ---------------------------------------------------------------------------
// Negotiation: agent-to-agent, both sides signed
// ---------------------------------------------------------------------------

export type NegotiationKind = "samples" | "followup" | "rep_visit";

export type NegotiationPhase =
  | "verify_peer"
  | "check_license"
  | "check_eligibility"
  | "propose"
  | "agree"
  | "sign"
  | "done"
  | "failed";

export interface NegotiationEvent {
  phase: NegotiationPhase;
  actor: "hcp" | "brand" | "system";
  text: string; // human-readable transcript line
  ts: string;
  signature?: string;
}

export interface NegotiationReceipt {
  hash: string; // sha256 of the agreed terms
  hcpSignature: string;
  brandSignature: string;
  signedAt: string;
}

export interface Negotiation {
  id: string;
  kind: NegotiationKind;
  requestId?: string;
  callId?: string;
  requestText: string; // what the doctor said, e.g. "send samples for Tuesday"
  terms: Record<string, string>; // e.g. { product, quantity, deliverBy, shipTo }
  events: NegotiationEvent[];
  status: "running" | "agreed" | "failed";
  receipt?: NegotiationReceipt;
  confirmation?: string; // the sentence the voice agent reads back
  startedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type AuditType = "reach" | "verification" | "call" | "tool" | "negotiation" | "demo";

export interface AuditEntry {
  id: string;
  ts: string;
  type: AuditType;
  summary: string;
  ref?: string; // id of the related object
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Snapshot and WebSocket events (server -> web)
// ---------------------------------------------------------------------------

export interface Snapshot {
  doctor: DoctorProfile;
  brand: AgentIdentity;
  mode: { ans: "mock" | "local" | "real"; calls: "mock" | "real"; llm: "mock" | "real"; provider: CallProvider };
  phone: PhoneState;
  policy: DoctorPolicy;
  network: NetworkState;
  inbox: InboxItem[];
  verifications: VerificationResult[];
  calls: CallState[];
  negotiations: Negotiation[];
  audit: AuditEntry[];
  activeVerificationId?: string;
  activeCallId?: string;
  activeNegotiationId?: string;
}

export type ServerEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "verification.update"; result: VerificationResult }
  | { type: "verification.done"; result: VerificationResult }
  | { type: "inbox.add"; item: InboxItem }
  | { type: "call.update"; call: CallState }
  | { type: "call.transcript"; callId: string; line: TranscriptLine }
  | { type: "negotiation.update"; negotiation: Negotiation }
  | { type: "audit.add"; entry: AuditEntry }
  | { type: "phone.update"; phone: PhoneState }
  | { type: "policy.update"; policy: DoctorPolicy }
  | { type: "network.update"; network: NetworkState }
  | { type: "demo.reset" };

// ---------------------------------------------------------------------------
// HTTP API shapes
// ---------------------------------------------------------------------------

/** POST /reach  -> the doctor's agent accepts a ReachRequest */
export interface ReachResponse {
  requestId: string;
  accepted: boolean; // false only for malformed input
  message: string;
}

/** POST /api/demo/phone */
export interface SetPhoneBody {
  phone: string; // anything; server normalizes to E.164 or rejects
}

/** POST /api/demo/impostor and /api/demo/brand-call return this */
export interface DemoTriggerResponse {
  requestId: string;
}

/** ElevenLabs webhook tool: POST /api/tools/label_lookup */
export interface LabelLookupBody {
  question: string;
  conversation_id?: string;
}
export interface LabelLookupResponse {
  answer: string; // under two sentences, safe to read aloud
  citation?: string; // e.g. "Stelazio prescribing information, section 2.3"
  found: boolean;
}

/** ElevenLabs webhook tool: POST /api/tools/request_samples */
export interface RequestSamplesBody {
  request: string; // what the doctor said
  conversation_id?: string;
}
export interface RequestSamplesResponse {
  confirmation: string; // one sentence the agent reads back
  negotiationId: string;
  status: "agreed" | "failed";
}

/** Phone app API (the in-browser call). All under /api/phone. */
export interface PhoneRegisterBody {
  deviceName: string;
}
export interface PhoneTurnBody {
  callId: string;
  text: string; // what the doctor said (speech-to-text runs on the phone)
}
export interface PhoneTurnResponse {
  reply: string; // what the agent says next
  end: boolean; // true when the agent is hanging up after this line
}
export interface PhoneSessionResponse {
  /** ElevenLabs real-time agent session, when configured on the server. */
  signedUrl?: string;
  agentId?: string;
  engine: "elevenlabs" | "browser";
}

/** GET /.well-known/agent.json */
export interface AgentCard {
  name: string; // ANS name
  displayName: string;
  description: string;
  url: string; // base URL of the agent
  protocols: string[]; // ["a2a"]
  capabilities: string[]; // ["reach", "negotiate"]
  publicKeyPem?: string;
  ans?: { registered: boolean; certificateUrl?: string; transparencyLogUrl?: string };
}

// ---------------------------------------------------------------------------
// Small helpers both sides use
// ---------------------------------------------------------------------------

export function emptyVerification(req: Pick<ReachRequest, "id" | "from" | "claimedDisplayName">): VerificationResult {
  return {
    requestId: req.id,
    sender: req.from,
    claimedDisplayName: req.claimedDisplayName,
    steps: STEP_ORDER.map((id) => ({ id, label: STEP_LABELS[id], status: "pending" })),
    startedAt: new Date().toISOString(),
  };
}

export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  const last2 = digits.slice(-2);
  const area = digits.length >= 10 ? digits.slice(-10, -7) : "";
  return area ? `+1 (${area}) ***-**${last2}` : `***-**${last2}`;
}
