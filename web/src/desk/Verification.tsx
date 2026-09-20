import type { DeskRegistry, DeskVerification } from "@callsign/shared/src/desk.ts";

const labels = [
  ["resolve", "ANS resolution"], ["certificate", "Certificate verification"],
  ["transparency", "Transparency log"], ["signature", "Signature & replay protection"],
  ["policy", "Doctor’s policy"], ["content", "Content screening"],
] as const;
const states = { pending: "Waiting", running: "Checking", pass: "Passed", fail: "Stopped", skipped: "Skipped", ask: "Needs context" };

export function Verification({ proof, registry }: { proof?: DeskVerification; registry?: DeskRegistry }) {
  const source = proof?.registry ?? registry;
  const running = proof?.steps.find((step) => step.status === "running");
  return <div className="desk-verification">
    <div className="desk-registry-source">
      <span>GoDaddy Agent Name Service (ANS) verification flow</span>
      <strong>{source?.label ?? "Loading registry source…"}</strong>
      <p>{source?.description ?? "The server reports which registry is actually used."}</p>
      {source && <details><summary>Sender & registry details</summary><p>Server-signed demo agent: <code>{source.sender}</code>. The caller’s name is self-reported; these checks do not authenticate the human.</p><p>Log: <code>{source.logUrl}</code></p><a href="https://developer.godaddy.com/doc/endpoint/ans" target="_blank" rel="noreferrer">GoDaddy public ANS documentation ↗</a></details>}
    </div>
    <p className="desk-verification-live" role="status" aria-live="polite">{running ? `${labels.find(([id]) => id === running.id)?.[1]} in progress` : proof?.finishedAt ? "Verification finished for the latest message" : "Every caller message runs all six checks in order"}</p>
    <ol className="desk-verification-steps" aria-label="Message verification steps">
      {labels.map(([id, label], index) => {
        const step = proof?.steps.find((item) => item.id === id);
        const status = step?.status ?? "pending";
        return <li key={id} className={`desk-verification-step ${status}`} data-step={id} data-status={status}>
          <details><summary><span className="desk-step-number">{status === "pass" ? "✓" : status === "fail" ? "!" : String(index + 1).padStart(2, "0")}</span><span>{label}</span><strong>{states[status]}</strong></summary>
            <div className="desk-step-detail"><p>{step?.detail ?? "Waiting for this check. Later steps run only after earlier checks pass."}</p>{step?.evidence?.map((item, row) => <div key={`${item.label}-${row}`}><b>{item.label}</b><span>{item.value}</span></div>)}{step?.ms !== undefined && <small>{step.ms} ms</small>}</div>
          </details>
        </li>;
      })}
    </ol>
  </div>;
}
