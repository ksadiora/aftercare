import { STEP_ORDER } from "./index.ts";
import type { DeskSession } from "./desk.ts";

/** The receiver and server require a completed proof for the latest caller turn. */
export function deskDeliveryApproved(session: DeskSession): boolean {
  const proof = session.verification;
  const caller = session.transcript.filter((turn) => turn.role === "caller").at(-1);
  return Boolean(proof && caller && proof.turnId === caller.id && proof.finishedAt &&
    proof.verdict === "verified" && proof.outcome === "call" &&
    session.assessment.decision === "allow" &&
    [...STEP_ORDER, "content"].every((id) => proof.steps.some((step) => step.id === id && step.status === "pass")));
}
