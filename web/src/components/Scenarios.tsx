import { useCallback, useMemo, useRef, useState } from "react";
import { SCENARIO_CHECKS, SCENARIOS, type ProofBundle, type Scenario, type ScenarioCheck, type ScenarioResponse, type Snapshot, type VerificationResult } from "@callsign/shared";
import { IconChevron } from "./ui.tsx";
import { STEP_SHORT, elapsedSeconds } from "./proof.ts";

/**
 * The scenario deck: several ways to attack each of the five checks, plus
 * the control that rings the phone. One click fires a scenario down the
 * same path as any stranger's request; the card then shows where the
 * doctor's agent stopped it and whether that matches the catalogue. "Run
 * all" walks a whole check (or the whole deck) one scenario at a time, so
 * the trust card on the console can be watched failing at each step in
 * turn. The list itself lives in shared/src/index.ts (SCENARIOS).
 */

interface Run {
  requestId?: string;
  at: number;
  error?: string;
}

type Tone = "green" | "red" | "amber" | "";

export function Scenarios({ snapshot }: { snapshot?: Snapshot }) {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  const cancelled = useRef(false);

  const fire = useCallback(async (s: Scenario): Promise<void> => {
    const at = Date.now();
    setRuns((r) => ({ ...r, [s.id]: { at } }));
    setRunning(s.id);
    try {
      const r = await fetch("/api/workbench/scenario", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id }) });
      const j = (await r.json().catch(() => ({}))) as Partial<ScenarioResponse> & { error?: string };
      if (!r.ok || !j.requestId) throw new Error(j.error ?? r.statusText ?? "send failed");
      const requestId = j.requestId;
      setRuns((prev) => ({ ...prev, [s.id]: { at, requestId } }));
      await awaitVerdict(requestId);
    } catch (e) {
      setRuns((prev) => ({ ...prev, [s.id]: { at, error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setRunning(null);
    }
  }, []);

  const runMany = useCallback(
    async (list: Scenario[]) => {
      cancelled.current = false;
      setQueued(list.map((s) => s.id));
      for (const s of list) {
        if (cancelled.current) break;
        setQueued((q) => q.filter((id) => id !== s.id));
        await fire(s);
      }
      setQueued([]);
    },
    [fire],
  );

  const stop = () => {
    cancelled.current = true;
    setQueued([]);
  };

  const busy = running !== null || queued.length > 0;
  const groups = useMemo(() => SCENARIO_CHECKS.map((c) => ({ ...c, items: SCENARIOS.filter((s) => s.check === c.id) })), []);
  /** The two registry-only scenarios are skipped by "Run all" on a server that is not ANS_MODE=local. */
  const runnable = (list: Scenario[]) => list.filter((s) => s.needs !== "local" || !snapshot || snapshot.mode.ans === "local");
  const summary = useMemo(() => tally(runs, snapshot), [runs, snapshot]);

  return (
    <section className="scn" aria-label="Scenarios">
      <div className="scn-head">
        <div>
          <h2 className="scn-title">Every way in, one check at a time</h2>
          <p className="scn-lede">
            {SCENARIOS.length - 1} attacks and one genuine call, grouped by the check that stops them. Each one is built and sent by the server exactly
            as an outside agent would send it; watch the trust card on the console while they run.
          </p>
        </div>
        <div className="scn-actions">
          {summary.total > 0 && (
            <span className={`scn-tally ${summary.mismatched ? "off" : ""}`} aria-live="polite">
              {summary.matched}/{summary.total} as catalogued{summary.mismatched ? ` · ${summary.mismatched} off` : ""}
            </span>
          )}
          {busy ? (
            <button type="button" className="btn gray" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!snapshot} onClick={() => void runMany(runnable(SCENARIOS))} title="Runs every scenario in order, ending with the genuine brand">
              Run the whole deck
            </button>
          )}
        </div>
      </div>

      {groups.map((g) => (
        <div key={g.id} className={`scn-group ${g.id}`}>
          <div className="scn-group-head">
            <span className={`scn-step ${g.id === "pass" ? "pass" : ""}`} aria-hidden>
              {g.id === "pass" ? "✓" : SCENARIO_CHECKS.findIndex((c) => c.id === g.id) + 1}
            </span>
            <div className="scn-group-text">
              <span className="scn-group-title">{g.title}</span>
              <span className="scn-group-q">{g.question}</span>
            </div>
            {g.items.length > 1 && (
              <button type="button" className="link scn-run-group" disabled={busy || !snapshot} onClick={() => void runMany(runnable(g.items))}>
                Run all {g.items.length} <IconChevron />
              </button>
            )}
          </div>
          <div className="scn-cards">
            {g.items.map((s) => (
              <Card
                key={s.id}
                scenario={s}
                run={runs[s.id]}
                snapshot={snapshot}
                state={running === s.id ? "running" : queued.includes(s.id) ? "queued" : "idle"}
                disabled={busy || !snapshot}
                onRun={() => void fire(s)}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function Card({
  scenario: s,
  run,
  snapshot,
  state,
  disabled,
  onRun,
}: {
  scenario: Scenario;
  run?: Run;
  snapshot?: Snapshot;
  state: "idle" | "running" | "queued";
  disabled: boolean;
  onRun: () => void;
}) {
  const result = resultFor(run, snapshot);
  const outcome = result ? describe(s, result) : undefined;
  const check = s.check === "pass" ? "pass" : s.check;
  const unavailable = s.needs === "local" && snapshot?.mode.ans !== undefined && snapshot.mode.ans !== "local";
  return (
    <article className={`scn-card ${check} ${outcome ? (outcome.matched ? "matched" : "off") : ""}`} data-scenario={s.id}>
      <div className="scn-card-top">
        <span className="scn-card-label">{s.label}</span>
        <button type="button" className={`btn ${s.check === "pass" ? "primary" : "gray"} small`} disabled={disabled || unavailable} onClick={onRun}>
          {state === "running" ? "Running…" : state === "queued" ? "Queued" : result ? "Run again" : s.check === "pass" ? "Call" : "Run"}
        </button>
      </div>
      <p className="scn-card-blurb">{s.blurb}</p>
      <p className="scn-card-sends mono">{s.sends}</p>
      {s.prep && <p className="scn-card-prep">Server side: {s.prep}.</p>}
      {unavailable && <p className="scn-card-prep">Needs the self-hosted registry (ANS_MODE=local); this server runs ANS_MODE={snapshot?.mode.ans}.</p>}
      <div className="scn-card-foot">
        <span className="scn-expect">
          Expected: <b>{expectText(s)}</b>
        </span>
        {run?.error ? (
          <span className="scn-got red">Failed to send: {run.error}</span>
        ) : run && !result ? (
          <span className="scn-got">Sent · verifying…</span>
        ) : outcome ? (
          <span className={`scn-got ${outcome.tone}`}>
            {outcome.text}
            {outcome.matched ? " · as catalogued" : " · not as catalogued"}
            {result && ` · ${elapsedSeconds(result)}`}
          </span>
        ) : null}
        {result && result.verdict && (
          <a className="link scn-proof" href={`/proof/${encodeURIComponent(result.requestId)}`} target="_blank" rel="noreferrer">
            Proof <IconChevron />
          </a>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------

/** Poll the proof endpoint until the verdict is in (the WebSocket carries it too; this just paces "Run all"). */
async function awaitVerdict(requestId: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const r = await fetch(`/api/proof/${encodeURIComponent(requestId)}`);
    if (r.ok) {
      const b = (await r.json()) as ProofBundle;
      if (b.result?.verdict) return;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}

/** The verification this run produced. A replay reuses the original id, so only accept one that started after the click. */
function resultFor(run: Run | undefined, snapshot?: Snapshot): VerificationResult | undefined {
  if (!run?.requestId || !snapshot) return undefined;
  return snapshot.verifications.find((v) => v.requestId === run.requestId && new Date(v.startedAt).getTime() >= run.at - 2000);
}

function expectText(s: Scenario): string {
  if (s.expect.failsAt) return `stopped at ${STEP_SHORT[s.expect.failsAt].toLowerCase()}`;
  return s.expect.outcome === "inbox" ? "verified, held in the inbox" : "verified, the phone rings";
}

function describe(s: Scenario, v: VerificationResult): { text: string; tone: Tone; matched: boolean } {
  if (!v.verdict) return { text: "Verifying…", tone: "", matched: false };
  const failing = v.steps.find((st) => st.status === "fail");
  if (v.verdict === "quarantined") {
    const matched = s.expect.verdict === "quarantined" && (!s.expect.failsAt || failing?.id === s.expect.failsAt);
    return { text: `Quarantined at ${failing ? STEP_SHORT[failing.id].toLowerCase() : "verification"}`, tone: matched ? "green" : "red", matched };
  }
  if (v.outcome === "inbox") {
    const matched = s.expect.verdict === "verified" && s.expect.outcome === "inbox";
    return { text: "Verified · held in the inbox", tone: matched ? "green" : "amber", matched };
  }
  const matched = s.expect.verdict === "verified" && s.expect.outcome === "call";
  return { text: "Verified · calling her phone", tone: matched ? "green" : "red", matched };
}

function tally(runs: Record<string, Run>, snapshot?: Snapshot): { total: number; matched: number; mismatched: number } {
  let total = 0;
  let matched = 0;
  for (const s of SCENARIOS) {
    const v = resultFor(runs[s.id], snapshot);
    if (!v?.verdict) continue;
    total++;
    if (describe(s, v).matched) matched++;
  }
  return { total, matched, mismatched: total - matched };
}

export type { ScenarioCheck };
