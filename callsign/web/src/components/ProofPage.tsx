import { useEffect, useState } from "react";
import type { ProofBundle, VerificationStep } from "@callsign/shared";
import { useCallsign } from "../useCallsign.ts";
import { Evidence } from "./ProofDrawer.tsx";
import { DemoCredentials, IconCheck, IconChevron, IconCross, IconShield, Pill } from "./ui.tsx";
import { elapsedSeconds, stepWord, verdictWord } from "./proof.ts";

type Load = { status: "loading" } | { status: "missing" } | { status: "error"; message: string } | { status: "ok"; bundle: ProofBundle };

/**
 * /proof/:requestId — everything a third party needs to re-check a verdict,
 * on one printable page. No live socket is needed; the bundle is fetched
 * once. A judge lands here from the QR in the proof drawer.
 */
export function ProofPage({ requestId }: { requestId: string }) {
  const { actions } = useCallsign();
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    document.body.classList.add("scroll");
    const prev = document.title;
    document.title = "Verification proof · Callsign";
    return () => {
      document.body.classList.remove("scroll");
      document.title = prev;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    actions
      .proof(requestId)
      .then((b) => {
        if (!alive) return;
        if (!b || typeof b !== "object" || !("result" in b) || !b.result || !b.request) setLoad({ status: "missing" });
        else setLoad({ status: "ok", bundle: b });
      })
      .catch((e: unknown) => {
        if (alive) setLoad({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  return (
    <div className="proof-page">
      <div className="proof-inner">
        <header className="proof-head">
          <a className="wordmark" href="/">
            <span className="wordmark-mark" aria-hidden>
              <IconShield />
            </span>
            Callsign
          </a>
          <h1>Verification proof</h1>
          <p className="proof-lede">
            What Dr. Patel's agent saw when this agent asked to reach her, and why it decided what it did. Every value below is the real record the check
            examined.
          </p>
          <DemoCredentials />
          <a className="link" href="/#identity">Back to identity checks <IconChevron /></a>
        </header>

        {load.status === "loading" && <div className="proof-card proof-state">Loading proof for {requestId}…</div>}
        {load.status === "missing" && (
          <div className="proof-card proof-state">
            <div className="proof-state-title">No such request</div>
            <div className="mono">{requestId}</div>
            <p>This agent has no verification on record for that id. It may have been reset, or the id was mistyped.</p>
          </div>
        )}
        {load.status === "error" && (
          <div className="proof-card proof-state">
            <div className="proof-state-title">Could not load the proof</div>
            <p>{load.message}</p>
          </div>
        )}
        {load.status === "ok" && <Bundle bundle={load.bundle} />}
      </div>
    </div>
  );
}

function Bundle({ bundle }: { bundle: ProofBundle }) {
  const { request, result, registry } = bundle;
  const v = verdictWord(result);
  const failing = result.steps.find((s) => s.status === "fail");
  const policy = result.steps.find((s) => s.id === "policy");
  const reason =
    result.content && result.content.decision !== "allow"
      ? result.content.summary
      : v.tone === "quarantined"
      ? (failing?.detail ?? "Verification failed")
      : v.tone === "held"
        ? (policy?.detail ?? "Held by the doctor's policy")
        : v.tone === "verified"
          ? "Identity, certificate, log receipt and signature all check out."
          : "Still running.";
  const outcome =
    v.tone === "quarantined"
      ? "Phone stayed silent · held in quarantine"
      : v.tone === "held"
        ? "Phone stayed silent · delivered to the inbox"
        : v.tone === "verified"
          ? "Eligible for a call · check the receiver for delivery status"
          : "";
  const elapsed = elapsedSeconds(result);

  return (
    <>
      <section className={`proof-card proof-summary ${v.tone}`}>
        <div className="proof-summary-grid">
          <div>
            <div className="claim-label">Claims to be</div>
            <div className="claim-name">{result.claimedDisplayName}</div>
            <div className="claim-ans">{result.sender}</div>
          </div>
          <div className="proof-verdict">
            <div className={`verdict-word ${v.tone}`}>{v.word}</div>
            <div className="proof-verdict-reason">{reason}</div>
            {outcome && (
              <div className="proof-verdict-outcome">
                {outcome}
                {elapsed && ` · ${elapsed}`}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="proof-card">
        <h2>Checks</h2>
        <ol className="proof-steps">
          {result.steps.map((s, i) => (
            <Step key={s.id} n={i + 1} step={s} />
          ))}
        </ol>
      </section>

      {result.content && <section className="proof-card" aria-label="Content screening decision">
        <h2>Content screening</h2>
        <dl className="kv"><dt>Decision</dt><dd>{result.content.decision}</dd><dt>Reason</dt><dd>{result.content.summary}</dd><dt>Source</dt><dd>{result.content.source}</dd></dl>
      </section>}

      <section className="proof-card">
        <h2>Request</h2>
        <dl className="kv">
          <dt>Request id</dt>
          <dd className="mono">{request.id}</dd>
          <dt>From</dt>
          <dd className="mono">{request.from}</dd>
          <dt>To</dt>
          <dd className="mono">{request.to}</dd>
          <dt>Claimed name</dt>
          <dd>{request.claimedDisplayName}</dd>
          <dt>Kind</dt>
          <dd>{request.kind.replace("_", " ")}</dd>
          <dt>Timestamp</dt>
          <dd className="mono">{request.ts}</dd>
          <dt>Signature</dt>
          <dd className="mono" title={request.signature}>
            {request.signature ? truncateMiddle(request.signature, 40) : "(unsigned)"}
          </dd>
          <dt>Payload hash</dt>
          <dd className="mono">sha256 {request.payloadHash}</dd>
        </dl>
      </section>

      <section className="proof-card">
        <h2>Registry</h2>
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{REGISTRY_WORD[registry.mode] ?? registry.mode}</dd>
          {registry.base && (
            <>
              <dt>Base</dt>
              <dd>
                <a className="mono" href={registry.base} target="_blank" rel="noreferrer">
                  {registry.base}
                </a>
              </dd>
            </>
          )}
          <dt>Verified</dt>
          <dd className="mono">
            {result.startedAt}
            {result.finishedAt ? ` → ${result.finishedAt}` : ""}
          </dd>
        </dl>
      </section>

      <footer className="proof-foot-page">
        <span>Generated {bundle.generatedAt}</span>
        <span className="no-print">
          <a className="link" href={`/api/proof/${encodeURIComponent(request.id)}`} target="_blank" rel="noreferrer">
            Raw bundle (JSON) <IconChevron />
          </a>
          <button type="button" className="link" onClick={() => window.print()}>
            Print <IconChevron />
          </button>
        </span>
      </footer>
    </>
  );
}

const REGISTRY_WORD: Record<ProofBundle["registry"]["mode"], string> = {
  mock: "Mock registry (canned answers, no keys)",
  local: "Local registry (real certificates and log, self-hosted)",
  real: "GoDaddy Agent Name Service",
};

function Step({ n, step }: { n: number; step: VerificationStep }) {
  const w = stepWord(step);
  const hold = step.id === "policy" && step.status === "fail";
  return (
    <li className={`proof-step ${step.status}`} id={`check-${step.id}`}>
      <div className="proof-step-head">
        <span className={`glyph ${step.status} ${hold ? "hold" : ""}`} aria-hidden>
          {step.status === "pass" && <IconCheck />}
          {step.status === "fail" && <IconCross />}
        </span>
        <span className="proof-step-n">{n}</span>
        <span className="proof-step-label">{step.label}</span>
        <Pill tone={w.tone}>{w.word}</Pill>
        {step.ms != null && <span className="proof-step-ms">{step.ms} ms</span>}
      </div>
      {step.detail && <p className={`proof-detail ${step.status} ${hold ? "hold" : ""}`}>{step.detail}</p>}
      <Evidence step={step} />
    </li>
  );
}

function truncateMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}
