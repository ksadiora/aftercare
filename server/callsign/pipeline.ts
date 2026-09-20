import type { ReachRequest, VerificationResult, StepId, Outcome } from "./types.js";
import { emptyVerification, nowIso } from "./types.js";
import fs from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { config } from "./config.js";
import { doctor } from "./identities.js";
import {
  ANS_VERSION,
  ansMode,
  ansNameFor,
  badgeInfo,
  certInfo,
  checkCertificate,
  fetchJson,
  normFingerprint,
  parseCertificate,
  publicRootKeys,
  recordsFromTxt,
  resolveAgentDns,
  sealedFingerprints,
  TL_BASE,
  verifyBadge,
  type AnsRecords,
  type Badge,
  type CertInfo,
} from "./ans.js";
import * as local from "./local-registry.js";
import { canonicalReach, publicKeyDerFor, publicKeyPemFor, verifyWithPublicKey } from "./sign.js";
import { checkFreshness, formatClock, markVerified, seenAt } from "./replay.js";
import { badgeEvidence, certEvidence, resolveEvidence, resolveMissEvidence, row, sha256hex, signatureEvidence, sourceRow, type Evidence } from "./evidence.js";

/**
 * VERIFICATION PIPELINE  (owner: Identity lane)
 *
 * Runs the five checks on a ReachRequest and reports each step as it
 * finishes so the trust card animates.
 *
 * Contract:
 *  - call onStep(result) after every step change (running -> pass/fail)
 *  - never throw; a crash inside a step is a "fail" with the error message
 *  - stop at the first failing step; remaining steps become "skipped"
 *  - set result.verdict and result.outcome before returning
 *  - every step attaches `evidence`: the bytes it looked at, pass or fail,
 *    with a final "Source" row that says mock / local / DNS / public log
 *
 * Modes (ANS_MODE):
 *  - mock  : no registry. Resolve/certificate/transparency are canned by name
 *            but the certificate key, the message signature, the replay window
 *            and the policy are still really checked with the keys this server
 *            holds, so every impostor variant still fails where it should.
 *  - local : this server's ANS-shaped registry (verify/local-registry.ts).
 *            Real DNS-record lookup in the local zone (optionally public DNS
 *            first), real X.509 chain + URI-SAN + fingerprint pin against the
 *            local CA, real Merkle inclusion proof + signed checkpoint + hash
 *            chain, real ES256 signature check with the key in the certificate.
 *  - real  : public DNS (node:dns) for `_ans-badge` / `_ans` TXT records,
 *            the sender's presented certificate pinned to the fingerprint
 *            GoDaddy's transparency log sealed, the log's inclusion proof and
 *            checkpoint verified against https://transparency.ans.godaddy.com/root-keys,
 *            then the same signature check.
 *
 * Replay protection (verify/replay.ts) runs inside the signature step in all
 * modes: a message older than 5 min, more than 2 min in the future, or whose
 * (from, id) already passed once in this process is rejected even though its
 * signature is genuine.
 *
 * Spec references: https://github.com/godaddy/ans-registry (ANS-2 §3 cert
 * binding, ANS-3 §3/§6.3 record labels, ANS-4 §3/§5 leaf hash + receipts).
 */
export type StepReporter = (result: VerificationResult) => void;

export interface StepOutcome {
  ok: boolean;
  detail: string;
  evidence?: Evidence[];
}
type StepFn = () => Promise<StepOutcome>;
type Runner = (id: StepId, fn: StepFn, minMs?: number) => Promise<boolean>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimum visible duration per step so the card animates even when a check is instant. */
const MIN_MS: Record<StepId, number> = { resolve: 600, certificate: 600, transparency: 550, signature: 450, policy: 400 };
const DNS_TIMEOUT_MS = 1500;
const HTTP_TIMEOUT_MS = 2500;

// Warm the local registry at boot so the first demo click does not pay for key generation.
if (ansMode() === "local") local.ensureLocalRegistry().catch((e) => console.warn("[ans:local] init failed:", (e as Error).message));

export async function verifyReach(req: ReachRequest, onStep: StepReporter): Promise<VerificationResult> {
  const result = emptyVerification(req);
  onStep(result);

  const run: Runner = async (id, fn, minMs = MIN_MS[id]) => {
    const step = result.steps.find((s) => s.id === id)!;
    step.status = "running";
    onStep({ ...result, steps: result.steps.map((s) => ({ ...s })) });
    const t0 = Date.now();
    let out: StepOutcome;
    try {
      out = await fn();
    } catch (e) {
      const err = e as Error;
      out = { ok: false, detail: err.message || "check crashed", evidence: [row("Error", err.stack ?? String(e))] };
    }
    const remaining = minMs - (Date.now() - t0);
    if (remaining > 0) await sleep(remaining);
    step.status = out.ok ? "pass" : "fail";
    step.detail = out.detail;
    step.ms = Date.now() - t0;
    if (out.evidence?.length) step.evidence = out.evidence.map((e) => ({ label: String(e.label), value: String(e.value), ...(e.mono ? { mono: true } : {}) }));
    onStep({ ...result, steps: result.steps.map((s) => ({ ...s })) });
    return out.ok;
  };

  const skipRest = (after: StepId) => {
    let seen = false;
    for (const s of result.steps) {
      if (seen) s.status = "skipped";
      if (s.id === after) seen = true;
    }
  };

  const mode = ansMode();
  if (mode === "mock") return verifyMock(req, result, run, skipRest, onStep);

  // ---- LOCAL / REAL ---------------------------------------------------------
  const host = req.from.trim().toLowerCase();
  const ctx: { records?: AnsRecords; ansName?: string; cert?: { publicKeyPem: string; fingerprint: string; keyFingerprint: string }; badge?: Badge; badgeSource?: string } = {};
  const localSource = () => `local registry zone · this server ${local.localLogIdentity().base}/dns/{name}`;

  const ok1 = await run("resolve", async () => {
    if (mode === "real" || process.env.ANS_LOCAL_PUBLIC_DNS === "1") {
      const r = await resolveAgentDns(host, { timeoutMs: mode === "real" ? DNS_TIMEOUT_MS : 1200 });
      const source = `public DNS via node:dns${r.trace?.servers.length ? ` (${r.trace.servers.join(", ")})` : ""}`;
      if (r.ok && r.records) {
        ctx.records = r.records;
        return { ok: true, detail: r.detail, evidence: resolveEvidence(r.records, { source, trace: r.trace, ansName: ansNameFor(host, r.records.badge.version ?? ANS_VERSION) }) };
      }
      if (mode === "real") return { ok: false, detail: r.detail, evidence: resolveMissEvidence(host, { source, trace: r.trace }) };
      // local: public DNS had nothing; fall back to the local zone below.
    }
    await local.ensureLocalRegistry();
    const txt = local.zoneTxtForHost(host);
    const records = recordsFromTxt(host, txt, "local");
    if (!records) return { ok: false, detail: `no ANS record for ${host}`, evidence: resolveMissEvidence(host, { source: localSource(), registered: local.registeredHosts(), zoneAnswers: txt }) };
    ctx.records = records;
    const version = records.badge.version ?? ANS_VERSION;
    return {
      ok: true,
      detail: `_ans-badge.${host} TXT → v=ans-badge1 · version v${version} · local registry zone`,
      evidence: resolveEvidence(records, { source: localSource(), ansName: ansNameFor(host, version) }),
    };
  });
  if (!ok1) return finish(result, "quarantined", "quarantine", "resolve", skipRest, onStep);

  const ok2 = await run("certificate", async () => {
    const records = ctx.records!;
    const version = records.badge.version ?? ANS_VERSION;
    const ansName = ansNameFor(host, version);
    ctx.ansName = ansName;

    if (mode === "real") {
      // Pin the presented certificate to the fingerprint the transparency log sealed for this agent.
      // The badge itself (inclusion proof, checkpoint) is verified in the next step.
      const caPem = readOptionalFile(process.env.ANS_CA_PEM_FILE);
      const caCn = caPem ? cnOfPem(caPem) : undefined;
      let sealed: string | undefined;
      const url = records.badge.url;
      if (url.toLowerCase().startsWith(`${TL_BASE.toLowerCase()}/`)) {
        const b = await fetchJson<Badge>(url, HTTP_TIMEOUT_MS);
        if (b.ok && b.body) {
          ctx.badge = b.body;
          ctx.badgeSource = url;
          const fps = sealedFingerprints(b.body.payload?.producer?.event);
          const presented = parseCertificate(req.certificatePem);
          sealed = presented ? (fps.find((f) => f === certInfo(presented).fingerprint) ?? fps[0]) : fps[0];
        }
      }
      const c = checkCertificate(req.certificatePem, { expectedAnsName: ansName, caPem, expectedFingerprint: sealed });
      const evidence = certEvidence(c.info, {
        presentedBy: "sender (certificatePem in the message)",
        expectedAnsName: ansName,
        sealedFingerprint: sealed,
        trustedCa: caCn ?? "not pinned (set ANS_CA_PEM_FILE to GoDaddy's ANS CA)",
        source: `presented certificate · sealed fingerprint from ${ctx.badgeSource ?? "transparency log (unreachable here; anchored in next step)"}`,
      });
      if (c.ok) ctx.cert = { publicKeyPem: c.publicKeyPem!, fingerprint: c.fingerprint!, keyFingerprint: c.info!.keyFingerprint };
      return { ok: c.ok, detail: c.ok && !sealed ? `${c.detail} · fingerprint anchored in next step` : c.detail, evidence };
    }

    // local
    const agentId = records.badge.agentId ?? "";
    const agent = local.agentById(agentId);
    if (!agent) return { ok: false, detail: `badge points at unknown agent ${agentId || "(none)"}`, evidence: [row("Badge agent id", agentId || "(none)", true), row("Registered ids", local.registeredHosts().map((h) => `${h} → ${local.agentByHost(h)?.agentId}`).join(" · "), true), sourceRow(localSource())] };
    const caPem = local.localCaPem();
    const caCn = caPem ? cnOfPem(caPem) : undefined;
    const presented = Boolean(req.certificatePem?.includes("BEGIN CERTIFICATE"));
    const pem = presented ? req.certificatePem : agent.certPem;
    // This step answers "did the CA issue this certificate for this name?". Whether the
    // log ever sealed it is the next step's question, so a presented certificate is
    // not pinned here: a CA-issued but unsealed one must fail at "transparency".
    const c = checkCertificate(pem, { expectedAnsName: ansName, caPem, expectedFingerprint: presented ? undefined : agent.certFingerprint });
    const evidence = certEvidence(c.info, {
      presentedBy: presented ? "sender (certificatePem in the message)" : "registry copy · sender presented no certificate",
      expectedAnsName: ansName,
      sealedFingerprint: agent.certFingerprint,
      trustedCa: caCn,
      source: `local registry · CA ${local.localLogIdentity().base}/ca.pem · sealed fingerprint from ${agent.badgeUrl}`,
    });
    if (!c.ok) return { ok: false, detail: presented ? `presented certificate rejected: ${c.detail}` : c.detail, evidence };
    ctx.cert = { publicKeyPem: c.publicKeyPem!, fingerprint: c.fingerprint!, keyFingerprint: c.info!.keyFingerprint };
    return { ok: true, detail: c.detail, evidence };
  });
  if (!ok2) return finish(result, "quarantined", "quarantine", "certificate", skipRest, onStep);

  const ok3 = await run("transparency", async () => {
    const records = ctx.records!;
    let badge: Badge | undefined;
    let rootKeysText: string;
    let logBase: string;
    let source: string;
    let badgeUrl: string;
    if (mode === "real") {
      badgeUrl = records.badge.url;
      logBase = TL_BASE;
      source = `${TL_BASE} (public log) · root keys ${TL_BASE}/root-keys`;
      if (!badgeUrl.toLowerCase().startsWith(`${TL_BASE.toLowerCase()}/`)) return { ok: false, detail: `badge URL ${badgeUrl} is outside the trusted log ${TL_BASE}`, evidence: badgeEvidence(undefined, { badgeUrl, logBase, source }) };
      if (ctx.badge) badge = ctx.badge;
      else {
        const b = await fetchJson<Badge>(badgeUrl, HTTP_TIMEOUT_MS);
        if (!b.ok) return { ok: false, detail: `transparency log unreachable: ${b.detail}`, evidence: badgeEvidence(undefined, { badgeUrl, logBase, source }) };
        badge = b.body;
      }
      const k = await publicRootKeys();
      if (!k.ok || !k.text) return { ok: false, detail: k.detail, evidence: badgeEvidence(badgeInfo(badge), { badgeUrl, logBase, source }) };
      rootKeysText = k.text;
    } else {
      const id = local.localLogIdentity();
      badge = local.badgeFor(records.badge.agentId ?? "");
      rootKeysText = local.localRootKeysText();
      logBase = `${id.base} (origin ${id.origin})`;
      badgeUrl = records.badge.url;
      source = `local transparency log · this server ${id.base}/v1/agents/{agentId} · root keys ${id.base}/root-keys`;
    }
    const fp = ctx.cert!.fingerprint;
    const v = verifyBadge(badge, { expectedAnsName: ctx.ansName!, rootKeysText });
    const chain = mode === "local" ? local.verifyChain() : undefined;
    const evidence = badgeEvidence(v.info, { badgeUrl, logBase, certFingerprint: fp, chain, source });
    if (!v.ok) return { ok: false, detail: v.detail, evidence };
    if (!v.identityFingerprints!.some((f) => normFingerprint(f) === fp)) return { ok: false, detail: "certificate fingerprint is not sealed in the transparency log", evidence };
    if (mode === "local") {
      if (!chain?.ok) return { ok: false, detail: "local log hash chain is broken · the log has been altered since it was sealed", evidence };
      return { ok: true, detail: `${v.detail} · cert fingerprint sealed · hash chain ok`, evidence };
    }
    return { ok: true, detail: `${v.detail} · cert fingerprint sealed`, evidence };
  });
  if (!ok3) return finish(result, "quarantined", "quarantine", "transparency", skipRest, onStep);

  const ok4 = await run("signature", async () =>
    signatureStep(req, {
      publicKeyPem: ctx.cert!.publicKeyPem,
      keyDescription: `key in the identity certificate for ${ctx.ansName}`,
      keyFingerprint: ctx.cert!.keyFingerprint,
      source: mode === "real" ? "presented certificate, pinned to the public transparency log" : "certificate pinned to the local registry",
    }),
  );
  if (!ok4) return finish(result, "quarantined", "quarantine", "signature", skipRest, onStep);

  const ok5 = await run("policy", policyStep(req));
  if (!ok5) return finish(result, "verified", "inbox", "policy", skipRest, onStep);

  return finish(result, "verified", "call", undefined, skipRest, onStep);
}

// ---------------------------------------------------------------------------

/**
 * Signature + replay window, shared by every mode. Order matters for the story:
 * first "is this really the brand's signature", then "is it fresh and unseen",
 * so a replayed message reads "signature valid · but 11 min old · id already verified".
 */
async function signatureStep(req: ReachRequest, key: { publicKeyPem: string; keyDescription: string; keyFingerprint?: string; source: string }): Promise<StepOutcome> {
  const ev = (o: { signatureValid: boolean | undefined; freshness?: ReturnType<typeof checkFreshness>; seen?: number }) =>
    signatureEvidence(req, { keyDescription: key.keyDescription, keyFingerprint: key.keyFingerprint, signatureValid: o.signatureValid, freshness: o.freshness, seenAt: o.seen, source: key.source });

  if (!req.signature) return { ok: false, detail: "message is unsigned", evidence: ev({ signatureValid: undefined }) };
  const valid = verifyWithPublicKey(key.publicKeyPem, canonicalReach(req), req.signature);
  if (!valid) return { ok: false, detail: `signature does not match message body · ${key.keyDescription}`, evidence: ev({ signatureValid: false }) };

  if (req.to.trim().toLowerCase() !== config.hcpAgentName.toLowerCase()) {
    return { ok: false, detail: "signed recipient does not match this doctor's agent", evidence: [
      ...ev({ signatureValid: true }), row("Signed recipient", req.to), row("Expected recipient", config.hcpAgentName),
    ] };
  }

  const freshness = checkFreshness(req.ts);
  const seen = seenAt(req.from, req.id);
  const problems: string[] = [];
  if (!freshness.ok) problems.push(freshness.detail);
  if (seen !== undefined) problems.push(`message id already verified at ${formatClock(seen)}`);
  if (problems.length) return { ok: false, detail: `signature valid, but ${problems.join(" · ")}`, evidence: ev({ signatureValid: true, freshness, seen }) };

  markVerified(req.from, req.id);
  return { ok: true, detail: `ES256 signature valid for the ${key.keyDescription} · ${freshness.detail} · id not seen before`, evidence: ev({ signatureValid: true, freshness }) };
}

function policyStep(req: ReachRequest): StepFn {
  return async () => {
    // Identity is settled by the time we get here; this is whether Dr. Patel wants the call now.
    const { evaluatePolicy } = await import("./policy.js");
    const r = evaluatePolicy({ specialty: req.payload.specialty, doctorSpecialty: doctor.specialty, doctorName: doctor.name, hasReceipt: true });
    return { ok: r.ok, detail: r.detail, evidence: [...r.evidence, sourceRow("doctor's policy · this server, live toggles from the Present sheet")] };
  };
}

function readOptionalFile(p?: string): string | undefined {
  if (!p) return undefined;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function cnOfPem(pem: string): string | undefined {
  try {
    return /CN=([^\n,]+)/.exec(new X509Certificate(pem).subject)?.[1];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// MOCK
// ---------------------------------------------------------------------------

/**
 * ANS_MODE=mock: no registry anywhere, timings tuned so the card takes ~3.5 s.
 * Resolve and transparency are canned by name. The certificate step still
 * parses whatever the sender presented and checks its key is the brand's
 * registered key (this server holds the brand's key), the signature step is a
 * real ES256 check against that key plus the replay window, and the policy
 * step is the real one, so every impostor variant fails at the documented step.
 */
async function verifyMock(req: ReachRequest, result: VerificationResult, run: Runner, skipRest: (after: StepId) => void, onStep: StepReporter) {
  const host = req.from.trim().toLowerCase();
  const brandHost = config.brandAgentName.toLowerCase();
  // Only the two registered names resolve; a typo-squat or a "real name as a prefix" domain must not.
  const isImpostor = host !== brandHost && host !== config.hcpAgentName.toLowerCase();
  const ansName = ansNameFor(host);
  const mockAgentId = `${sha256hex(`mock-agent:${host}`).slice(0, 8)}-0000-4000-8000-${sha256hex(`mock-id:${host}`).slice(0, 12)}`;
  const mockBadgeUrl = `${TL_BASE}/v1/agents/${mockAgentId}`;
  const MOCK = "mock · no registry queried";

  const ok1 = await run(
    "resolve",
    async () => {
      await sleep(700);
      if (isImpostor) return { ok: false, detail: `no ANS record for ${req.from}`, evidence: [row("Query", `_ans-badge.${host} TXT`, true), row("Answer", "NXDOMAIN · no such name", true), row("Also tried", `_ans.${host} TXT → NXDOMAIN`, true), row("Registered agents", `${config.hcpAgentName}, ${brandHost}`, true), sourceRow(MOCK)] };
      return {
        ok: true,
        detail: `${req.from} → _ans SVCB + TXT records found`,
        evidence: [row("Query", `_ans-badge.${host} TXT`, true), row("Answer", `v=ans-badge1; version=v${ANS_VERSION}; url=${mockBadgeUrl}`, true), row(`_ans.${host} TXT`, `v=ans1; version=v${ANS_VERSION}; p=a2a; mode=direct; url=https://${host}/reach`, true), row("Badge URL", mockBadgeUrl, true), row("Agent id", mockAgentId, true), row("Version", `v${ANS_VERSION}`), row("ANS name", ansName, true), sourceRow(MOCK)],
      };
    },
    0,
  );
  if (!ok1) return finish(result, "quarantined", "quarantine", "resolve", skipRest, onStep);

  // The key the signature step will use: the certificate's if one was presented and it is the brand's, else the brand key on disk.
  let keyPem = "";
  let keyDescription = "";
  let keyFingerprint: string | undefined;
  const ok2 = await run(
    "certificate",
    async () => {
      await sleep(800);
      const brandKeyPem = publicKeyPemFor(brandHost);
      const brandKeyFp = createHash("sha256").update(publicKeyDerFor(brandHost)).digest("hex"); // SPKI DER, same as certInfo().keyFingerprint
      const presented = parseCertificate(req.certificatePem);
      if (req.certificatePem && !presented) return { ok: false, detail: "presented certificate is unparseable", evidence: certEvidence(undefined, { presentedBy: "sender (certificatePem in the message)", expectedAnsName: ansName, source: MOCK }) };
      if (presented) {
        const info: CertInfo = certInfo(presented);
        const sanOk = info.sans.some((s) => s.toLowerCase() === `uri:${ansName.toLowerCase()}`);
        const keyOk = info.publicKeyPem.trim() === brandKeyPem.trim();
        const evidence = certEvidence(info, { presentedBy: "sender (certificatePem in the message)", expectedAnsName: ansName, source: `${MOCK} · key compared with the brand's registered key (SPKI SHA-256 ${brandKeyFp.slice(0, 16)}…)` });
        const problems: string[] = [];
        if (!sanOk) problems.push(`SAN does not bind ${ansName}`);
        if (new Date(presented.validFrom) > new Date()) problems.push(`certificate not yet valid (from ${info.validFrom})`);
        if (new Date(presented.validTo) < new Date()) problems.push(`certificate expired ${info.validTo}`);
        if (!keyOk) problems.push(`issuer not trusted (${info.issuerCn}) · key is not the brand's registered key`);
        if (problems.length) return { ok: false, detail: `presented certificate rejected: ${problems.join(" · ")}`, evidence };
        keyPem = info.publicKeyPem;
        keyDescription = `key in the presented certificate for ${ansName}`;
        keyFingerprint = info.keyFingerprint;
        return { ok: true, detail: `chain valid · SAN matches ${req.from} · issuer ${info.issuerCn}`, evidence };
      }
      keyPem = brandKeyPem;
      keyDescription = `brand key on file for ${host}`;
      keyFingerprint = brandKeyFp;
      return {
        ok: true,
        detail: `chain valid · SAN matches ${req.from}`,
        evidence: [row("Presented by", "registry copy (mock) · sender presented no certificate"), row("Subject", `CN=${host}, O=Stelazio Pharmaceuticals (demo), C=US`), row("SAN", `URI:${ansName}, DNS:${host}`, true), row("Issuer", "CN=Agent Name Service CA, O=GoDaddy (mock)"), row("Validity", "2026-09-18 → 2026-12-17"), row("SHA-256 fingerprint", sha256hex(`mock-cert:${host}`), true), row("Public key", `EC P-256 · SPKI SHA-256 ${brandKeyFp.slice(0, 16)}…`, true), row("Chain", "valid (mock)"), sourceRow(MOCK)],
      };
    },
    0,
  );
  if (!ok2) return finish(result, "quarantined", "quarantine", "certificate", skipRest, onStep);

  const ok3 = await run(
    "transparency",
    async () => {
      await sleep(700);
      const leaf = sha256hex(`mock-leaf:${host}`);
      const rootHex = sha256hex(`mock-root:${leaf}`);
      return {
        ok: true,
        detail: "SCITT receipt verified against log checkpoint",
        evidence: [row("Log", `${TL_BASE} (mock)`, true), row("Badge URL", mockBadgeUrl, true), row("Sealed event", `AGENT_REGISTERED · ${ansName} · 2026-09-18T21:04:11Z · RA godaddy-ans-ra`), row("Status", "ACTIVE"), row("Leaf", "#1024 of tree size 4096"), row("Leaf hash", `${leaf} · recomputed: match`, true), row("Inclusion path", "12 sibling hashes → root"), row("Root hash", rootHex, true), row("Checkpoint", `signed by transparency.ans.godaddy.com · key id ${rootHex.slice(0, 8)} · tree size 4096`, true), row("Sealed cert fingerprint", `${sha256hex(`mock-cert:${host}`)} · match`, true), sourceRow(MOCK)],
      };
    },
    0,
  );
  if (!ok3) return finish(result, "quarantined", "quarantine", "transparency", skipRest, onStep);

  const ok4 = await run(
    "signature",
    async () => {
      await sleep(500);
      const r = await signatureStep(req, { publicKeyPem: keyPem, keyDescription, keyFingerprint, source: "mock · real ES256 check with the brand key this server holds · real replay window" });
      return r.ok ? { ...r, detail: `ECDSA P-256 signature valid for message body · ${r.detail.split(" · ").slice(1).join(" · ")}` } : r;
    },
    0,
  );
  if (!ok4) return finish(result, "quarantined", "quarantine", "signature", skipRest, onStep);

  const ok5 = await run(
    "policy",
    async () => {
      await sleep(400);
      return policyStep(req)();
    },
    0,
  );
  if (!ok5) return finish(result, "verified", "inbox", "policy", skipRest, onStep);

  return finish(result, "verified", "call", undefined, skipRest, onStep);
}

function finish(result: VerificationResult, verdict: VerificationResult["verdict"], outcome: Outcome, failedAt: StepId | undefined, skipRest: (after: StepId) => void, onStep: StepReporter) {
  if (failedAt) skipRest(failedAt);
  result.verdict = verdict;
  result.outcome = outcome;
  result.finishedAt = nowIso();
  onStep({ ...result, steps: result.steps.map((s) => ({ ...s })) });
  return result;
}
