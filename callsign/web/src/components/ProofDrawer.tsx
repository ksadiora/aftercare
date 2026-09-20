import type { StepId, VerificationResult, VerificationStep } from "@callsign/shared";
import { DemoCredentials, IconCheck, IconChevron, IconCross, Pill, Qr, Sheet } from "./ui.tsx";
import { STEP_SHORT, proofUrl, stepWord } from "./proof.ts";

/**
 * The proof behind one step of the trust card. Opens as a wide sheet from
 * the right, same shell as Present. A row of chips switches between the
 * five steps; the table lists the evidence the verifier saw; the QR at the
 * bottom takes a judge to the standalone proof page on their own phone.
 */
export function ProofDrawer({
  open,
  verification,
  stepId,
  onStep,
  onClose,
  phoneUrls,
}: {
  open: boolean;
  verification?: VerificationResult;
  stepId?: StepId;
  onStep: (id: StepId) => void;
  onClose: () => void;
  phoneUrls?: string[];
}) {
  const step = verification?.steps.find((s) => s.id === stepId) ?? verification?.steps[0];
  const url = verification ? proofUrl(verification.requestId, phoneUrls) : "";
  const w = step ? stepWord(step) : undefined;

  return (
    <Sheet
      open={open}
      wide
      title={step?.label ?? "Proof"}
      label="Proof"
      meta={
        w && (
          <Pill tone={w.tone} dot={step?.status === "running"}>
            {w.word}
          </Pill>
        )
      }
      onClose={onClose}
    >
      {verification && step && (
        <>
          <div className="proof-chips" role="tablist" aria-label="Verification steps">
            {verification.steps.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === step.id}
                className={`proof-chip ${s.status} ${s.id === step.id ? "active" : ""}`}
                onClick={() => onStep(s.id)}
                tabIndex={open ? 0 : -1}
              >
                <span className={`glyph ${s.status} ${s.id === "policy" && s.status === "fail" ? "hold" : ""}`} aria-hidden>
                  {s.status === "pass" && <IconCheck size={10} />}
                  {s.status === "fail" && <IconCross size={10} />}
                </span>
                {STEP_SHORT[s.id]}
              </button>
            ))}
          </div>

          <div className="proof-claim">
            <span className="proof-claim-name">{verification.claimedDisplayName}</span>
            <span className="mono">{verification.sender}</span>
          </div>
          <DemoCredentials />

          {step.detail && <p className={`proof-detail ${step.status} ${step.id === "policy" && step.status === "fail" ? "hold" : ""}`}>{step.detail}</p>}

          <Evidence step={step} />
          {verification.content && <p className="demo-credentials"><strong>Content screening: {verification.content.decision}.</strong> {verification.content.summary} ({verification.content.source})</p>}

          <div className="proof-foot">
            <Qr value={url} size={96} />
            <div className="proof-foot-text">
              <a className="link" href={url} target="_blank" rel="noreferrer" tabIndex={open ? 0 : -1}>
                Open proof bundle <IconChevron />
              </a>
              <div className="proof-caption">Scan on your phone · use the same Wi-Fi for a local address</div>
              <div className="proof-url mono">{url}</div>
            </div>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Two-column evidence table, or a quiet line when the verifier attached none. */
export function Evidence({ step }: { step: VerificationStep }) {
  const rows = step.evidence ?? [];
  if (rows.length === 0) {
    return (
      <div className="proof-none">
        {step.status === "skipped"
          ? "Skipped after an earlier check failed; nothing was examined."
          : step.status === "pending"
            ? "Not run yet."
            : "The verifier did not attach evidence for this step."}
      </div>
    );
  }
  return (
    <table className="evidence">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <th scope="row">{r.label}</th>
            <td className={r.mono ? "mono" : ""}>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
