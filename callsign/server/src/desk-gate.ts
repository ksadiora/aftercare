import type { DeskSession } from "@callsign/shared/src/desk.ts";
import type { ReachRequest } from "@callsign/shared";
import { deskDeliveryApproved } from "@callsign/shared/src/desk-gate.ts";
import { evaluatePolicy } from "./policy.ts";
import { doctor } from "./seed/data.ts";

/** Recheck at each delivery boundary; a prior policy pass is not permission now. */
export function enforceDeskDelivery(session: DeskSession, request: ReachRequest | undefined): boolean {
  if (!deskDeliveryApproved(session)) {
    session.status = "held";
    session.holdReason = "Held in inbox: verification, doctor policy, and content approval must all complete before delivery.";
    return false;
  }
  const policy = evaluatePolicy({ specialty: request?.payload.specialty, doctorSpecialty: doctor.specialty, doctorName: doctor.name, hasReceipt: true });
  const hasRequest = request?.id === session.verification!.requestId;
  if (!hasRequest || !policy.ok) {
    session.status = "held";
    session.holdReason = hasRequest ? policy.detail : "Held in inbox: the verified request is no longer available.";
    const step = session.verification!.steps.find((step) => step.id === "policy")!;
    step.status = "fail";
    step.detail = session.holdReason;
    step.evidence = policy.evidence;
    session.verification!.outcome = "inbox";
    return false;
  }
  delete session.holdReason;
  return true;
}
