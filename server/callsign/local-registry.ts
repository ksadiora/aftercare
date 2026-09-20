import { createHash, sign as cryptoSign, webcrypto, X509Certificate } from "node:crypto";
import fs from "node:fs";
import { Router } from "express";
import "reflect-metadata"; // @peculiar/x509 (tsyringe) needs the Reflect polyfill loaded first
import * as x509 from "@peculiar/x509";
import { config } from "./config.js";
import { brandIdentity, hcpIdentity } from "./identities.js";
import { ANS_VERSION, ansNameFor, jcs, leafHashOf, merklePath, merkleRoot, type Badge } from "./ans.js";
import { certPathFor, certificatePemFor, privateKeyDerFor, privateKeyFor, publicKeyDerFor } from "./sign.js";

/**
 * LOCAL ANS REGISTRY  (owner: Identity lane)  — the ANS_MODE=local fallback.
 *
 * A minimal, self-hosted stand-in for GoDaddy's Registration Authority +
 * Transparency Log, shaped like the real thing so the verifier code in
 * pipeline.ts / ans.ts is identical in local and real modes; only the data
 * source differs. Everything is real cryptography:
 *
 *  - a private CA (P-256, self-signed) plays the RA's Private CA
 *    (ANS-2 §3: https://github.com/godaddy/ans-registry/blob/main/spec/ans-2-versioned-naming.md#3-the-identity-certificate)
 *  - each registered agent gets an X.509 Identity Certificate with the
 *    ANSName `ans://v1.0.0.{host}` as a URI SAN, keyUsage digitalSignature,
 *    EKU clientAuth, signed by that CA, over the agent's own key from sign.ts
 *  - a DNS "zone" holding the records ANS-3 says to publish
 *    (`_ans.{host}` TXT, `_ans-badge.{host}` TXT, `{host}` SVCB;
 *    https://github.com/godaddy/ans-registry/blob/main/spec/ans-3-dns-publication.md#appendix-a-annotated-zone-file-example)
 *  - an append-only transparency log: sealed envelopes, RFC 6962 leaf hashes,
 *    a Merkle tree with inclusion proofs, a SHA-256 hash chain over the leaves,
 *    and a signed checkpoint (JWS ES256) served with a /root-keys line
 *    (ANS-4: https://github.com/godaddy/ans-registry/blob/main/spec/ans-4-transparency.md)
 *
 * Only the HCP and brand agents are registered. The look-alike impostor has
 * no record, so it fails at "resolve" for the same reason any unregistered
 * host would; the other impostor variants (agents/brand.ts) claim the brand's
 * real name and fail later, against this registry's CA and sealed fingerprint.
 *
 * HTTP: `localRegistryRouter` is mounted in server/src/index.ts at
 *   app.use("/ans", localRegistryRouter);
 * The badge URLs in the zone assume that mount path (LOCAL_REGISTRY_MOUNT).
 */

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const subtle = webcrypto.subtle;
const ECDSA_KEY = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export const LOCAL_REGISTRY_MOUNT = "/ans";
const CA_NAME = "local-ans-ca"; // server/keys/local-ans-ca.{key,pem}
const TL_NAME = "local-ans-tl"; // server/keys/local-ans-tl.key
const RA_ID = "callsign-local-ra";

export interface ZoneRecord {
  name: string;
  type: "TXT" | "SVCB" | "TLSA" | "HTTPS";
  data: string;
  ttl: number;
}

export interface LocalAgent {
  agentId: string;
  host: string;
  ansName: string;
  version: string;
  displayName: string;
  organization: string;
  endpointUrl: string;
  cardUrl: string;
  badgeUrl: string;
  certPem: string;
  certFingerprint: string; // sha256 hex of DER
  notAfter: string;
  logId: string;
  leafIndex: number;
}

interface Envelope {
  payload: { logId: string; producer: { event: Record<string, unknown>; keyId: string; signature: string } };
  schemaVersion: "V2";
  signature: string; // TL attestation: detached JWS over JCS(payload)
}

interface LogEntry {
  envelope: Envelope;
  leafHash: Buffer;
  chainHash: string; // sha256(prevChainHash ‖ leafHash) — the append-only hash chain
  prevChainHash: string;
  sealedAt: string;
}

interface RegistryState {
  origin: string;
  caPem: string;
  agents: Map<string, LocalAgent>; // by host
  byId: Map<string, LocalAgent>; // by agentId
  zone: Map<string, ZoneRecord[]>; // by lowercase owner name
  log: LogEntry[];
  rootKeysText: string;
  tlKeyHash: string;
}

let state: RegistryState | undefined;
let initPromise: Promise<RegistryState> | undefined;

/** Idempotent boot: CA, certs for the HCP + brand agents, zone, log. Safe to call often. */
export function ensureLocalRegistry(): Promise<RegistryState> {
  if (state) return Promise.resolve(state);
  initPromise ??= build()
    .then((s) => (state = s))
    .catch((e) => {
      initPromise = undefined;
      throw e;
    });
  return initPromise;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function build(): Promise<RegistryState> {
  const origin = safeHostname(config.publicBaseUrl);
  const caPem = await ensureCa();
  const tlKeyHash = keyHashFor(TL_NAME);
  const rootKeysText = `${origin}+${tlKeyHash}+${Buffer.concat([Buffer.from([0x02]), publicKeyDerFor(TL_NAME)]).toString("base64")}\n`;

  const s: RegistryState = { origin, caPem, agents: new Map(), byId: new Map(), zone: new Map(), log: [], rootKeysText, tlKeyHash };

  const registrants = [
    { host: hcpIdentity.name, displayName: hcpIdentity.displayName, organization: hcpIdentity.organization, cardUrl: hcpIdentity.cardUrl },
    { host: brandIdentity.name, displayName: brandIdentity.displayName, organization: brandIdentity.organization, cardUrl: brandIdentity.cardUrl },
  ];
  for (const r of registrants) await register(s, r);
  console.log(`[ans:local] registry ready · CA ${caSubject(caPem)} · ${s.agents.size} agents · log size ${s.log.length}`);
  return s;
}

async function register(s: RegistryState, r: { host: string; displayName: string; organization: string; cardUrl: string }) {
  const host = r.host.toLowerCase();
  const version = ANS_VERSION;
  const ansName = ansNameFor(host, version);
  const agentId = deterministicUuid(`callsign-local-ans|${ansName}`);
  const endpointUrl = `https://${host}/reach`;
  const badgeUrl = `${config.publicBaseUrl.replace(/\/$/, "")}${LOCAL_REGISTRY_MOUNT}/v1/agents/${agentId}`;

  const cert = await ensureIdentityCert(host, ansName, r.displayName, r.organization, s.caPem);
  const certFingerprint = createHash("sha256").update(cert.raw).digest("hex");

  // ANS-3 records this registration publishes (ANS_TXT + ANS_DNSAID union, Appendix A).
  const records: ZoneRecord[] = [
    { name: `_ans.${host}`, type: "TXT", data: `v=ans1; version=v${version}; p=a2a; mode=direct; url=${endpointUrl}`, ttl: 3600 },
    { name: host, type: "SVCB", data: `1 . alpn=a2a port=443 key65400=${r.cardUrl} key65402=a2a key65409=agent.json`, ttl: 3600 },
    { name: `_ans-badge.${host}`, type: "TXT", data: `v=ans-badge1; version=v${version}; url=${badgeUrl}`, ttl: 3600 },
  ];
  for (const rec of records) {
    const list = s.zone.get(rec.name.toLowerCase()) ?? [];
    list.push(rec);
    s.zone.set(rec.name.toLowerCase(), list);
  }

  // ANS-1 §6.1 AGENT_REGISTERED event, V2 TL format (spec/examples/ans-1-examples.md A.1).
  const now = new Date().toISOString();
  const event = {
    ansId: agentId,
    ansName,
    eventType: "AGENT_REGISTERED",
    agent: { host, name: r.displayName, version },
    attestations: {
      identityCerts: [{ fingerprint: `SHA256:${certFingerprint}`, type: "X509-OV-CLIENT", notAfter: cert.validTo }],
      dnsRecordsProvisioned: records.map((x) => ({ name: x.name, type: x.type, data: x.data })),
      domainValidation: "LOCAL-SELF-HOSTED",
    },
    expiresAt: cert.validTo,
    issuedAt: now,
    raId: RA_ID,
    timestamp: now,
  };
  const entry = appendEvent(s, event);

  const agent: LocalAgent = {
    agentId,
    host,
    ansName,
    version,
    displayName: r.displayName,
    organization: r.organization,
    endpointUrl,
    cardUrl: r.cardUrl,
    badgeUrl,
    certPem: cert.toString(),
    certFingerprint,
    notAfter: cert.validTo,
    logId: entry.envelope.payload.logId,
    leafIndex: s.log.length - 1,
  };
  s.agents.set(host, agent);
  s.byId.set(agentId, agent);
}

/** Seal an event: producer (RA) signature, TL attestation, leaf hash, hash chain. */
function appendEvent(s: RegistryState, event: Record<string, unknown>): LogEntry {
  const logId = uuidV7();
  const producerSig = detachedJws(jcs(event), RA_ID, TL_NAME); // single-key deployment: RA and TL share the key
  const payload = { logId, producer: { event, keyId: RA_ID, signature: producerSig } };
  const envelope: Envelope = { payload, schemaVersion: "V2", signature: detachedJws(jcs(payload), s.tlKeyHash, TL_NAME) };
  const leafHash = leafHashOf(envelope);
  const prevChainHash = s.log.length ? s.log[s.log.length - 1].chainHash : "0".repeat(64);
  const chainHash = createHash("sha256").update(Buffer.concat([Buffer.from(prevChainHash, "hex"), leafHash])).digest("hex");
  const entry: LogEntry = { envelope, leafHash, chainHash, prevChainHash, sealedAt: new Date().toISOString() };
  s.log.push(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Reads (what the pipeline and the router consume)
// ---------------------------------------------------------------------------

export function lookupZone(name: string): ZoneRecord[] {
  return state?.zone.get(name.toLowerCase().replace(/\.$/, "")) ?? [];
}

/** All TXT records under a host, in the {name, data} shape ans.recordsFromTxt() takes. */
export function zoneTxtForHost(host: string): { name: string; data: string }[] {
  const h = host.toLowerCase();
  return [`_ans-badge.${h}`, `_ans.${h}`].flatMap((n) => lookupZone(n).filter((r) => r.type === "TXT").map((r) => ({ name: r.name, data: r.data })));
}

export function agentById(agentId: string): LocalAgent | undefined {
  return state?.byId.get(agentId.toLowerCase());
}
export function agentByHost(host: string): LocalAgent | undefined {
  return state?.agents.get(host.toLowerCase());
}
export function localCaPem(): string | undefined {
  return state?.caPem;
}
export function localRootKeysText(): string {
  return state?.rootKeysText ?? "";
}
/** Hosts with a registration (for the "who IS registered" row when a lookup misses). */
export function registeredHosts(): string[] {
  return state ? [...state.agents.keys()] : [];
}
/** The log's origin string (hostname of PUBLIC_BASE_URL) and its checkpoint key id. */
export function localLogIdentity(): { origin: string; kid: string; base: string } {
  return { origin: state?.origin ?? "", kid: state?.tlKeyHash ?? "", base: `${config.publicBaseUrl.replace(/\/$/, "")}${LOCAL_REGISTRY_MOUNT}` };
}

/** GET /v1/agents/{agentId} — sealed event + inclusion proof + signed checkpoint (ANS-4 examples A.2). */
export function badgeFor(agentId: string): Badge | undefined {
  const a = agentById(agentId);
  if (!a || !state) return undefined;
  const entry = state.log[a.leafIndex];
  const leaves = state.log.map((e) => e.leafHash);
  const root = merkleRoot(leaves);
  const treeSize = leaves.length;
  const checkpoint = { checkpointFormat: "c2sp/v1", origin: state.origin, rootHash: root.toString("base64"), timestamp: Math.floor(Date.now() / 1000), treesize: treeSize };
  return {
    schemaVersion: entry.envelope.schemaVersion,
    status: new Date(a.notAfter) > new Date() ? "ACTIVE" : "EXPIRED",
    merkleProof: {
      leafHash: entry.leafHash.toString("hex"),
      leafIndex: a.leafIndex,
      treeSize,
      path: merklePath(leaves, a.leafIndex).map((b) => b.toString("base64")),
      rootHash: root.toString("base64"),
      rootSignature: embeddedJws(checkpoint, state.tlKeyHash, TL_NAME),
      treeVersion: 1,
    },
    payload: entry.envelope.payload,
    signature: entry.envelope.signature,
  };
}

/** JSON receipt: the leaf's position, the hash chain link, and the signed checkpoint. */
export function receiptFor(agentId: string) {
  const a = agentById(agentId);
  const badge = badgeFor(agentId);
  if (!a || !badge || !state) return undefined;
  const entry = state.log[a.leafIndex];
  return {
    logId: a.logId,
    ansName: a.ansName,
    leafIndex: a.leafIndex,
    treeSize: badge.merkleProof.treeSize,
    leafHash: badge.merkleProof.leafHash,
    chain: { prevChainHash: entry.prevChainHash, chainHash: entry.chainHash, sealedAt: entry.sealedAt },
    inclusion: { path: badge.merkleProof.path, rootHash: badge.merkleProof.rootHash },
    rootSignature: badge.merkleProof.rootSignature,
    verify: "leaf = SHA-256(0x00 ‖ JCS({payload,schemaVersion,signature})); walk `path` to rootHash; rootSignature is ES256 JWS over the checkpoint, key from /root-keys",
  };
}

/** Recheck the whole hash chain (used by GET /v1/log/audit and tests). */
export function verifyChain(): { ok: boolean; length: number; head: string } {
  if (!state) return { ok: false, length: 0, head: "" };
  let prev = "0".repeat(64);
  for (const e of state.log) {
    const expect = createHash("sha256").update(Buffer.concat([Buffer.from(prev, "hex"), e.leafHash])).digest("hex");
    if (e.prevChainHash !== prev || e.chainHash !== expect) return { ok: false, length: state.log.length, head: "" };
    prev = e.chainHash;
  }
  return { ok: true, length: state.log.length, head: prev };
}

// ---------------------------------------------------------------------------
// Attack surface for the scenario catalog (agents/scenarios.ts). Nothing here
// runs unless a judge asks for it; every change is undone by its own restore.
// ---------------------------------------------------------------------------

/**
 * A certificate this CA really signed, for `host`'s ANS name, over
 * `keyOwner`'s key, that was never sealed in the transparency log. Models a
 * mis-issued certificate (or one issued off the books): the chain checks out,
 * so only the log can catch it. Written nowhere; the registered agent's own
 * certificate is untouched. `notAfter` in the past gives an expired one.
 */
export async function issueUnsealedCert(host: string, keyOwner: string, opts: { notAfter?: Date } = {}): Promise<string> {
  const s = await ensureLocalRegistry();
  const ca = new X509Certificate(s.caPem);
  const h = host.toLowerCase();
  const ansName = ansNameFor(h);
  const caKeys = await cryptoKeysFor(CA_NAME);
  const keys = await cryptoKeysFor(keyOwner);
  const notAfter = opts.notAfter ?? new Date(Date.now() + 90 * 86400_000);
  const notBefore = new Date(Math.min(Date.now() - 60_000, notAfter.getTime() - 86400_000));
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: `CN=${h}, O=${(agentByHost(h)?.organization ?? h).replace(/[,=]/g, " ")}, C=US`,
    issuer: ca.subject.split("\n").join(", "),
    notBefore,
    notAfter,
    signingAlgorithm: ECDSA_SIGN,
    publicKey: keys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: "url", value: ansName },
        { type: "dns", value: h },
      ]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  return cert.toString("pem");
}

/** The chain hash an entry had before tamperLog(true) rewrote it. */
let tamperedEntry: { index: number; chainHash: string } | undefined;

/**
 * Corrupt (or restore) one link of the append-only hash chain, the way an
 * insider editing the log's storage would. Merkle inclusion proofs still
 * verify (they hang off the leaf hashes), so only the chain audit notices,
 * and it notices for every agent at once: nobody gets through until the log
 * is restored. Returns whether the log is currently tampered.
 */
export function tamperLog(on: boolean): boolean {
  if (!state || state.log.length === 0) return false;
  const last = state.log[state.log.length - 1];
  if (on && !tamperedEntry) {
    tamperedEntry = { index: state.log.length - 1, chainHash: last.chainHash };
    last.chainHash = createHash("sha256").update(`tampered:${last.chainHash}`).digest("hex");
  } else if (!on && tamperedEntry) {
    const e = state.log[tamperedEntry.index];
    if (e) e.chainHash = tamperedEntry.chainHash;
    tamperedEntry = undefined;
  }
  return Boolean(tamperedEntry);
}

export function logTampered(): boolean {
  return Boolean(tamperedEntry);
}

/** Zone-file text a teammate can paste into GoDaddy DNS (docs/ans-setup.md). */
export function zoneFileText(): string {
  if (!state) return "";
  const lines = [`; Callsign local ANS zone — publish these in GoDaddy DNS to make the records public (ANS-3 §8.2)`, `; badge URLs point at ${config.publicBaseUrl}${LOCAL_REGISTRY_MOUNT} — that must be reachable from the internet`];
  for (const recs of state.zone.values()) for (const r of recs) lines.push(`${r.name}.\t${r.ttl}\tIN\t${r.type}\t${r.type === "TXT" ? JSON.stringify(r.data) : r.data}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// HTTP surface (ANS-4 §5 read API + the RA cert endpoint + zone views)
// ---------------------------------------------------------------------------

export const localRegistryRouter = Router();

localRegistryRouter.use(async (_req, res, next) => {
  try {
    await ensureLocalRegistry();
    next();
  } catch (e) {
    res.status(503).json({ code: "REGISTRY_UNAVAILABLE", message: (e as Error).message });
  }
});

localRegistryRouter.get("/", (_req, res) => {
  res.json({
    name: "Callsign local ANS registry",
    mode: "local",
    spec: "https://github.com/godaddy/ans-registry",
    agents: [...state!.agents.values()].map((a) => ({ agentId: a.agentId, ansName: a.ansName, displayName: a.displayName, badgeUrl: a.badgeUrl })),
    endpoints: ["/root-keys", "/checkpoint", "/v1/log/checkpoint", "/v1/log/audit", "/v1/agents/{agentId}", "/v1/agents/{agentId}/receipt", "/v1/agents/{agentId}/certificates/identity", "/ca.pem", "/dns/{name}", "/zone"],
  });
});

localRegistryRouter.get("/root-keys", (_req, res) => res.type("text/plain").send(localRootKeysText()));

localRegistryRouter.get("/checkpoint", (_req, res) => {
  const leaves = state!.log.map((e) => e.leafHash);
  res.type("text/plain").send(`${state!.origin}\n${leaves.length}\n${merkleRoot(leaves).toString("base64")}\n`);
});

localRegistryRouter.get("/v1/log/checkpoint", (_req, res) => {
  const leaves = state!.log.map((e) => e.leafHash);
  const cp = { checkpointFormat: "c2sp/v1", origin: state!.origin, rootHash: merkleRoot(leaves).toString("base64"), timestamp: Math.floor(Date.now() / 1000), treesize: leaves.length };
  res.json({ ...cp, chainHead: verifyChain().head, signature: embeddedJws(cp, state!.tlKeyHash, TL_NAME) });
});

localRegistryRouter.get("/v1/log/audit", (_req, res) => {
  res.json({
    chain: verifyChain(),
    entries: state!.log.map((e, i) => ({ leafIndex: i, logId: e.envelope.payload.logId, ansName: e.envelope.payload.producer.event.ansName, leafHash: e.leafHash.toString("hex"), chainHash: e.chainHash, sealedAt: e.sealedAt })),
  });
});

localRegistryRouter.get("/v1/agents", (_req, res) => res.json([...state!.agents.values()].map(({ certPem: _c, ...a }) => a)));

localRegistryRouter.get("/v1/agents/:agentId", (req, res) => {
  const b = badgeFor(req.params.agentId);
  if (b) res.json(b);
  else res.status(404).json({ code: "NOT_FOUND", message: "Resource not found" });
});

localRegistryRouter.get("/v1/agents/:agentId/receipt", (req, res) => {
  const r = receiptFor(req.params.agentId);
  if (r) res.json(r);
  else res.status(404).json({ code: "NOT_FOUND", message: "Resource not found" });
});

localRegistryRouter.get("/v1/agents/:agentId/certificates/identity", (req, res) => {
  const a = agentById(req.params.agentId);
  if (!a) return res.status(404).json({ code: "NOT_FOUND", message: "Resource not found" });
  const c = new X509Certificate(a.certPem);
  res.json([{ csrId: a.agentId, certificateSubject: c.subject.replace(/\n/g, ","), certificateIssuer: c.issuer.replace(/\n/g, ","), certificateSerialNumber: c.serialNumber, certificateValidFrom: c.validFrom, certificateValidTo: c.validTo, certificatePEM: a.certPem, chainPEM: state!.caPem, certificatePublicKeyAlgorithm: "EC P-256", certificateSignatureAlgorithm: "SHA256withECDSA" }]);
});

localRegistryRouter.get("/ca.pem", (_req, res) => res.type("application/x-pem-file").send(state!.caPem));

localRegistryRouter.get("/dns/:name", (req, res) => {
  const recs = lookupZone(req.params.name);
  if (recs.length) res.json(recs);
  else res.status(404).json({ code: "NXDOMAIN", message: `no ANS record for ${req.params.name}` });
});

localRegistryRouter.get("/zone", (_req, res) => res.type("text/plain").send(zoneFileText()));

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

async function cryptoKeysFor(agentName: string): Promise<CryptoKeyPair> {
  // Copy the DER into fresh ArrayBuffer-backed views: this project's tsconfig includes the DOM lib, whose
  // BufferSource/CryptoKey types differ from node:crypto's webcrypto types at compile time only.
  const privateKey = await subtle.importKey("pkcs8", new Uint8Array(privateKeyDerFor(agentName)), ECDSA_KEY, true, ["sign"]);
  const publicKey = await subtle.importKey("spki", new Uint8Array(publicKeyDerFor(agentName)), ECDSA_KEY, true, ["verify"]);
  return { privateKey, publicKey } as unknown as CryptoKeyPair;
}

async function ensureCa(): Promise<string> {
  const existing = certificatePemFor(CA_NAME);
  if (existing) {
    try {
      const c = new X509Certificate(existing);
      const samePub = c.publicKey.export({ type: "spki", format: "der" }).equals(publicKeyDerFor(CA_NAME));
      if (samePub && new Date(c.validTo) > new Date()) return existing;
    } catch {
      /* regenerate */
    }
  }
  const keys = await cryptoKeysFor(CA_NAME);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: "CN=Callsign Local ANS CA (demo), O=Callsign, C=US",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86400_000),
    signingAlgorithm: ECDSA_SIGN,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign | x509.KeyUsageFlags.digitalSignature, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pem = cert.toString("pem");
  fs.writeFileSync(certPathFor(CA_NAME), pem);
  console.log(`[ans:local] issued CA certificate -> keys/${CA_NAME}.pem`);
  return pem;
}

/** ANS-2 §3 Identity Certificate: URI SAN = ANSName, digitalSignature, clientAuth, signed by the private CA. */
async function ensureIdentityCert(host: string, ansName: string, displayName: string, organization: string, caPem: string): Promise<X509Certificate> {
  const ca = new X509Certificate(caPem);
  const existing = certificatePemFor(host);
  if (existing) {
    try {
      const c = new X509Certificate(existing);
      const sanOk = (c.subjectAltName ?? "").toLowerCase().includes(`uri:${ansName.toLowerCase()}`);
      const keyOk = c.publicKey.export({ type: "spki", format: "der" }).equals(publicKeyDerFor(host));
      if (sanOk && keyOk && c.checkIssued(ca) && c.verify(ca.publicKey) && new Date(c.validTo) > new Date()) return c;
    } catch {
      /* reissue */
    }
  }
  const caKeys = await cryptoKeysFor(CA_NAME);
  const agentKeys = await cryptoKeysFor(host);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: `CN=${host}, O=${organization.replace(/[,=]/g, " ")}, C=US`,
    issuer: ca.subject.split("\n").join(", "),
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 90 * 86400_000),
    signingAlgorithm: ECDSA_SIGN,
    publicKey: agentKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: "url", value: ansName }, // uniformResourceIdentifier SAN carrying the ANSName
        { type: "dns", value: host },
      ]),
      await x509.SubjectKeyIdentifierExtension.create(agentKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const pem = cert.toString("pem");
  fs.writeFileSync(certPathFor(host), pem);
  console.log(`[ans:local] issued identity certificate for ${ansName} (${displayName}) -> keys/${host}.pem`);
  return new X509Certificate(pem);
}

/** ANS-6 §4.5: kid = SHA-256(SPKI DER)[0:4]. */
function keyHashFor(agentName: string): string {
  return createHash("sha256").update(publicKeyDerFor(agentName)).digest("hex").slice(0, 8);
}

function jwsSign(signingInput: string, signer: string): string {
  return cryptoSign("sha256", Buffer.from(signingInput, "utf8"), { key: privateKeyFor(signer), dsaEncoding: "ieee-p1363" }).toString("base64url");
}

/** JWS Detached (RFC 7515 App. F): `<header>..<sig>` over base64url(payload). */
function detachedJws(payload: string, kid: string, signer: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", kid, typ: "JWT", timestamp: Math.floor(Date.now() / 1000), raid: RA_ID }), "utf8").toString("base64url");
  return `${h}..${jwsSign(`${h}.${Buffer.from(payload, "utf8").toString("base64url")}`, signer)}`;
}

/** JWS compact with embedded JSON payload (the checkpoint / rootSignature form the live log uses). */
function embeddedJws(payload: unknown, kid: string, signer: string): string {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", kid, typ: "JWT", timestamp: Math.floor(Date.now() / 1000), raid: RA_ID }), "utf8").toString("base64url");
  const p = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${h}.${p}.${jwsSign(`${h}.${p}`, signer)}`;
}

function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x40; // version 4 shape
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function uuidV7(): string {
  const t = Date.now().toString(16).padStart(12, "0");
  const r = webcrypto.getRandomValues(new Uint8Array(10));
  const rh = Buffer.from(r).toString("hex");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${rh.slice(0, 3)}-${((parseInt(rh.slice(3, 5), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${rh.slice(5, 7)}-${rh.slice(7, 19)}`;
}

const randomSerial = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex").replace(/^[89a-f]/, "1");

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "localhost";
  }
}

function caSubject(pem: string): string {
  try {
    return /CN=([^\n]+)/.exec(new X509Certificate(pem).subject)?.[1] ?? "CA";
  } catch {
    return "CA";
  }
}
