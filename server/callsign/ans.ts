import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate, type KeyObject } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { config } from "./config.js";

/**
 * ANS RESOLVER + VERIFIER PRIMITIVES  (owner: Identity lane)
 *
 * Everything here is pure verification against GoDaddy's Agent Name Service
 * data shapes. Nothing throws: every check returns { ok, detail } so the
 * pipeline can fail closed with a one-line reason.
 *
 * Sources (cited inline):
 *  - ANS-2 naming + certificate binding:
 *    https://github.com/godaddy/ans-registry/blob/main/spec/ans-2-versioned-naming.md
 *  - ANS-3 DNS publication (record labels and shapes):
 *    https://github.com/godaddy/ans-registry/blob/main/spec/ans-3-dns-publication.md
 *  - ANS-4 transparency log (leaf hash, receipts, /root-keys):
 *    https://github.com/godaddy/ans-registry/blob/main/spec/ans-4-transparency.md
 *  - Worked examples (badge JSON):
 *    https://github.com/godaddy/ans-registry/blob/main/spec/examples/ans-4-examples.md
 *  - Live log used to validate this code: https://transparency.ans.godaddy.com/
 */

export type Check<T = object> = { ok: boolean; detail: string } & Partial<T>;
export type AnsMode = "mock" | "local" | "real";

/** ANS_MODE: mock (canned), local (this server's registry, real crypto), real (public ANS + DNS). */
export function ansMode(): AnsMode {
  const m = String(config.ans.mode ?? "local").trim().toLowerCase();
  return m === "local" || m === "real" ? m : "mock";
}

/** Bare semver of our registrations. ANS-2 §2: numeric major.minor.patch, no suffixes. */
export const ANS_VERSION = (process.env.ANS_AGENT_VERSION ?? "1.0.0").trim().replace(/^v/, "");

/** ANS-2 §2: `ans://v{version}.{agentHost}`. */
export function ansNameFor(host: string, version: string = ANS_VERSION): string {
  return `ans://v${version.replace(/^v/, "")}.${host.toLowerCase()}`;
}

/** Split an ANSName back into { version, host }; undefined if malformed. */
export function parseAnsName(name: string): { version: string; host: string } | undefined {
  const m = /^ans:\/\/v(\d+\.\d+\.\d+)\.([a-z0-9.-]+)$/i.exec(name.trim());
  return m ? { version: m[1], host: m[2].toLowerCase() } : undefined;
}

/** Public transparency log base. Badge URLs from DNS must live under it (ANS-4 §5). */
export const TL_BASE = (process.env.ANS_TL_BASE ?? "https://transparency.ans.godaddy.com").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// DNS (ANS-3)
// ---------------------------------------------------------------------------

/**
 * Parse the `k=v; k=v` TXT payload ANS publishes, e.g.
 *   _ans.{host}        "v=ans1; version=v1.0.0; p=a2a; mode=direct; url=https://.../a2a"
 *   _ans-badge.{host}  "v=ans-badge1; version=v1.0.0; url=https://transparency.../v1/agents/{agentId}"
 * ANS-3 Appendix A. Older live entries use `_ra-badge` / `v=ra-badge1` (V1 lane), same syntax.
 */
export function parseKv(txt: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of txt.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

export interface BadgeRecord {
  label: string; // the DNS owner name we found it at
  version?: string; // bare semver
  url: string; // TL badge endpoint .../v1/agents/{agentId}
  agentId?: string;
}
export interface AnsTxtRecord {
  version?: string;
  p?: string;
  url?: string;
}
export interface AnsRecords {
  host: string;
  badge: BadgeRecord;
  ans: AnsTxtRecord[];
  source: "dns" | "local";
  /** Every raw TXT row that was read for this host, exactly as the zone/DNS returned it (evidence). */
  txt: { name: string; data: string }[];
}

const normVersion = (v?: string) => (v ? v.replace(/^v/, "") : undefined);
const agentIdFromUrl = (url: string) => /\/v1\/agents\/([0-9a-f-]{36})/i.exec(url)?.[1]?.toLowerCase();

/** Turn raw TXT strings for a host into AnsRecords. Badge is REQUIRED (ANS-3 §6.3, Required=true). */
export function recordsFromTxt(host: string, txt: { name: string; data: string }[], source: "dns" | "local"): AnsRecords | undefined {
  const h = host.toLowerCase();
  let badge: BadgeRecord | undefined;
  const ans: AnsTxtRecord[] = [];
  for (const r of txt) {
    const kv = parseKv(r.data);
    const name = r.name.toLowerCase();
    if ((name === `_ans-badge.${h}` || name === `_ra-badge.${h}`) && /^(ans-badge1|ra-badge1)$/.test(kv.v ?? "") && kv.url) {
      badge ??= { label: name, version: normVersion(kv.version), url: kv.url, agentId: agentIdFromUrl(kv.url) };
    } else if (name === `_ans.${h}` && kv.v === "ans1") {
      ans.push({ version: normVersion(kv.version), p: kv.p, url: kv.url });
    }
  }
  return badge ? { host: h, badge, ans, source, txt: txt.map((r) => ({ name: r.name, data: r.data })) } : undefined;
}

/** The DNS owner names the resolver asks for, in query order (ANS-3 §6). */
export function ansDnsLabels(host: string): string[] {
  const h = host.toLowerCase();
  return [`_ans-badge.${h}`, `_ra-badge.${h}`, `_ans.${h}`];
}

/** What a DNS resolution attempt saw, success or not: for the evidence drawer. */
export interface DnsTrace {
  queried: string[];
  servers: string[];
  answers: { name: string; data: string }[];
  /** owner name -> resolver error code (ENOTFOUND, ENODATA, ETIMEOUT, ...) */
  errors: Record<string, string>;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/**
 * Resolve an agent host's ANS records from public DNS with node:dns.
 * Queries `_ans-badge.{host}` (required family record), `_ra-badge.{host}`
 * (V1 legacy label seen in the live log) and `_ans.{host}` (ANS_TXT profile).
 * SVCB rows (ANS_DNSAID profile) are not queried: node:dns has no SVCB
 * resolver; the badge TXT is emitted for every profile so it is the anchor.
 */
export async function resolveAgentDns(host: string, opts: { timeoutMs?: number; servers?: string[] } = {}): Promise<Check<{ records: AnsRecords; trace: DnsTrace }>> {
  const h = host.toLowerCase();
  const timeoutMs = opts.timeoutMs ?? 1500;
  const labels = ansDnsLabels(h);
  const trace: DnsTrace = { queried: labels, servers: [], answers: [], errors: {} };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) return { ok: false, detail: `${host} is not a valid agent host (ANS-2 §2)`, trace };
  const resolver = new Resolver();
  if (opts.servers?.length) resolver.setServers(opts.servers);
  try {
    trace.servers = resolver.getServers();
  } catch {
    /* no resolver config readable */
  }
  const query = async (name: string): Promise<{ name: string; data: string }[] | Error> => {
    try {
      const rows = await withTimeout(resolver.resolveTxt(name), timeoutMs, `DNS TXT ${name}`);
      return rows.map((chunks) => ({ name, data: chunks.join("") }));
    } catch (e) {
      return e as Error;
    }
  };
  try {
    const results = await Promise.all(labels.map(query));
    let hardError: string | undefined;
    results.forEach((r, i) => {
      if (Array.isArray(r)) trace.answers.push(...r);
      else {
        const code = (r as NodeJS.ErrnoException).code ?? (/timed out/.test(r.message) ? "ETIMEOUT" : "ERROR");
        trace.errors[labels[i]] = code;
        if (code !== "ENOTFOUND" && code !== "ENODATA") hardError ??= r.message;
      }
    });
    const records = recordsFromTxt(h, trace.answers, "dns");
    if (records) {
      const ver = records.badge.version ? ` · version v${records.badge.version}` : "";
      return { ok: true, detail: `${records.badge.label} TXT found via DNS${ver}${records.ans.length ? ` · _ans.${h} ×${records.ans.length}` : ""}`, records, trace };
    }
    if (hardError) return { ok: false, detail: `DNS error resolving _ans-badge.${h}: ${hardError}`, trace };
    return { ok: false, detail: `no ANS record for ${h}`, trace };
  } catch (e) {
    return { ok: false, detail: `DNS error resolving ${h}: ${(e as Error).message}`, trace };
  }
}

// ---------------------------------------------------------------------------
// Certificates (ANS-2 §3)
// ---------------------------------------------------------------------------

/** "SHA256:<hex>" or "aa:bb:..." → lowercase hex. */
export function normFingerprint(fp: string): string {
  return fp.replace(/^sha256:/i, "").replace(/:/g, "").toLowerCase();
}

export function certFingerprint256(cert: X509Certificate): string {
  return createHash("sha256").update(cert.raw).digest("hex");
}

export interface CertCheckOpts {
  expectedAnsName: string; // ans://v1.0.0.host
  caPem?: string; // trust anchor; when set the chain MUST verify
  expectedFingerprint?: string; // sha256 hex, e.g. from the TL badge or the registry
  now?: Date;
}

/** Everything a judge would want to read off a certificate, whether or not it passed. */
export interface CertInfo {
  subject: string; // "CN=..., O=..., C=US"
  issuer: string;
  issuerCn: string;
  serial: string;
  sans: string[]; // ["URI:ans://...", "DNS:host"]
  validFrom: string; // ISO
  validTo: string; // ISO
  fingerprint: string; // sha256 hex of DER
  keyAlg: string; // "EC P-256"
  keyFingerprint: string; // sha256 hex of SPKI DER
  publicKeyPem: string;
  /** Chain result when a CA was supplied. */
  chain?: "valid" | "not issued by trusted CA" | "unchecked";
  caSubjectCn?: string;
}

const dn = (s: string) => s.replace(/\n/g, ", ");
const cnOf = (s: string) => /CN=([^\n,]+)/.exec(s)?.[1] ?? dn(s);
const iso = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : d;
};

export function certInfo(cert: X509Certificate): CertInfo {
  const pk = cert.publicKey;
  const curve = (pk.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve;
  const keyAlg = pk.asymmetricKeyType === "ec" ? `EC ${curve === "prime256v1" ? "P-256" : curve ?? ""}`.trim() : (pk.asymmetricKeyType ?? "unknown").toUpperCase();
  return {
    subject: dn(cert.subject),
    issuer: dn(cert.issuer),
    issuerCn: cnOf(cert.issuer),
    serial: cert.serialNumber.toLowerCase(),
    sans: (cert.subjectAltName ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    validFrom: iso(cert.validFrom),
    validTo: iso(cert.validTo),
    fingerprint: certFingerprint256(cert),
    keyAlg,
    keyFingerprint: createHash("sha256").update(pk.export({ type: "spki", format: "der" }) as Buffer).digest("hex"),
    publicKeyPem: pk.export({ type: "spki", format: "pem" }) as string,
  };
}

/** Parse a PEM without throwing; undefined when it is not a certificate. */
export function parseCertificate(pem: string | undefined): X509Certificate | undefined {
  if (!pem?.includes("BEGIN CERTIFICATE")) return undefined;
  try {
    return new X509Certificate(pem);
  } catch {
    return undefined;
  }
}

/**
 * ANS-2 §3: the Identity Certificate carries the full ANSName as a
 * uniformResourceIdentifier SAN, keyUsage digitalSignature, EKU clientAuth,
 * issued by the RA's private CA. We check SAN, validity window, optional
 * issuer chain and optional fingerprint pin, and hand back the SPKI so the
 * signature step can use exactly the key the registry vouches for.
 *
 * Every problem is collected, not just the first, so a forged certificate
 * reads "issuer not trusted · fingerprint not the sealed one" on the card.
 * `info` is filled whenever the PEM parsed, pass or fail, for the evidence drawer.
 */
export function checkCertificate(certPem: string | undefined, opts: CertCheckOpts): Check<{ publicKeyPem: string; fingerprint: string; issuer: string; subject: string; info: CertInfo }> {
  if (!certPem?.includes("BEGIN CERTIFICATE")) return { ok: false, detail: "sender presented no certificate" };
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch (e) {
    return { ok: false, detail: `certificate unparseable: ${(e as Error).message}` };
  }
  const now = opts.now ?? new Date();
  const info = certInfo(cert);
  const problems: string[] = [];

  const uriSan = info.sans.find((s) => s.toLowerCase() === `uri:${opts.expectedAnsName.toLowerCase()}`);
  if (!uriSan) {
    const shown = info.sans.filter((s) => /^uri:/i.test(s)).join(", ") || "none";
    problems.push(`SAN does not bind ${opts.expectedAnsName} (URI SANs: ${shown})`);
  }
  if (new Date(cert.validFrom) > now) problems.push(`certificate not yet valid (from ${info.validFrom})`);
  if (new Date(cert.validTo) < now) problems.push(`certificate expired ${info.validTo}`);

  if (opts.caPem) {
    try {
      const ca = new X509Certificate(opts.caPem);
      info.caSubjectCn = cnOf(ca.subject);
      const issued = cert.checkIssued(ca) && cert.verify(ca.publicKey);
      info.chain = issued ? "valid" : "not issued by trusted CA";
      if (!issued) problems.push(`issuer not trusted (${info.issuerCn}, not ${info.caSubjectCn})`);
    } catch (e) {
      info.chain = "unchecked";
      problems.push(`CA check failed: ${(e as Error).message}`);
    }
  } else {
    info.chain = "unchecked";
  }

  if (opts.expectedFingerprint) {
    const want = normFingerprint(opts.expectedFingerprint);
    if (want !== info.fingerprint) problems.push(`fingerprint ${info.fingerprint.slice(0, 12)}… is not the one sealed for this agent (${want.slice(0, 12)}…)`);
  }

  const base = { publicKeyPem: info.publicKeyPem, fingerprint: info.fingerprint, issuer: info.issuerCn, subject: info.subject, info };
  if (problems.length) return { ok: false, detail: problems.join(" · "), ...base };
  const pinned = opts.expectedFingerprint ? " · fingerprint matches the sealed one" : "";
  return {
    ok: true,
    detail: `SAN URI ${opts.expectedAnsName} · issuer ${info.issuerCn} · ${info.keyAlg}${opts.caPem ? " · chain valid" : ""}${pinned}`,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Transparency log (ANS-4)
// ---------------------------------------------------------------------------

/** RFC 8785 JSON Canonicalization Scheme (sufficient for ANS payloads: strings, ints, bools, null, nested). */
export function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
    .join(",")}}`;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest();
const b64ToBuf = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * ANS-4 §3: leaf = SHA-256(0x00 ‖ JCS(envelope)), RFC 6962 §2.1, over the sealed
 * envelope {payload, schemaVersion, signature}. Validated against the live log:
 * matches merkleProof.leafHash for production badges.
 */
export function leafHashOf(envelope: { payload: unknown; schemaVersion: string; signature: string }): Buffer {
  const { payload, schemaVersion, signature } = envelope;
  return sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(jcs({ payload, schemaVersion, signature }), "utf8")]));
}

/** RFC 6962 inner node hash. */
export const nodeHash = (l: Buffer, r: Buffer) => sha(Buffer.concat([Buffer.from([0x01]), l, r]));

/** RFC 6962 §2.1.1 Merkle Tree Hash over an ordered list of leaf hashes. */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return sha(Buffer.alloc(0));
  if (leaves.length === 1) return leaves[0];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** RFC 6962 §2.1.3 audit path for leaf m (list of sibling hashes, leaf→root order). */
export function merklePath(leaves: Buffer[], m: number): Buffer[] {
  if (leaves.length <= 1) return [];
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return m < k
    ? [...merklePath(leaves.slice(0, k), m), merkleRoot(leaves.slice(k))]
    : [...merklePath(leaves.slice(k), m - k), merkleRoot(leaves.slice(0, k))];
}

/** Walk an RFC 6962 inclusion proof (leafIndex, treeSize, path) and compare with rootHash. */
export function verifyInclusion(leafHash: Buffer, leafIndex: number, treeSize: number, path: Buffer[], rootHash: Buffer): boolean {
  if (leafIndex < 0 || leafIndex >= treeSize) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leafHash;
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      while (!(fn % 2 === 1 || fn === 0)) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r.equals(rootHash);
}

export interface RootKey {
  origin: string;
  keyHash: string; // 4-byte hex, = SHA-256(SPKI DER)[0:4] (ANS-6 §4.5) — the `kid` receipts carry
  publicKey: KeyObject;
}

/**
 * ANS-4 §5.1: GET /root-keys returns sumdb-note verifier lines
 * `origin+keyhash+base64(algByte ‖ SPKI DER)`. Base64 may itself contain '+',
 * so only the first two separators are structural.
 */
export function parseRootKeys(text: string): RootKey[] {
  const out: RootKey[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [origin, keyHash, ...rest] = line.trim().split("+");
    if (!origin || !keyHash || rest.length === 0) continue;
    try {
      const raw = Buffer.from(rest.join("+"), "base64");
      const der = raw.subarray(1); // first byte = algorithm id (0x02 in the live log)
      const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
      out.push({ origin, keyHash: keyHash.toLowerCase(), publicKey });
    } catch {
      /* skip unparseable line */
    }
  }
  return out;
}

/** JWS compact (embedded or detached payload) ES256 verify against a root-key set, kid-matched when present. */
export function verifyJws(compact: string, keys: RootKey[], detachedPayload?: string): Check<{ header: Record<string, unknown>; payload: unknown }> {
  const parts = compact.split(".");
  if (parts.length !== 3) return { ok: false, detail: "malformed JWS" };
  const [h, p, s] = parts;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  } catch {
    return { ok: false, detail: "malformed JWS header" };
  }
  if (header.alg !== "ES256") return { ok: false, detail: `unsupported JWS alg ${String(header.alg)}` };
  const kid = typeof header.kid === "string" ? header.kid.toLowerCase() : undefined;
  const candidates = kid && keys.some((k) => k.keyHash === kid) ? keys.filter((k) => k.keyHash === kid) : keys;
  const payloadB64 = p || Buffer.from(detachedPayload ?? "", "utf8").toString("base64url");
  const input = Buffer.from(`${h}.${payloadB64}`, "utf8");
  const sig = Buffer.from(s, "base64url");
  for (const k of candidates) {
    try {
      if (cryptoVerify("sha256", input, { key: k.publicKey, dsaEncoding: "ieee-p1363" }, sig)) {
        let payload: unknown = undefined;
        try {
          payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
        } catch {
          /* non-JSON payload */
        }
        return { ok: true, detail: `signed by ${k.origin} (kid ${k.keyHash})`, header, payload };
      }
    } catch {
      /* try next key */
    }
  }
  return { ok: false, detail: `signature does not verify against any of ${keys.length} root key(s)` };
}

/** Shape of GET {tl}/v1/agents/{agentId} (ANS-4 examples A.2, live V1 format). */
export interface Badge {
  schemaVersion: string;
  status: string;
  merkleProof: {
    leafHash: string; // hex
    leafIndex: number;
    treeSize: number;
    path: string[]; // base64
    rootHash: string; // base64
    rootSignature?: string; // JWS (embedded payload {checkpointFormat, origin, rootHash, timestamp, treesize})
    treeVersion?: number;
  };
  payload: { logId: string; producer: { event: Record<string, unknown>; keyId?: string; signature?: string } };
  signature: string;
}

export interface BadgeCheckOpts {
  expectedAnsName: string;
  rootKeysText: string;
}

/** What the log entry says, read before any check runs, so a failure still shows the bytes. */
export interface BadgeInfo {
  ansName: string;
  eventType: string;
  status: string;
  logId?: string;
  sealedAt?: string; // event.timestamp
  raId?: string;
  leafIndex: number;
  treeSize: number;
  leafHashClaimed: string; // hex, from the badge
  leafHashComputed?: string; // hex, recomputed from the envelope
  rootHash: string; // base64, from the badge
  rootHashHex?: string;
  pathLength: number;
  /** From the signed checkpoint, once verified. */
  origin?: string;
  kid?: string;
  checkpointTreeSize?: number;
  checkpointTime?: string;
  identityFingerprints: string[];
  agentVersion?: string;
  rootKeyCount: number;
}

/** Identity-cert fingerprints the RA sealed in an event (V1 identityCert{}, V2 identityCerts[]). */
export function sealedFingerprints(event: Record<string, unknown> | undefined): string[] {
  const att = ((event ?? {}).attestations ?? {}) as Record<string, unknown>;
  const fps: string[] = [];
  const one = att.identityCert as { fingerprint?: string } | undefined;
  if (one?.fingerprint) fps.push(normFingerprint(one.fingerprint));
  for (const c of (att.identityCerts as { fingerprint?: string }[] | undefined) ?? []) if (c.fingerprint) fps.push(normFingerprint(c.fingerprint));
  return fps;
}

/** Read a badge's headline facts without verifying anything. Undefined when the shape is not a badge. */
export function badgeInfo(badge: Badge | undefined, rootKeysText = ""): BadgeInfo | undefined {
  if (!badge || typeof badge !== "object" || !badge.merkleProof || !badge.payload) return undefined;
  const event = badge.payload.producer?.event ?? {};
  const mp = badge.merkleProof;
  let leafHashComputed: string | undefined;
  try {
    leafHashComputed = leafHashOf(badge).toString("hex");
  } catch {
    /* malformed envelope */
  }
  let rootHashHex: string | undefined;
  try {
    rootHashHex = b64ToBuf(String(mp.rootHash)).toString("hex");
  } catch {
    /* not base64 */
  }
  return {
    ansName: String(event.ansName ?? ""),
    eventType: String(event.eventType ?? ""),
    status: String(badge.status ?? ""),
    logId: typeof badge.payload.logId === "string" ? badge.payload.logId : undefined,
    sealedAt: typeof event.timestamp === "string" ? event.timestamp : undefined,
    raId: typeof event.raId === "string" ? event.raId : undefined,
    leafIndex: Number(mp.leafIndex),
    treeSize: Number(mp.treeSize),
    leafHashClaimed: String(mp.leafHash ?? "").toLowerCase(),
    leafHashComputed,
    rootHash: String(mp.rootHash ?? ""),
    rootHashHex,
    pathLength: Array.isArray(mp.path) ? mp.path.length : 0,
    identityFingerprints: sealedFingerprints(event),
    agentVersion: normVersion((event.agent as { version?: string } | undefined)?.version),
    rootKeyCount: parseRootKeys(rootKeysText).length,
  };
}

/**
 * Verify a transparency-log badge the way ANS-4 §5.2 describes for receipts:
 * recompute the leaf hash from the sealed envelope, walk the inclusion path to
 * the root, and check the root is covered by a checkpoint signed with a key
 * from /root-keys. Also checks the sealed event names the expected agent and
 * the computed status is ACTIVE. Returns the identity-cert fingerprints the
 * RA sealed so the certificate can be anchored. `info` is present whenever
 * the badge had the right shape, pass or fail.
 */
export function verifyBadge(badge: Badge | undefined, opts: BadgeCheckOpts): Check<{ identityFingerprints: string[]; leafIndex: number; treeSize: number; origin: string; agentVersion?: string; info: BadgeInfo }> {
  const info = badgeInfo(badge, opts.rootKeysText);
  if (!badge || !info) return { ok: false, detail: "no transparency-log entry for this agent" };
  const fail = (detail: string) => ({ ok: false, detail, info, identityFingerprints: info.identityFingerprints, leafIndex: info.leafIndex, treeSize: info.treeSize, agentVersion: info.agentVersion });

  const event = badge.payload.producer?.event ?? {};
  if (info.ansName.toLowerCase() !== opts.expectedAnsName.toLowerCase()) return fail(`log entry is for ${info.ansName || "another agent"}, not ${opts.expectedAnsName}`);
  if (event.eventType !== "AGENT_REGISTERED" && event.eventType !== "AGENT_RENEWED") return fail(`latest sealed event is ${String(event.eventType)}`);
  if (badge.status !== "ACTIVE") return fail(`registry status is ${badge.status}`);

  const mp = badge.merkleProof;
  const leaf = leafHashOf(badge);
  if (leaf.toString("hex") !== info.leafHashClaimed) return fail("leaf hash does not match the sealed envelope (tampered entry)");
  const root = b64ToBuf(mp.rootHash);
  if (!verifyInclusion(leaf, mp.leafIndex, mp.treeSize, (mp.path ?? []).map(b64ToBuf), root)) return fail(`inclusion proof for leaf #${mp.leafIndex} does not reach root`);

  const keys = parseRootKeys(opts.rootKeysText);
  if (keys.length === 0) return fail("no transparency-log root keys available");
  if (!mp.rootSignature) return fail("badge carries no signed checkpoint (rootSignature)");
  const cp = verifyJws(mp.rootSignature, keys);
  if (!cp.ok) return fail(`checkpoint ${cp.detail}`);
  const cpPayload = (cp.payload ?? {}) as Record<string, unknown>;
  const cpRoot = typeof cpPayload.rootHash === "string" ? b64ToBuf(cpPayload.rootHash) : undefined;
  const cpSize = Number(cpPayload.treesize ?? cpPayload.treeSize);
  info.kid = typeof cp.header?.kid === "string" ? cp.header.kid.toLowerCase() : undefined;
  info.checkpointTreeSize = Number.isFinite(cpSize) ? cpSize : undefined;
  info.checkpointTime = typeof cpPayload.timestamp === "number" ? new Date(cpPayload.timestamp * 1000).toISOString() : undefined;
  if (!cpRoot?.equals(root) || cpSize !== mp.treeSize) return fail("signed checkpoint does not cover this proof's root");
  const origin = String(cpPayload.origin ?? keys[0].origin);
  info.origin = origin;

  return {
    ok: true,
    detail: `leaf #${mp.leafIndex} of ${mp.treeSize} · inclusion path ok · checkpoint signed by ${origin}`,
    identityFingerprints: info.identityFingerprints,
    leafIndex: mp.leafIndex,
    treeSize: mp.treeSize,
    origin,
    agentVersion: info.agentVersion,
    info,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers (never throw)
// ---------------------------------------------------------------------------

export async function fetchJson<T = unknown>(url: string, timeoutMs = 2500): Promise<Check<{ body: T; status: number }>> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, detail: `${url} → HTTP ${res.status}`, status: res.status };
    return { ok: true, detail: `HTTP ${res.status}`, status: res.status, body: (await res.json()) as T };
  } catch (e) {
    return { ok: false, detail: `${url} → ${(e as Error).name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : (e as Error).message}` };
  }
}

export async function fetchText(url: string, timeoutMs = 2500): Promise<Check<{ body: string }>> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `${url} → HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}`, body: await res.text() };
  } catch (e) {
    return { ok: false, detail: `${url} → ${(e as Error).name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : (e as Error).message}` };
  }
}

let rootKeysCache: { text: string; at: number } | undefined;
/** /root-keys is append-only (ANS-4 §5.1); cache it for the process, refresh hourly. */
export async function publicRootKeys(base = TL_BASE): Promise<Check<{ text: string }>> {
  if (rootKeysCache && Date.now() - rootKeysCache.at < 3600_000) return { ok: true, detail: "cached", text: rootKeysCache.text };
  const r = await fetchText(`${base}/root-keys`);
  if (!r.ok || !r.body) return { ok: false, detail: `root keys unavailable: ${r.detail}` };
  rootKeysCache = { text: r.body, at: Date.now() };
  return { ok: true, detail: "fetched", text: r.body };
}
