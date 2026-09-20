import type { ReachRequest, VerificationStep } from "@callsign/shared";
import { createHash } from "node:crypto";
import type { AnsRecords, BadgeInfo, CertInfo, DnsTrace } from "./ans.ts";
import { canonicalReach } from "./sign.ts";
import { FUTURE_SKEW_MS, REPLAY_WINDOW_MS, formatAge, formatClock, type Freshness } from "./replay.ts";

/**
 * EVIDENCE ROWS  (owner: Identity lane)
 *
 * Each verification step hands the trust card an ordered list of
 * {label, value, mono} rows: the actual bytes the check looked at. These
 * builders turn the verifier's structured results into those rows. Values
 * are always strings; `mono` marks hashes, DNS text and names.
 */
export type Evidence = NonNullable<VerificationStep["evidence"]>[number];

export const row = (label: string, value: string | number | undefined | null, mono = false): Evidence => ({ label, value: value === undefined || value === null || value === "" ? "—" : String(value), mono });

/** Where the step got its data. Always the last row so a judge can tell mock from real at a glance. */
export const sourceRow = (value: string): Evidence => row("Source", value);

export const shortHash = (hex: string | undefined, n = 16) => (hex ? `${hex.slice(0, n)}…${hex.slice(-8)}` : "—");

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export function resolveEvidence(records: AnsRecords, opts: { source: string; trace?: DnsTrace; ansName: string }): Evidence[] {
  const out: Evidence[] = [row("Query", `${records.badge.label} TXT`, true)];
  const badgeTxt = records.txt.find((t) => t.name.toLowerCase() === records.badge.label);
  out.push(row("Answer", badgeTxt?.data ?? "(parsed)", true));
  for (const t of records.txt) if (t.name.toLowerCase() === `_ans.${records.host}`) out.push(row(`${t.name} TXT`, t.data, true));
  out.push(row("Badge URL", records.badge.url, true));
  out.push(row("Agent id", records.badge.agentId ?? "(not a /v1/agents/{id} URL)", true));
  out.push(row("Version", records.badge.version ? `v${records.badge.version}` : "(record carries none; default used)"));
  out.push(row("ANS name", opts.ansName, true));
  if (opts.trace?.servers.length) out.push(row("Resolver", opts.trace.servers.join(", "), true));
  out.push(sourceRow(opts.source));
  return out;
}

export function resolveMissEvidence(host: string, opts: { source: string; trace?: DnsTrace; registered?: string[]; zoneAnswers?: { name: string; data: string }[] }): Evidence[] {
  const out: Evidence[] = [row("Query", `_ans-badge.${host} TXT`, true)];
  const t = opts.trace;
  if (t) {
    const badgeErr = t.errors[`_ans-badge.${host}`];
    const badgeAns = t.answers.filter((a) => a.name === `_ans-badge.${host}`);
    out.push(row("Answer", badgeAns.length ? badgeAns.map((a) => a.data).join(" | ") + " (not a valid badge record)" : badgeErr === "ENOTFOUND" ? "NXDOMAIN · no such name" : badgeErr === "ENODATA" ? "NODATA · name exists, no TXT" : badgeErr ?? "no answer", true));
    const others = t.queried.filter((q) => q !== `_ans-badge.${host}`);
    out.push(row("Also tried", others.map((q) => `${q} → ${t.errors[q] ?? (t.answers.some((a) => a.name === q) ? "answered" : "none")}`).join(" · "), true));
    if (t.servers.length) out.push(row("Resolver", t.servers.join(", "), true));
  } else {
    out.push(row("Answer", opts.zoneAnswers?.length ? opts.zoneAnswers.map((a) => `${a.name}: ${a.data}`).join(" | ") : "NXDOMAIN · no records in the zone", true));
    out.push(row("Also tried", `_ans.${host} TXT → none`, true));
  }
  if (opts.registered) out.push(row("Registered agents", opts.registered.length ? opts.registered.join(", ") : "(none)", true));
  out.push(sourceRow(opts.source));
  return out;
}

// ---------------------------------------------------------------------------
// certificate
// ---------------------------------------------------------------------------

export function certEvidence(info: CertInfo | undefined, opts: { presentedBy: string; expectedAnsName: string; sealedFingerprint?: string; trustedCa?: string; source: string }): Evidence[] {
  const out: Evidence[] = [row("Presented by", opts.presentedBy)];
  if (!info) {
    out.push(row("Certificate", "none parseable"), row("Expected SAN", `URI:${opts.expectedAnsName}`, true), sourceRow(opts.source));
    return out;
  }
  const uri = info.sans.find((s) => /^uri:/i.test(s));
  out.push(
    row("Subject", info.subject),
    row("SAN", info.sans.join(", "), true),
    row("Expected SAN", `URI:${opts.expectedAnsName}${uri && uri.toLowerCase() === `uri:${opts.expectedAnsName.toLowerCase()}` ? " · match" : " · MISSING"}`, true),
    row("Issuer", info.issuer),
    row("Serial", info.serial, true),
    row("Validity", `${info.validFrom.slice(0, 10)} → ${info.validTo.slice(0, 10)}`),
    row("SHA-256 fingerprint", info.fingerprint, true),
    row("Public key", `${info.keyAlg} · SPKI SHA-256 ${shortHash(info.keyFingerprint)}`, true),
  );
  const ca = opts.trustedCa ?? info.caSubjectCn;
  if (ca) out.push(row("Trusted CA", ca));
  if (info.chain && info.chain !== "unchecked") out.push(row("Chain", info.chain === "valid" ? `valid · signed by ${info.caSubjectCn ?? ca}` : `NOT issued by ${info.caSubjectCn ?? ca} · issuer is ${info.issuerCn}`));
  else out.push(row("Chain", "issuer not pinned (no CA PEM configured)"));
  if (opts.sealedFingerprint) out.push(row("Sealed fingerprint", `${opts.sealedFingerprint}${opts.sealedFingerprint === info.fingerprint ? " · match" : " · MISMATCH"}`, true));
  out.push(sourceRow(opts.source));
  return out;
}

// ---------------------------------------------------------------------------
// transparency
// ---------------------------------------------------------------------------

export function badgeEvidence(info: BadgeInfo | undefined, opts: { badgeUrl?: string; logBase: string; certFingerprint?: string; chain?: { ok: boolean; length: number; head: string }; source: string }): Evidence[] {
  const out: Evidence[] = [row("Log", opts.logBase, true)];
  if (opts.badgeUrl) out.push(row("Badge URL", opts.badgeUrl, true));
  if (!info) {
    out.push(row("Entry", "no badge returned"), sourceRow(opts.source));
    return out;
  }
  out.push(
    row("Sealed event", `${info.eventType || "?"} · ${info.ansName || "?"}${info.sealedAt ? ` · ${info.sealedAt}` : ""}${info.raId ? ` · RA ${info.raId}` : ""}`),
    row("Status", info.status),
    row("Leaf", `#${info.leafIndex} of tree size ${info.treeSize}${info.logId ? ` · logId ${info.logId}` : ""}`),
    row("Leaf hash", `${info.leafHashClaimed}${info.leafHashComputed ? (info.leafHashComputed === info.leafHashClaimed ? " · recomputed: match" : ` · recomputed ${shortHash(info.leafHashComputed)} MISMATCH`) : ""}`, true),
    row("Inclusion path", `${info.pathLength} sibling hash${info.pathLength === 1 ? "" : "es"} → root`),
    row("Root hash", info.rootHashHex ?? info.rootHash, true),
  );
  if (info.origin || info.kid) out.push(row("Checkpoint", `signed by ${info.origin ?? "?"} · key id ${info.kid ?? "?"}${info.checkpointTreeSize !== undefined ? ` · tree size ${info.checkpointTreeSize}` : ""}${info.checkpointTime ? ` · ${info.checkpointTime}` : ""}`, true));
  else out.push(row("Checkpoint", `not verified (${info.rootKeyCount} root key${info.rootKeyCount === 1 ? "" : "s"} loaded)`));
  const fps = info.identityFingerprints;
  out.push(row("Sealed cert fingerprint", fps.length ? fps.map((f) => `${f}${opts.certFingerprint ? (f === opts.certFingerprint ? " · match" : "") : ""}`).join(", ") : "(none sealed)", true));
  if (opts.certFingerprint && fps.length && !fps.includes(opts.certFingerprint)) out.push(row("Presented cert", `${opts.certFingerprint} · NOT sealed`, true));
  if (opts.chain) out.push(row("Hash chain", opts.chain.ok ? `ok · ${opts.chain.length} entries · head ${shortHash(opts.chain.head)}` : "BROKEN", true));
  out.push(sourceRow(opts.source));
  return out;
}

// ---------------------------------------------------------------------------
// signature
// ---------------------------------------------------------------------------

export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function signatureEvidence(
  req: ReachRequest,
  opts: {
    keyDescription: string; // "certificate for ans://…" or "this server's keystore"
    keyFingerprint?: string; // SPKI sha256 hex
    signatureValid: boolean | undefined; // undefined = not checked (unsigned)
    freshness?: Freshness;
    seenAt?: number;
    source: string;
  },
): Evidence[] {
  const canonical = canonicalReach(req);
  const sig = req.signature ?? "";
  let sigBytes = 0;
  try {
    sigBytes = Buffer.from(sig, "base64url").length;
  } catch {
    /* not base64 */
  }
  const out: Evidence[] = [
    row("Algorithm", "ES256 · ECDSA P-256 with SHA-256 · raw r‖s, base64url"),
    row("Signing key", `${opts.keyDescription}${opts.keyFingerprint ? ` · SPKI SHA-256 ${shortHash(opts.keyFingerprint)}` : ""}`, true),
    row("Canonical fields", "id · from · to · claimedDisplayName · kind · payload · ts"),
    row("Message hash", sha256hex(canonical), true),
    row("Payload hash", sha256hex(JSON.stringify(req.payload)), true),
    row("Signature", sig ? `${sig.slice(0, 20)}…${sig.slice(-8)} (${sigBytes} bytes)` : "(unsigned)", true),
    row("Signature check", opts.signatureValid === undefined ? "not run" : opts.signatureValid ? "valid" : "does not match message body"),
    row("Timestamp", req.ts, true),
  ];
  if (opts.freshness) {
    const f = opts.freshness;
    out.push(row("Age", Number.isFinite(f.ageMs) ? `${formatAge(f.ageMs)}${f.ageMs < 0 ? " in the future" : ""} · window ${formatAge(REPLAY_WINDOW_MS)} past, ${formatAge(FUTURE_SKEW_MS)} future · ${f.ok ? "ok" : "REJECTED"}` : "unreadable"));
  }
  out.push(row("Replay check", opts.seenAt !== undefined ? `id ${req.id} already verified at ${formatClock(opts.seenAt)} · REJECTED` : `id ${req.id} · first time seen`, true));
  out.push(sourceRow(opts.source));
  return out;
}
