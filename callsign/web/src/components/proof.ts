import type { StepId, VerificationResult, VerificationStep } from "@callsign/shared";
import { shareUrl } from "./shareUrl.ts";

/** Small helpers shared by the proof drawer, the proof page and the trust card. */

export const STEP_SHORT: Record<StepId, string> = {
  resolve: "Resolve",
  certificate: "Certificate",
  transparency: "Log",
  signature: "Signature",
  policy: "Policy",
};

/** Absolute URL of the standalone proof page for a request. */
export function proofUrl(requestId: string, phoneUrls?: string[]): string {
  return shareUrl(`/proof/${encodeURIComponent(requestId)}`, phoneUrls);
}

/** The step the "Proof" button opens: the first failing one, else the last one that ran. */
export function pickProofStep(v: VerificationResult): StepId {
  const failing = v.steps.find((s) => s.status === "fail");
  if (failing) return failing.id;
  const ran = [...v.steps].reverse().find((s) => s.status === "pass" || s.status === "running");
  return ran?.id ?? v.steps[v.steps.length - 1]?.id ?? "resolve";
}

export function stepWord(step: VerificationStep): { word: string; tone?: "green" | "red" | "amber" | "blue" } {
  switch (step.status) {
    case "pass":
      return { word: "Passed", tone: "green" };
    case "fail":
      return step.id === "policy" ? { word: "Held", tone: "amber" } : { word: "Failed", tone: "red" };
    case "running":
      return { word: "Running", tone: "blue" };
    case "skipped":
      return { word: "Skipped" };
    default:
      return { word: "Pending" };
  }
}

/** "Verified", "Verified · held" or "Quarantined", with the tone the UI colors it. */
export function verdictWord(v: VerificationResult): { word: string; tone: "verified" | "held" | "quarantined" | "running" } {
  if (!v.verdict) return { word: "Verifying…", tone: "running" };
  if (v.verdict === "verified" && v.outcome === "quarantine") return { word: "Demo credentials verified · blocked", tone: "quarantined" };
  if (v.verdict === "quarantined") return { word: "Quarantined", tone: "quarantined" };
  if (v.outcome === "inbox") return { word: "Verified · held", tone: "held" };
  return { word: "Verified", tone: "verified" };
}

/** Seconds from start to finish, one decimal. */
export function elapsedSeconds(v: VerificationResult): string {
  const t0 = new Date(v.startedAt).getTime();
  const t1 = v.finishedAt ? new Date(v.finishedAt).getTime() : Date.now();
  if (Number.isNaN(t0) || Number.isNaN(t1)) return "";
  return `${Math.max(0, (t1 - t0) / 1000).toFixed(1)} s`;
}

export function shortHash(s: string, n = 16): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
