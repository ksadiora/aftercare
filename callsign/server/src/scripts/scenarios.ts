/**
 * Runs the scenario catalog against a live server and checks every verdict:
 * each of the five checks has several scenarios that must stop exactly there,
 * and the control must ring the phone. Prints one line per scenario and
 * exits non-zero if any verdict is not the catalogued one.
 *
 *   npm run scenarios                       every scenario, http://localhost:8787
 *   npm run scenarios -- resolve signature  only the scenarios for those checks
 *   npm run scenarios -- tampered replay    only those scenario ids
 *   TARGET=http://localhost:8791 npm run scenarios
 *
 * The control scenario ("brand") really places a call: with a phone paired
 * it rings. Pass --no-call to skip it.
 */
import type { ProofBundle, Scenario, ScenarioResponse, Snapshot, StepId, VerificationResult } from "@callsign/shared";
import { SCENARIO_CHECKS, SCENARIOS } from "@callsign/shared";

const target = (process.env.TARGET ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
const args = process.argv.slice(2);
const noCall = args.includes("--no-call");
const filters = args.filter((a) => !a.startsWith("--"));

const wanted = SCENARIOS.filter((s) => {
  if (noCall && s.expect.outcome === "call") return false;
  if (filters.length === 0) return true;
  return filters.includes(s.id) || filters.includes(s.check);
});
if (wanted.length === 0) {
  console.error(`nothing matches ${filters.join(", ")}. Checks: ${SCENARIO_CHECKS.map((c) => c.id).join(", ")}. Ids: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

const health = await fetch(`${target}/healthz`).then((r) => r.json() as Promise<{ mode: { ans: string; calls: string } }>).catch(() => undefined);
if (!health) {
  console.error(`no Callsign server at ${target} (start one: npm run dev, or PORT=8791 npm run start -w server)`);
  process.exit(2);
}
console.log(`Callsign scenarios → ${target} · ans=${health.mode.ans} calls=${health.mode.calls}\n`);

const W = { check: 13, label: 30, expect: 26, got: 26 };
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
console.log(`${pad("check", W.check)} ${pad("scenario", W.label)} ${pad("expected", W.expect)} ${pad("got", W.got)}   ms`);
console.log("-".repeat(W.check + W.label + W.expect + W.got + 9));

let failures = 0;
let skipped = 0;
for (const s of wanted) {
  if (s.needs === "local" && health.mode.ans !== "local") {
    skipped++;
    console.log(`${pad(s.check, W.check)} ${pad(s.label, W.label)} ${pad(describeExpect(s), W.expect)} ${pad("skipped", W.got)}     -  needs ANS_MODE=local`);
    continue;
  }
  const row = await run(s);
  if (!row.ok) failures++;
  console.log(`${pad(s.check, W.check)} ${pad(s.label, W.label)} ${pad(describeExpect(s), W.expect)} ${pad(row.got, W.got)} ${String(row.ms).padStart(5)}  ${row.ok ? "ok" : "MISMATCH"}${row.detail ? `\n${" ".repeat(W.check + 1)}${row.detail}` : ""}`);
}
const ran = wanted.length - skipped;
console.log(`\n${ran - failures}/${ran} as catalogued${failures ? ` · ${failures} mismatch${failures === 1 ? "" : "es"}` : ""}${skipped ? ` · ${skipped} skipped (ANS_MODE=local only)` : ""}`);
process.exit(failures ? 1 : 0);

async function run(s: Scenario): Promise<{ ok: boolean; got: string; ms: number; detail?: string }> {
  const t0 = Date.now();
  const fired = await fetch(`${target}/api/workbench/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: s.id }),
  });
  if (!fired.ok) return { ok: false, got: `HTTP ${fired.status}`, ms: Date.now() - t0, detail: (await fired.text()).slice(0, 200) };
  const { requestId } = (await fired.json()) as ScenarioResponse;

  // The proof endpoint has the result as soon as the pipeline reports it; poll until the verdict is in.
  let result: VerificationResult | undefined;
  let deliveredCall = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = await fetch(`${target}/api/proof/${encodeURIComponent(requestId)}`);
    if (r.ok) {
      const bundle = (await r.json()) as ProofBundle;
      const state = await fetch(`${target}/api/state`).then((response) => response.json() as Promise<Snapshot>);
      const inbox = state.inbox.find((item) => item.requestId === requestId);
      if (bundle.result.verdict && inbox) {
        result = bundle.result;
        deliveredCall = state.calls.some((call) => call.requestId === requestId);
        break;
      }
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  const ms = Date.now() - t0;
  if (!result) return { ok: false, got: "no verdict in 30 s", ms };

  const failing = result.steps.find((st) => st.status === "fail");
  const got = describeResult(result, failing?.id);
  const ok =
    result.verdict === s.expect.verdict &&
    result.outcome === s.expect.outcome &&
    deliveredCall === (s.expect.outcome === "call") &&
    (s.expect.failsAt ? failing?.id === s.expect.failsAt : true);
  return { ok, got, ms, detail: failing?.detail ?? (result.outcome === "inbox" ? result.steps.find((st) => st.id === "policy")?.detail : undefined) };
}

function describeExpect(s: Scenario): string {
  if (s.expect.failsAt) return `quarantined at ${s.expect.failsAt}`;
  return s.expect.outcome === "inbox" ? "verified · held (inbox)" : "verified · call";
}

function describeResult(r: VerificationResult, failsAt?: StepId): string {
  if (r.verdict === "quarantined") return `quarantined at ${failsAt ?? "?"}`;
  return r.outcome === "inbox" ? "verified · held (inbox)" : r.outcome === "call" ? "verified · call" : `verified · ${r.outcome}`;
}
