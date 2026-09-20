import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Snapshot, StepId, VerificationResult, VerificationStep } from "@callsign/shared";
import { DemoCredentials, IconCheck, IconChevron, IconCross } from "./ui.tsx";
import { STEP_SHORT, elapsedSeconds } from "./proof.ts";

/**
 * THE JUDGE'S WORKBENCH  ("Try to fool it")
 *
 * A judge should not have to take our word for it. Here they compose a
 * request themselves, pick how it is signed, read a prediction of what the
 * five checks will do, send it down the exact same /reach path as every
 * other request, and watch the real verdict arrive. Change an input, watch
 * reality change with it.
 *
 * Talks to server/src/workbench.ts:
 *   GET  /api/workbench/options   names and example text, so nothing is guessed
 *   POST /api/workbench/send      WorkbenchBody → { requestId }
 *
 * Rendered two ways: the standalone /try page (TryPage in this file) and a
 * compact block in the presenter sheet (compact).
 */

export type Identity = "brand" | "custom" | "spoof";

export interface Options {
  brand: { name: string; displayName: string };
  doctorSpecialty: string;
  examples: { lookalike: string; summary: string; phishing: string };
}

export const FALLBACK_OPTIONS: Options = {
  brand: { name: "stelazio.brand-demo.com", displayName: "Stelazio" },
  doctorSpecialty: "Cardiology",
  examples: {
    lookalike: "stelazio-updates.xyz",
    summary: "New renal dosing guidance for Stelazio: reduce to 5 mg once daily when eGFR is below 45.",
    phishing: "URGENT: dosing has changed. Reply with your NPI and DEA number to confirm.",
  },
};

const SPECIALTIES = ["Cardiology", "Nephrology", "Internal Medicine"];

export const IDENTITIES: { id: Identity; label: string; blurb: string }[] = [
  { id: "brand", label: "Demo brand", blurb: "The server signs with the registered demo brand key and attaches its demo registry certificate." },
  { id: "custom", label: "My own domain", blurb: "Send as any domain you type. It gets its own key; no registry knows it." },
  { id: "spoof", label: "Claim the brand's name", blurb: "Send as the brand's exact name, but signed with a different key." },
];

export interface WorkbenchForm {
  identity: Identity;
  from: string;
  displayName: string;
  summary: string;
  specialty: string;
  attachCert: boolean;
  tamper: boolean;
  replay: boolean;
}

export interface Prediction {
  tone: "red" | "amber" | "green";
  text: string;
  /** Where the request is expected to stop; undefined when it should pass or be held. */
  failsAt?: StepId;
  held?: boolean;
}

interface Sent {
  requestId: string;
  at: number;
  prediction: Prediction;
}

/** What the five checks will do with this request, worked out from the choices alone. */
export function predict(f: WorkbenchForm, opts: Options, snapshot?: Snapshot, replayTarget?: VerificationResult): Prediction {
  const brand = opts.brand.name;
  if (f.replay) {
    if (!replayTarget) return { tone: "amber", text: "Nothing to replay yet: send one message with demo brand credentials first, then resend it." };
    return {
      tone: "red",
      failsAt: "signature",
      text: `This will fail at Signature: Dr. Patel's agent has already seen this exact message. A second copy is a replay.`,
    };
  }
  if (f.identity === "custom") {
    const from = normalizeHost(f.from);
    if (!from) return { tone: "red", failsAt: "resolve", text: "Enter a domain to send as. Whatever it is, this will fail at Resolve: no registry knows it." };
    if (from === brand.toLowerCase()) return { tone: "amber", text: `That is the brand's own name. Pick "Claim the brand's name" to spoof it.` };
    return { tone: "red", failsAt: "resolve", text: `This will fail at Resolve: ${from} has no ANS record.` };
  }
  if (f.identity === "spoof") {
    if (f.attachCert) {
      return {
        tone: "red",
        failsAt: "certificate",
        text: `This will fail at Certificate: the attached certificate for ${brand} was not issued by the registry's CA and is not in the transparency log.`,
      };
    }
    return { tone: "red", failsAt: "signature", text: `This will fail at Signature: the message was signed with a key that is not ${brand}'s registered key.` };
  }
  // Real brand.
  if (f.tamper) return { tone: "red", failsAt: "signature", text: "This will fail at Signature: the message no longer matches what was signed." };
  const policy = snapshot?.policy;
  const doctorSpecialty = snapshot?.doctor.specialty ?? opts.doctorSpecialty;
  if (policy && !policy.acceptCalls) {
    return {
      tone: "amber",
      held: true,
      text: `This should pass the identity checks, then be held at Policy: she is not accepting calls${policy.note ? ` (${policy.note.toLowerCase()})` : ""}. Her phone stays silent; it lands in her inbox.`,
    };
  }
  if ((policy?.specialtyOnly ?? true) && f.specialty !== doctorSpecialty) {
    return {
      tone: "amber",
      held: true,
      text: `This should pass the identity checks, then be held at Policy: she practises ${doctorSpecialty} and this is for ${f.specialty}. Her phone stays silent; it lands in her inbox.`,
    };
  }
  const paired = snapshot?.phone.paired ?? true;
  return {
    tone: "green",
    text: `This should pass all five identity and policy checks. Content screening must also approve the message before a call.${paired ? "" : " No phone is paired yet, so pair one below; otherwise call delivery is simulated."}`,
  };
}

export function normalizeHost(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.-]/g, "");
}

/** The most recent request that passed all five checks: the only thing worth replaying. */
function latestVerified(snapshot?: Snapshot): VerificationResult | undefined {
  return snapshot?.verifications
    .filter((v) => v.verdict === "verified")
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
}

/** GET /api/workbench/options, or the fallback when the server is older or away. */
export function fetchOptions(): Promise<Options> {
  return fetch("/api/workbench/options")
    .then((r) => (r.ok ? (r.json() as Promise<Options>) : Promise.reject(new Error(r.statusText))))
    .then((o) => (o?.brand && o.examples ? o : FALLBACK_OPTIONS))
    .catch(() => FALLBACK_OPTIONS);
}

/**
 * "Send as": the three identities, plus the field each one needs (a domain
 * for a look-alike, the forged-certificate switch for a spoof) and the line
 * that says which key signs. Shared by the workbench and the caller page.
 */
export function IdentityPicker({
  form,
  opts,
  onChange,
  tabbable = true,
}: {
  form: Pick<WorkbenchForm, "identity" | "from" | "attachCert">;
  opts: Options;
  onChange: <K extends "identity" | "from" | "attachCert">(k: K, v: WorkbenchForm[K]) => void;
  tabbable?: boolean;
}) {
  const tab = tabbable ? 0 : -1;
  const brand = opts.brand.name;
  const selected = IDENTITIES.find((i) => i.id === form.identity) ?? IDENTITIES[0];
  return (
    <>
      <div className="field">
        <span className="field-label">Send as</span>
        <div className="seg" role="radiogroup" aria-label="Identity">
          {IDENTITIES.map((i) => (
            <button
              key={i.id}
              type="button"
              role="radio"
              aria-checked={form.identity === i.id}
              className={`seg-item ${form.identity === i.id ? "selected" : ""}`}
              onClick={() => onChange("identity", i.id)}
              tabIndex={tab}
            >
              {i.label}
            </button>
          ))}
        </div>
        <div className="field-hint">{selected.blurb}</div>
        <DemoCredentials />
      </div>

      {form.identity === "custom" && (
        <label className="field">
          <span className="field-label">Domain</span>
          <input
            className="input mono"
            value={form.from}
            onChange={(e) => onChange("from", e.target.value)}
            placeholder={opts.examples.lookalike}
            spellCheck={false}
            autoCapitalize="none"
            tabIndex={tab}
          />
        </label>
      )}
      {form.identity === "spoof" && (
        <label className="checkrow">
          <input type="checkbox" checked={form.attachCert} onChange={(e) => onChange("attachCert", e.target.checked)} tabIndex={tab} />
          <span>
            Attach a forged certificate for {brand}
            <span className="checkrow-sub">Self-issued, not from the registry's CA</span>
          </span>
        </label>
      )}
      {(form.identity === "brand" || form.identity === "spoof") && (
        <div className="field-hint mono wb-from">
          from {brand}
          {form.identity === "spoof" ? " · signed with a different key" : " · signed with its registered key"}
        </div>
      )}
    </>
  );
}

export function Workbench({ snapshot, compact, tabbable = true }: { snapshot?: Snapshot; compact?: boolean; tabbable?: boolean }) {
  const [opts, setOpts] = useState<Options>(FALLBACK_OPTIONS);
  const [form, setForm] = useState<WorkbenchForm>({
    identity: "brand",
    from: "",
    displayName: "Stelazio",
    summary: "",
    specialty: "Cardiology",
    attachCert: false,
    tamper: false,
    replay: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchOptions().then((o) => {
      if (!alive) return;
      setOpts(o);
      setForm((f) => ({ ...f, summary: f.summary || o.examples.summary, displayName: f.displayName || o.brand.displayName, specialty: f.specialty || o.doctorSpecialty }));
    });
    return () => {
      alive = false;
    };
  }, []);

  // A reset empties the verifications; forget what was sent with them.
  useEffect(() => {
    if (snapshot && snapshot.verifications.length === 0) setSent(null);
  }, [snapshot?.verifications.length, snapshot]);

  const replayTarget = latestVerified(snapshot);
  useEffect(() => {
    if (!replayTarget && form.replay) setForm((f) => ({ ...f, replay: false }));
  }, [replayTarget, form.replay]);

  const prediction = useMemo(() => predict(form, opts, snapshot, replayTarget), [form, opts, snapshot, replayTarget]);
  const set = <K extends keyof WorkbenchForm>(k: K, v: WorkbenchForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const tab = tabbable ? 0 : -1;

  // The verification this send produced. A replay reuses the original id, so
  // only accept a result that started after we pressed Send.
  const result = sent ? snapshot?.verifications.find((v) => v.requestId === sent.requestId && new Date(v.startedAt).getTime() >= sent.at - 2000) : undefined;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = form.replay && replayTarget
      ? { identity: form.identity, summary: form.summary, replayOf: replayTarget.requestId }
      : {
          identity: form.identity,
          from: form.identity === "custom" ? form.from : undefined,
          displayName: form.displayName,
          summary: form.summary,
          specialty: form.specialty,
          attachCert: form.identity === "spoof" ? form.attachCert : undefined,
          tamper: form.tamper || undefined,
        };
    try {
      const r = await fetch("/api/workbench/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { requestId?: string; error?: string };
      if (!r.ok || !j.requestId) throw new Error(j.error ?? r.statusText ?? "send failed");
      setSent({ requestId: j.requestId, at: Date.now(), prediction });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || !snapshot;

  return (
    <div className={`wb ${compact ? "compact" : ""}`}>
      <form className="wb-form" onSubmit={send}>
        <IdentityPicker form={form} opts={opts} onChange={set} tabbable={tabbable} />

        <div className={`wb-row ${compact ? "" : "two"}`}>
          <label className="field">
            <span className="field-label">Display name</span>
            <input className="input" value={form.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder={opts.brand.displayName} tabIndex={tab} />
          </label>
          <label className="field">
            <span className="field-label">For</span>
            <select className="input" value={form.specialty} onChange={(e) => set("specialty", e.target.value)} tabIndex={tab}>
              {SPECIALTIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field-label">Message</span>
          <textarea
            className="input"
            rows={compact ? 3 : 4}
            value={form.summary}
            onChange={(e) => set("summary", e.target.value)}
            placeholder={opts.examples.summary}
            disabled={form.replay}
            tabIndex={tab}
          />
          {!compact && (
            <div className="field-hint">
              <button type="button" className="link" onClick={() => set("summary", opts.examples.phishing)} tabIndex={tab}>
                Use a phishing message instead <IconChevron />
              </button>
            </div>
          )}
        </label>

        <div className="field">
          <span className="field-label">After signing</span>
          <label className="checkrow">
            <input type="checkbox" checked={form.tamper} onChange={(e) => set("tamper", e.target.checked)} disabled={form.replay} tabIndex={tab} />
            <span>
              Edit the message after it's signed
              <span className="checkrow-sub">Tamper: the dose in the text is changed once the signature is made</span>
            </span>
          </label>
          <label className={`checkrow ${replayTarget ? "" : "off"}`}>
            <input type="checkbox" checked={form.replay} onChange={(e) => set("replay", e.target.checked)} disabled={!replayTarget} tabIndex={tab} />
            <span>
              Resend the last verified message
              <span className="checkrow-sub">
                {replayTarget ? `Replay: the exact bytes of ${replayTarget.requestId}, signature and all` : "Replay: send one message with demo brand credentials first"}
              </span>
            </span>
          </label>
        </div>

        <div className={`wb-predict ${prediction.tone}`} aria-live="polite">
          <span className="dot" aria-hidden />
          <span>{prediction.text}</span>
        </div>

        <button type="submit" className="btn primary full wb-send" disabled={disabled} tabIndex={tab}>
          {busy ? "Sending…" : "Send to Dr. Patel's agent"}
        </button>
        {error && <div className="wb-error">{error}</div>}
      </form>

      {sent && <Result sent={sent} result={result} compact={compact} />}
    </div>
  );
}

/** The live result for one send: the five checks as they run, then the verdict, then the proof link. */
function Result({ sent, result, compact }: { sent: Sent; result?: VerificationResult; compact?: boolean }) {
  const verdict = result ? verdictLine(result) : undefined;
  const matched = verdict && result ? matchesPrediction(sent.prediction, result) : undefined;
  return (
    <section className="wb-result" aria-label="Result" aria-live="polite">
      <div className="wb-result-head">
        <span className="card-title">{result ? "What her agent saw" : "Sent"}</span>
        <span className="card-meta">{result ? `${result.steps.filter((s) => s.status === "pass").length} of ${result.steps.length} checks` : sent.requestId}</span>
      </div>
      {!result ? (
        <div className="wb-waiting">Waiting for Dr. Patel's agent…</div>
      ) : (
        <>
          <div className="wb-claim">
            <span className="claim-label">Claims to be</span>
            <span className="wb-claim-name">{result.claimedDisplayName}</span>
            <span className="claim-ans">{result.sender}</span>
          </div>
          <ol className={`checks ${compact ? "compact" : ""}`}>
            {result.steps.map((s) => (
              <Step key={s.id} step={s} requestId={result.requestId} />
            ))}
          </ol>
          {verdict && (
            <div className={`wb-verdict ${verdict.tone}`}>
              <div className="wb-verdict-word">{verdict.text}</div>
              {matched !== undefined && (
                <div className={`wb-verdict-match ${matched ? "" : "off"}`}>
                  {matched ? "As predicted" : "Not what was predicted"} · {elapsedSeconds(result)}
                </div>
              )}
            </div>
          )}
          {!verdict && <div className="wb-waiting">Verifying…</div>}
          {verdict && (
            <a className="link wb-proof" href={`/proof/${encodeURIComponent(result.requestId)}`} target="_blank" rel="noreferrer">
              See the proof <IconChevron />
            </a>
          )}
        </>
      )}
    </section>
  );
}

export function Step({ step, requestId }: { step: VerificationStep; requestId?: string }) {
  const hold = step.id === "policy" && step.status === "fail";
  return (
    <li className={`check ${step.status} ${hold ? "hold" : ""}`} data-step={step.id}>
      <span className={`glyph ${step.status} ${hold ? "hold" : ""}`} aria-hidden>
        {step.status === "pass" && <IconCheck />}
        {step.status === "fail" && <IconCross />}
      </span>
      <span className="check-label">{requestId ? <a href={`/proof/${encodeURIComponent(requestId)}#check-${step.id}`} target="_blank" rel="noreferrer" title={`View ${step.label} evidence`}>{step.label} <IconChevron /></a> : step.label}</span>
      <span className="check-ms">{step.ms != null ? `${step.ms} ms` : ""}</span>
      {step.detail ? (
        <span className="check-detail" title={step.detail}>
          {step.detail}
        </span>
      ) : step.status === "skipped" ? (
        <span className="check-detail">Skipped</span>
      ) : null}
    </li>
  );
}

function verdictLine(v: VerificationResult): { tone: "green" | "red" | "amber"; text: string } | undefined {
  if (!v.verdict) return undefined;
  const failing = v.steps.find((s) => s.status === "fail");
  if (v.verdict === "verified" && v.outcome === "quarantine") {
    return { tone: "red", text: `Demo credentials verified · blocked: ${v.content?.summary ?? failing?.detail ?? "Content screening did not approve delivery"}` };
  }
  if (v.verdict === "quarantined") {
    return { tone: "red", text: `Quarantined at ${failing ? STEP_SHORT[failing.id] : "verification"}: ${failing?.detail ?? "verification failed"}` };
  }
  if (v.outcome === "inbox") {
    const policy = v.steps.find((s) => s.id === "policy");
    return { tone: "amber", text: `Verified · held: ${v.content?.decision === "ask" ? v.content.summary : policy?.detail ?? failing?.detail ?? "by the doctor's policy"}` };
  }
  return { tone: "green", text: "Verified · calling her phone" };
}

function matchesPrediction(p: Prediction, v: VerificationResult): boolean {
  if (!v.verdict) return false;
  if (v.verdict === "quarantined") {
    const failing = v.steps.find((s) => s.status === "fail");
    return p.tone === "red" && p.failsAt === failing?.id;
  }
  if (v.outcome === "inbox") return p.tone === "amber" && Boolean(p.held);
  return p.tone === "green";
}
