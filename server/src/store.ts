import type {
  AuditEntry,
  AuditType,
  CallState,
  InboxItem,
  Negotiation,
  Snapshot,
  VerificationResult,
} from "@callsign/shared";
import { emit, id, nowIso } from "./events.ts";
import { effectiveModes } from "./config.ts";
import { brandIdentity, doctor } from "./seed/data.ts";
import { phoneState } from "./call/app.ts";
import { getPolicy } from "./policy.ts";
import { networkState } from "./network.ts";
import type { ReachRequest } from "@callsign/shared";

/**
 * In-memory state for the demo. Everything here is also emitted as an event
 * so the browser stays in sync. State is intentionally cleared on restart;
 * there is no database connection or background persistence workload.
 */
const state = {
  inbox: [] as InboxItem[],
  verifications: new Map<string, VerificationResult>(),
  requests: new Map<string, ReachRequest>(),
  calls: new Map<string, CallState>(),
  negotiations: new Map<string, Negotiation>(),
  audit: [] as AuditEntry[],
  activeVerificationId: undefined as string | undefined,
  activeCallId: undefined as string | undefined,
  activeNegotiationId: undefined as string | undefined,
  /** The judge's number, kept in memory only, never logged or persisted. */
  phone: undefined as string | undefined,
};

export function snapshot(): Snapshot {
  return {
    doctor: { ...doctor, phone: state.phone ? "set" : undefined },
    brand: brandIdentity,
    mode: effectiveModes(),
    phone: phoneState(),
    policy: getPolicy(),
    network: networkState(),
    inbox: [...state.inbox],
    verifications: [...state.verifications.values()],
    calls: [...state.calls.values()],
    negotiations: [...state.negotiations.values()],
    audit: [...state.audit],
    activeVerificationId: state.activeVerificationId,
    activeCallId: state.activeCallId,
    activeNegotiationId: state.activeNegotiationId,
  };
}

export function setPhone(e164: string | undefined) {
  state.phone = e164;
}
export function getPhone() {
  return state.phone;
}

export function rememberRequest(req: ReachRequest) {
  state.requests.set(req.id, req);
}
export function getRequest(id: string) {
  return state.requests.get(id);
}
export function getVerification(id: string) {
  return state.verifications.get(id);
}

export function upsertVerification(v: VerificationResult, done = false) {
  state.verifications.set(v.requestId, v);
  state.activeVerificationId = v.requestId;
  emit(done ? { type: "verification.done", result: v } : { type: "verification.update", result: v });
}

export function addInbox(item: InboxItem) {
  state.inbox.unshift(item);
  emit({ type: "inbox.add", item });
}

export function upsertCall(c: CallState) {
  state.calls.set(c.id, c);
  state.activeCallId = c.status === "ended" || c.status === "failed" ? state.activeCallId : c.id;
  emit({ type: "call.update", call: c });
}
export function getCall(callId: string) {
  return state.calls.get(callId);
}
export function activeCall() {
  return state.activeCallId ? state.calls.get(state.activeCallId) : undefined;
}

export function upsertNegotiation(n: Negotiation) {
  state.negotiations.set(n.id, n);
  state.activeNegotiationId = n.id;
  emit({ type: "negotiation.update", negotiation: n });
}

export function audit(type: AuditType, summary: string, ref?: string, data?: unknown) {
  const entry: AuditEntry = { id: id("aud"), ts: nowIso(), type, summary, ref, data };
  state.audit.unshift(entry);
  if (state.audit.length > 500) state.audit.length = 500;
  emit({ type: "audit.add", entry });
  return entry;
}

export function reset() {
  state.inbox = [];
  state.verifications.clear();
  state.requests.clear();
  state.calls.clear();
  state.negotiations.clear();
  state.audit = [];
  state.activeVerificationId = undefined;
  state.activeCallId = undefined;
  state.activeNegotiationId = undefined;
  emit({ type: "demo.reset" });
  emit({ type: "snapshot", snapshot: snapshot() });
}
