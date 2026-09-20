export type Language = 'en' | 'es';
export type Severity = 'unassessed' | 'green' | 'yellow' | 'red' | 'emergency';
export type Disposition = 'open' | 'acknowledged' | 'resolved' | 'escalated';
export type Mode = 'simulation' | 'voice' | 'chat';
export type QuestionId = 'consent' | 'incision' | 'fever' | 'medications' | 'falls' | 'nutrition' | 'transport';
export type EndReason = 'completed' | 'emergency' | 'callback' | 'declined' | 'interrupted' | 'failed';
export type ScenarioId = 'wound' | 'emergency' | 'transport' | 'recovery' | 'interrupted' | 'human';
export interface Patient {
  id: string; name: string; age: number; language: Language; featured: boolean;
  procedure: string; dischargeDate: string; surgeon: string; appointment: string;
  medications: string[]; caregiver: string; initials: string; avatar: string;
  severity: Severity; disposition: Disposition; quote: string; action: string;
  contactStatus: string; lastContact: string | null; mode: Mode | 'seed' | null;
  quoteSource?: Mode | 'seed' | null;
}
export type OutreachState = 'sent' | 'opened' | 'completed';
export interface Outreach {
  id: string; runId: string; patientId: string; token: string; state: OutreachState;
  dueAt: string; createdAt: string; openedAt: string | null; completedAt: string | null;
  /** Set when the care team rings this patient to take their check-in now. */
  ringingSince: string | null;
}
export const outreachLabels: Record<OutreachState, string> = {
  sent: 'Invitation sent \u00b7 not opened', opened: 'Patient opened the check-in', completed: 'Check-in completed',
};
export type HandoffState = 'requested' | 'accepted' | 'connecting' | 'active' | 'ended' | 'declined' | 'timed_out' | 'failed';
export interface Handoff {
  id: string; runId: string; patientId: string; sessionId: string | null; room: string;
  state: HandoffState; reason: string; nurse: string | null; outcome: string | null;
  requestedAt: string; acceptedAt: string | null; endedAt: string | null; joined: ('patient' | 'nurse')[];
  verification: { service: string; verified: boolean; detail: string; at: string } | null;
}
export const handoffLabels: Record<HandoffState, string> = {
  requested: 'Waiting for a nurse', accepted: 'Nurse accepted', connecting: 'Connecting audio', active: 'Nurse and patient talking',
  ended: 'Handoff ended', declined: 'Declined \u00b7 callback task open', timed_out: 'No nurse answered \u00b7 callback task open', failed: 'Handoff failed \u00b7 callback task open',
};
export interface NextStep { instruction: string; done: boolean; reason?: EndReason }
export interface Session {
  id: string; runId: string; patientId: string; mode: Mode; language: Language;
  status: 'connecting' | 'active' | EndReason; startedAt: string; endedAt: string | null;
  questionIndex: number; answers: QuestionId[]; next: NextStep; scenario: ScenarioId | null;
  severity: Severity; providerId: string | null;
  version: number; adaptive: boolean; clarified: QuestionId[]; probed: QuestionId[]; handoff: boolean;
}
export interface Turn { id: string; sessionId: string; role: 'agent' | 'user'; text: string; createdAt: string; language: Language; questionId: QuestionId | null }
export interface Observation { id: string; sessionId: string; severity: Severity; category: string; quote: string; action: string; createdAt: string }
export interface AuditEvent { id: number; patientId: string | null; sessionId: string | null; kind: string; actor: string; text: string; createdAt: string; mode: Mode | 'seed' | null }
/**
 * One message in the conversation a nurse and a provider hold about a case. Both
 * sides read the same thread; it is assembled from the audit trail rather than
 * kept alongside it, so a case can never have a discussion the record does not show.
 */
export interface CaseMessage { id: number; role: 'nurse' | 'provider'; author: string; text: string; at: string }
export interface PatientDetail { patient: Patient; sessions: Session[]; turns: Turn[]; observations: Observation[]; audit: AuditEvent[]; thread: CaseMessage[]; escalation: EscalationRecord | null }
export interface Dashboard { patients: Patient[]; activeSession: Session | null; runId: string; runNumber: number; recent: AuditEvent[]; handoff: Handoff | null; outreach: Outreach[]; /** Cases whose newest message came from a provider, so the worklist can say whose turn it is. */ awaitingNurse: string[] }
export interface Capabilities { voice: boolean; voiceReason: string; maxSessionSeconds: number; chat: boolean; chatReason: string; model: string; handoff: boolean; handoffReason: string; ringSeconds: number; ans: boolean; ansReason: string; careTeam: string; escalationGate: boolean; escalationGateReason: string; providerAgentName: string; providerName: string; careTeamAgentName: string; registryMode: string }
/**
 * The escalation gate (server/callsign/): whether an escalation may reach the
 * intended provider, with the evidence behind each check. Written to the case
 * record beside the audit trail; it never changes urgency or disposition.
 */
export type EscalationStatus = 'verifying' | 'delivered' | 'held' | 'rejected';
export interface EscalationStep { id: 'resolve' | 'certificate' | 'transparency' | 'signature' | 'policy' | 'content'; label: string; status: 'pending' | 'running' | 'pass' | 'fail' | 'skipped'; detail?: string; ms?: number; evidence?: { label: string; value: string; mono?: boolean }[] }
export interface EscalationScreening { decision: 'allow' | 'block'; risk: 'low' | 'medium' | 'high'; summary: string; signals: { label: string; detail: string; quote?: string; severity: 'neutral' | 'warning' | 'danger' }[]; source: 'local' }
export interface EscalationRecord {
  id: string; runId: string; patientId: string; nurse: string; provider: string; providerAgent: string;
  sender: string; senderDisplayName: string; requestId: string; status: EscalationStatus; reason: string | null;
  steps: EscalationStep[]; screening: EscalationScreening | null; registry: { mode: string; base: string };
  /** 'genuine' for a real escalation; the demo variants show what an attacker's copy looks like. */
  variant: 'genuine' | 'spoof' | 'tamper' | 'replay';
  note: string; summary: string | null; createdAt: string; updatedAt: string;
}
export interface ProviderPolicy { acceptCalls: boolean; specialtyOnly: boolean; note?: string }
export interface EscalationView { enabled: boolean; reason: string; providerName: string; providerAgentName: string; careTeamAgentName: string; registryMode: string; escalation: EscalationRecord | null; policy: ProviderPolicy }
export const severityOrder: Record<Severity, number> = { emergency: 0, red: 1, yellow: 2, unassessed: 3, green: 4 };
export const severityLabels: Record<Severity, string> = { emergency: 'Emergency', red: 'Urgent review', yellow: 'Review today', unassessed: 'Not assessed', green: 'No concern detected' };
export const scenarioLabels: Record<ScenarioId, string> = { wound: 'Wound concern', emergency: 'Emergency interrupt', transport: 'Transportation barrier', recovery: 'Uneventful recovery', interrupted: 'Interrupted contact', human: 'Request a person' };
