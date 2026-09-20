import { useEffect, useRef } from "react";
import type { CallState, StepId, VerificationResult, VerificationStep } from "@callsign/shared";
import { DemoCredentials, Empty, IconCheck, IconChevron, IconCross, IconShield } from "./ui.tsx";
import { pickProofStep } from "./proof.ts";

/** What the verdict block says while each step runs. */
const RUNNING_WORD: Record<StepId, string> = {
  resolve: "Resolving agent name…",
  certificate: "Verifying certificate…",
  transparency: "Checking transparency log…",
  signature: "Verifying message signature…",
  policy: "Checking the doctor's policy…",
};

const CALL_WORD: Record<CallState["status"], string> = {
  queued: "Calling Dr. Patel's phone…",
  dialing: "Calling Dr. Patel's phone…",
  ringing: "Ringing",
  "in-progress": "On the call",
  ended: "Call ended",
  failed: "Call failed",
};

export function TrustCard({
  verification,
  call,
  doctorName,
  onProof,
}: {
  verification?: VerificationResult;
  call?: CallState;
  doctorName: string;
  /** Open the proof drawer on a step. Each step can explain its evidence or why it was skipped. */
  onProof?: (stepId: StepId) => void;
}) {
  const passed = verification?.steps.filter((s) => s.status === "pass").length ?? 0;

  // When the card is short (network strip above it, small laptop), keep the
  // step that matters in view: the one running, then the one that decided it.
  const listRef = useRef<HTMLOListElement>(null);
  const focusId = verification?.steps.find((s) => s.status === "running")?.id ?? (verification?.verdict ? pickProofStep(verification) : undefined);
  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-step="${focusId}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusId, verification?.requestId]);

  return (
    <section className="card trust" aria-label="Trust card">
      <div className="card-head">
        <span className="card-title">Trust card</span>
        {verification && (
          <span className="card-head-right">
            <span className="card-meta">
              {passed} of {verification.steps.length} checks
            </span>
            {onProof && verification.verdict && (
              <button type="button" className="link" onClick={() => onProof(pickProofStep(verification))} title="Show the evidence behind this verdict">
                Proof <IconChevron />
              </button>
            )}
          </span>
        )}
      </div>
      {!verification ? (
        <Empty
          title={`Waiting for an agent to reach ${doctorName}.`}
          sub="Every caller is verified against the Agent Name Service before the phone rings."
          glyph={<IconShield />}
        />
      ) : (
        <>
          <div className="card-body">
            <div className="claim-label">Claims to be</div>
            <div className="claim-name">{verification.claimedDisplayName}</div>
            <div className="claim-ans">{verification.sender}</div>
            <DemoCredentials />

            <ol className="checks" ref={listRef}>
              {verification.steps.map((s) => (
                <Check key={s.id} step={s} onOpen={onProof ? () => onProof(s.id) : undefined} />
              ))}
            </ol>
          </div>

          <Verdict v={verification} call={call} />
        </>
      )}
    </section>
  );
}

function Check({ step, onOpen }: { step: VerificationStep; onOpen?: () => void }) {
  const clickable = Boolean(onOpen);
  // A failed policy step is a hold, not a broken identity: amber, not red.
  const hold = step.id === "policy" && step.status === "fail";
  return (
    <li
      className={`check ${step.status} ${hold ? "hold" : ""} ${clickable ? "has-proof" : ""}`}
      data-step={step.id}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen?.();
              }
            }
          : undefined
      }
      title={clickable ? "Show evidence" : undefined}
    >
      <span className={`glyph ${step.status} ${hold ? "hold" : ""}`} aria-hidden>
        {step.status === "pass" && <IconCheck />}
        {step.status === "fail" && <IconCross />}
      </span>
      <span className="check-label">{step.label}</span>
      <span className="check-ms">{step.ms != null ? `${step.ms} ms` : ""}</span>
      {step.detail ? (
        <span className="check-detail" title={step.detail}>
          {step.detail}
        </span>
      ) : step.status === "skipped" ? (
        <span className="check-detail">Skipped</span>
      ) : null}
      {clickable && (
        <span className="check-chev" aria-hidden>
          <IconChevron />
        </span>
      )}
    </li>
  );
}

function Verdict({ v, call }: { v: VerificationResult; call?: CallState }) {
  if (!v.verdict) {
    const running = v.steps.find((s) => s.status === "running");
    return (
      <div className="verdict running">
        <div className="verdict-word">{running ? (RUNNING_WORD[running.id] ?? `Checking ${running.label.toLowerCase()}…`) : "Verifying…"}</div>
      </div>
    );
  }

  const failing = v.steps.find((s) => s.status === "fail");

  if (v.verdict === "quarantined" || v.outcome === "quarantine") {
    return (
      <div className="verdict quarantined">
        <div className="verdict-word">{v.verdict === "verified" ? "Demo credentials verified · blocked" : "Quarantined"}</div>
        <div className="verdict-reason">{v.content?.decision === "block" ? v.content.summary : failing?.detail ?? "Verification failed"}</div>
        <div className="verdict-outcome">
          <span className="dot silent" aria-hidden />
          Phone stays silent · held in inbox
        </div>
      </div>
    );
  }

  // Identity checked out, but the doctor's agent is holding the call: in clinic, wrong specialty, no receipt.
  if (v.outcome === "inbox") {
    const policy = v.steps.find((s) => s.id === "policy");
    return (
      <div className="verdict held">
        <div className="verdict-word">Verified · held</div>
        <div className="verdict-reason">{v.content?.decision === "ask" ? v.content.summary : policy?.detail ?? failing?.detail ?? "Held by the doctor's policy"}</div>
        <div className="verdict-outcome">
          <span className="dot silent" aria-hidden />
          Phone stays silent · in inbox
        </div>
      </div>
    );
  }

  const status = call?.status ?? "queued";
  return (
    <div className="verdict verified">
      <div className="verdict-word">Verified</div>
      <div className="verdict-reason">Identity, certificate, log receipt and signature all check out.</div>
      <div className="verdict-outcome">
        <span className={`dot ${status}`} aria-hidden />
        {CALL_WORD[status]}
      </div>
    </div>
  );
}
