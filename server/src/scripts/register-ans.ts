/**
 * ANS REGISTRATION  (owner: Identity lane)
 *
 * Registers an agent with GoDaddy's Agent Name Service Registration Authority
 * and saves the issued Identity Certificate next to the agent's key so
 * ANS_MODE=real can present it.
 *
 * Flow, per the ANS-1 registration sequence
 * (https://github.com/godaddy/ans-registry/blob/main/spec/ans-1-registration.md#4-registration-sequence)
 * and GoDaddy's published API reference
 * (https://developer.godaddy.com/docs/references/rest/ans/registration,
 *  https://developer.godaddy.com/docs/references/rest/ans/certificate-management):
 *
 *   1. P-256 key pair per agent (server/keys/<host>.key, from verify/sign.ts)
 *   2. Identity CSR with the ANSName `ans://v{version}.{host}` as a URI SAN
 *      (ANS-2 §3) + server CSR with the host as a DNS SAN
 *   3. POST {ANS_API_BASE}/agents/register            -> 202 { agentId, ansName, challenge{dnsRecord}, nextSteps }
 *   4. publish the _acme-challenge TXT, POST /agents/{agentId}/verify-acme  -> PENDING_DNS
 *   5. GET /agents/{agentId}, publish the ANS records it lists (_ans, _ans-badge, TLSA),
 *      POST /agents/{agentId}/verify-dns                                     -> ACTIVE
 *   6. GET /agents/{agentId}/certificates/identity -> save certificatePEM to server/keys/<host>.pem
 *   7. GET the badge from the _ans-badge URL and verify the transparency receipt locally
 *
 * Auth: the developer portal lists the ANS API as "Auth: PAT" (personal access
 * token). We send `Authorization: Bearer $ANS_API_KEY`; if ANS_API_SECRET is
 * also set we send the classic `Authorization: sso-key KEY:SECRET` instead.
 * CONFIRM AT THE WORKSHOP: which header the ANS endpoints accept, whether
 * the base is https://api.godaddy.com/v1 or the OTE https://api.ote-godaddy.com/v1,
 * and the `transports` enum values (omitted here because they are optional).
 *
 * Usage:
 *   npm run register-ans -- <agent-host>            start or resume a registration
 *   npm run register-ans -- <agent-host> --status   print the RA's view of the agent
 *   npm run register-ans -- <agent-host> --csr-only just print the CSRs (paste into a portal)
 *
 * Progress is checkpointed in server/keys/<host>.ans.json so the script can
 * be re-run after publishing DNS records; every step is idempotent.
 */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Resolver } from "node:dns/promises";
import { config } from "../config.ts";
import { brandIdentity, hcpIdentity } from "../seed/data.ts";
import { ANS_VERSION, ansNameFor, checkCertificate, fetchJson, publicRootKeys, resolveAgentDns, verifyBadge, type Badge } from "../verify/ans.ts";
import { certPathFor, KEYS_DIR, privateKeyDerFor, publicKeyDerFor, publicKeyPemFor } from "../verify/sign.ts";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const args = process.argv.slice(2);
const agentHost = args.find((a) => !a.startsWith("--"))?.toLowerCase();
const flag = (f: string) => args.includes(f);
if (!agentHost) {
  console.error("usage: npm run register-ans -- <agent-host> [--status] [--csr-only]");
  process.exit(1);
}

// api.godaddy.com/v1/agents/* per the developer portal; tolerate the older ".../v1/ans" default in config.
const API_BASE = config.ans.apiBase.replace(/\/+$/, "").replace(/\/ans$/, "");
const identity = [hcpIdentity, brandIdentity].find((i) => i.name.toLowerCase() === agentHost);
const displayName = identity?.displayName ?? agentHost;
const description = identity ? `Callsign ${identity.role} agent for ${identity.organization}`.slice(0, 150) : "Callsign agent";
const ansName = ansNameFor(agentHost, ANS_VERSION);
const stateFile = path.join(KEYS_DIR, `${agentHost}.ans.json`);

interface RegState {
  agentId?: string;
  ansName?: string;
  status?: string;
  challenge?: { dnsRecord?: { name: string; type: string; value: string }; httpPath?: string; keyAuthorization?: string };
  dnsRecords?: { name: string; type: string; value: string; ttl?: number; purpose?: string }[];
  history: string[];
}
interface RegistrationResponse {
  agentId?: string;
  ansName?: string;
  status?: string;
  agentStatus?: string;
  phase?: string;
  challenge?: RegState["challenge"];
  challenges?: NonNullable<RegState["challenge"]>[];
  dnsRecords?: RegState["dnsRecords"];
  registrationPending?: { dnsRecords?: RegState["dnsRecords"] };
  pendingSteps?: unknown[];
}

interface IdentityCertificateResponse {
  certificatePEM?: string;
  chainPEM?: string;
  csrId?: string;
}
const st: RegState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { history: [] };
const save = (note?: string) => {
  if (note) st.history.push(`${new Date().toISOString()} ${note}`);
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
};

function authHeaders(): Record<string, string> {
  if (!config.ans.apiKey) throw new Error("ANS_API_KEY is not set (.env). Ask GoDaddy for an ANS API key / PAT at the workshop.");
  const auth = config.ans.apiSecret ? `sso-key ${config.ans.apiKey}:${config.ans.apiSecret}` : `Bearer ${config.ans.apiKey}`;
  return { authorization: auth, "content-type": "application/json", accept: "application/json" };
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_BASE}${p}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 600)}`);
  return { status: res.status, body: parsed as T };
}

// ---------------------------------------------------------------------------
// CSRs
// ---------------------------------------------------------------------------

async function buildCsrs(): Promise<{ identityCsrPEM: string; serverCsrPEM: string }> {
  const alg = { name: "ECDSA", namedCurve: "P-256" } as const;
  const keys: CryptoKeyPair = {
    privateKey: await webcrypto.subtle.importKey("pkcs8", privateKeyDerFor(agentHost!), alg, true, ["sign"]),
    publicKey: await webcrypto.subtle.importKey("spki", publicKeyDerFor(agentHost!), alg, true, ["verify"]),
  };
  const signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
  const org = (identity?.organization ?? "Callsign").replace(/[,=]/g, " ");
  // ANS-2 §3: "The CSR MUST carry the registration's full ANSName as a uniformResourceIdentifier SAN."
  const identityCsr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${agentHost}, O=${org}, C=US`,
    keys,
    signingAlgorithm,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: "url", value: ansName }]),
    ],
  });
  // "Server CSRs differ: they carry the agent's FQDN as a DNS SAN, the TLS server-auth convention."
  const serverCsr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${agentHost}, O=${org}, C=US`,
    keys,
    signingAlgorithm,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: agentHost! }]),
    ],
  });
  return { identityCsrPEM: identityCsr.toString("pem"), serverCsrPEM: serverCsr.toString("pem") };
}

// ---------------------------------------------------------------------------
// DNS polling helper
// ---------------------------------------------------------------------------

async function waitForTxt(name: string, expected: string | undefined, maxMinutes = 15): Promise<boolean> {
  const resolver = new Resolver();
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);
  const deadline = Date.now() + maxMinutes * 60_000;
  process.stdout.write(`  waiting for TXT ${name}${expected ? ` = "${expected.slice(0, 40)}…"` : ""} (up to ${maxMinutes} min; Ctrl-C and re-run to resume) `);
  while (Date.now() < deadline) {
    try {
      const rows = (await resolver.resolveTxt(name)).map((c) => c.join(""));
      if (rows.length && (!expected || rows.includes(expected))) {
        console.log("\n  found.");
        return true;
      }
    } catch {
      /* NXDOMAIN yet */
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log("\n  not visible yet.");
  return false;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepRegister() {
  if (st.agentId) return console.log(`[1] already registered: agentId ${st.agentId} (${st.ansName}) status ${st.status ?? "?"}`);
  const csrs = await buildCsrs();
  const body = {
    agentDisplayName: displayName.slice(0, 64),
    agentDescription: description,
    version: ANS_VERSION,
    agentHost,
    endpoints: [
      {
        protocol: "A2A",
        agentUrl: `https://${agentHost}/reach`, // hostname MUST equal agentHost (ANS-1 §4.1)
        metaDataUrl: `https://${agentHost}/.well-known/agent.json`,
        documentationUrl: `https://${agentHost}/`,
      },
    ],
    identityCsrPEM: csrs.identityCsrPEM,
    serverCsrPEM: csrs.serverCsrPEM,
  };
  console.log(`[1] POST ${API_BASE}/agents/register for ${ansName}`);
  const { body: r } = await api<RegistrationResponse>("POST", "/agents/register", body);
  st.agentId = r.agentId;
  st.ansName = r.ansName ?? ansName;
  st.status = r.status;
  st.challenge = r.challenge ?? r.challenges?.[0];
  st.dnsRecords = r.dnsRecords;
  save(`registered agentId=${st.agentId} status=${st.status}`);
  console.log(`    agentId ${st.agentId} · status ${st.status}`);
  if (st.challenge?.dnsRecord) {
    const d = st.challenge.dnsRecord;
    console.log(`\n    PUBLISH THIS ACME CHALLENGE IN GODADDY DNS:\n      ${d.name}  ${d.type}  "${d.value}"\n`);
  }
  if (st.challenge?.httpPath) console.log(`    (or serve HTTP-01 at https://${agentHost}${st.challenge.httpPath} → ${st.challenge.keyAuthorization})`);
}

async function stepVerifyAcme() {
  if (!st.agentId) return;
  if (st.status && st.status !== "PENDING_VALIDATION") return console.log(`[2] verify-acme already done (status ${st.status})`);
  const d = st.challenge?.dnsRecord;
  if (d) {
    const ok = await waitForTxt(d.name, d.value);
    if (!ok) throw new Error(`publish ${d.name} TXT "${d.value}" in GoDaddy DNS, then re-run`);
  }
  console.log(`[2] POST /agents/${st.agentId}/verify-acme`);
  for (let attempt = 1; attempt <= 30; attempt++) {
    const { status, body } = await api<RegistrationResponse>("POST", `/agents/${st.agentId}/verify-acme`);
    st.status = body.status ?? st.status;
    save(`verify-acme attempt ${attempt} → HTTP ${status} status=${st.status} phase=${body.phase ?? "?"}`);
    console.log(`    HTTP ${status} · status ${st.status} · phase ${body.phase ?? "?"} · pending ${JSON.stringify(body.pendingSteps ?? [])}`);
    if (st.status === "PENDING_DNS" || st.status === "ACTIVE") return;
    await new Promise((r) => setTimeout(r, 10_000)); // ACME order may still be pending; re-POST re-drives it (ANS-1 §4.2)
  }
  throw new Error("verify-acme did not reach PENDING_DNS; check the challenge record and re-run");
}

async function stepDnsRecords() {
  if (!st.agentId || st.status === "ACTIVE") return;
  const { body } = await api<RegistrationResponse>("GET", `/agents/${st.agentId}`);
  st.status = body.agentStatus ?? st.status;
  const recs = body.registrationPending?.dnsRecords ?? body.dnsRecords ?? st.dnsRecords ?? [];
  st.dnsRecords = recs;
  save(`fetched ${recs.length} DNS records to publish`);
  if (!recs.length) return console.log("[3] the RA listed no DNS records yet — re-run in a minute");
  console.log(`[3] PUBLISH THESE ANS RECORDS IN GODADDY DNS (ANS-3 §3):`);
  for (const r of recs) console.log(`      ${r.name}  ${r.type}  ${r.type === "TXT" ? JSON.stringify(r.value) : r.value}${r.purpose ? `   ; ${r.purpose}` : ""}`);
  console.log();
}

async function stepVerifyDns() {
  if (!st.agentId || st.status === "ACTIVE") return console.log(`[4] already ACTIVE`);
  const badge = st.dnsRecords?.find((r) => /^_ans-badge\.|^_ra-badge\./.test(r.name));
  if (badge) {
    const ok = await waitForTxt(badge.name, badge.value);
    if (!ok) throw new Error("publish the ANS records above, then re-run");
  }
  console.log(`[4] POST /agents/${st.agentId}/verify-dns`);
  const { status, body } = await api<RegistrationResponse>("POST", `/agents/${st.agentId}/verify-dns`);
  st.status = body.status ?? st.status;
  save(`verify-dns → HTTP ${status} status=${st.status}`);
  console.log(`    HTTP ${status} · status ${st.status} · phase ${body.phase ?? "?"}`);
  if (st.status !== "ACTIVE") {
    const { body: b2 } = await api<RegistrationResponse>("GET", `/agents/${st.agentId}`);
    st.status = b2.agentStatus ?? st.status;
    save();
  }
}

async function stepSaveCert() {
  if (!st.agentId) return;
  console.log(`[5] GET /agents/${st.agentId}/certificates/identity`);
  const { body } = await api<IdentityCertificateResponse[]>("GET", `/agents/${st.agentId}/certificates/identity`);
  const cert = body.find((c): c is IdentityCertificateResponse & { certificatePEM: string } => typeof c.certificatePEM === "string" && c.certificatePEM.includes("BEGIN CERTIFICATE"));
  if (!cert) return console.log("    no identity certificate issued yet — re-run after the registration is ACTIVE");
  const check = checkCertificate(cert.certificatePEM, { expectedAnsName: ansName });
  console.log(`    ${check.ok ? "OK" : "PROBLEM"}: ${check.detail}`);
  if (check.ok && check.publicKeyPem?.trim() !== publicKeyPemFor(agentHost!).trim()) console.log("    WARNING: certificate public key differs from server/keys/<host>.key");
  fs.writeFileSync(certPathFor(agentHost!), cert.certificatePEM);
  if (cert.chainPEM && String(cert.chainPEM).includes("BEGIN CERTIFICATE")) fs.writeFileSync(path.join(KEYS_DIR, `${agentHost}.chain.pem`), cert.chainPEM);
  save(`saved certificate ${cert.csrId ?? ""}`);
  console.log(`    saved → server/keys/${agentHost}.pem${cert.chainPEM ? ` (+ ${agentHost}.chain.pem; point ANS_CA_PEM_FILE at it)` : ""}`);
}

async function stepReceipt() {
  console.log(`[6] transparency receipt`);
  const r = await resolveAgentDns(agentHost!, { timeoutMs: 4000 });
  if (!r.ok || !r.records) return console.log(`    ${r.detail} — publish the records and re-run`);
  const b = await fetchJson<Badge>(r.records.badge.url, 8000);
  if (!b.ok || !b.body) return console.log(`    ${b.detail}`);
  const k = await publicRootKeys();
  const v = verifyBadge(b.body, { expectedAnsName: `ans://v${r.records.badge.version ?? ANS_VERSION}.${agentHost}`, rootKeysText: k.text ?? "" });
  console.log(`    badge ${r.records.badge.url}`);
  console.log(`    ${v.ok ? "VERIFIED" : "FAILED"}: ${v.detail}`);
  if (v.identityFingerprints?.length) console.log(`    identity cert fingerprints sealed: ${v.identityFingerprints.join(", ")}`);
  console.log(`    logId ${b.body.payload?.logId} · leaf ${b.body.merkleProof?.leafIndex} · treeSize ${b.body.merkleProof?.treeSize} · root ${b.body.merkleProof?.rootHash}`);
}

// ---------------------------------------------------------------------------

try {
  console.log(`register-ans · ${ansName} · RA ${API_BASE}\n`);
  if (flag("--csr-only")) {
    const c = await buildCsrs();
    console.log(c.identityCsrPEM);
    console.log(c.serverCsrPEM);
    process.exit(0);
  }
  if (flag("--status")) {
    if (!st.agentId) throw new Error("no registration on file for this host");
    const { body } = await api("GET", `/agents/${st.agentId}`);
    console.log(JSON.stringify(body, null, 2));
    process.exit(0);
  }
  await stepRegister();
  await stepVerifyAcme();
  await stepDnsRecords();
  await stepVerifyDns();
  if (st.status === "ACTIVE") {
    await stepSaveCert();
    await stepReceipt();
    console.log(`\nDone. Set ANS_MODE=real and restart; the brand will present server/keys/${agentHost}.pem.`);
  } else {
    console.log(`\nStopped at status ${st.status ?? "?"}. Re-run \`npm run register-ans -- ${agentHost}\` after publishing the records.`);
  }
} catch (e) {
  console.error(`\nregister-ans failed: ${(e as Error).message}`);
  save(`error: ${(e as Error).message}`);
  process.exit(1);
}
