import type { ImpostorVariant, ReachRequest } from "@callsign/shared";
import { webcrypto, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import "reflect-metadata"; // @peculiar/x509 (tsyringe) needs the Reflect polyfill loaded first
import * as x509 from "@peculiar/x509";
import { config } from "../config.ts";
import { id, nowIso } from "../events.ts";
import { brandIdentity, impostorIdentity, todaysUpdate } from "../seed/data.ts";
import { ansNameFor } from "../verify/ans.ts";
import { canonicalReach, certificatePemFor, KEYS_DIR, privateKeyDerFor, publicKeyDerFor, signAs } from "../verify/sign.ts";

/**
 * BRAND AGENT + IMPOSTORS  (owner: Identity lane)
 *
 * Builds the ReachRequest each sender posts to the doctor's agent.
 *
 * The brand signs with its real P-256 key (server/keys/<brand>.key) and
 * presents the ANS Identity Certificate issued for that key
 * (server/keys/<brand>.pem — written by the local registry in ANS_MODE=local,
 * or by scripts/register-ans.ts from GoDaddy's RA in ANS_MODE=real). The
 * verifier never trusts the presented certificate on its own: it anchors it
 * to the DNS badge record and the transparency-log fingerprint.
 *
 * Five ways an attacker tries, each failing at a different step
 * (shared IMPOSTOR_VARIANTS is the contract the trust card reads):
 *
 *  no-record        stelazio-updates.xyz, its own key, no registry record   → resolve
 *  forged-cert      claims stelazio.brand-demo.com, presents a certificate
 *                   for that exact ANS name minted by its own rogue CA over
 *                   its own key; signs with that key                        → certificate
 *  tampered         a genuine brand message whose dosing text was edited
 *                   after signing (5 mg → 50 mg)                            → signature
 *  replay           the last genuine brand message, captured and resent
 *                   11 minutes later with the same id                       → signature (stale · seen)
 *  wrong-specialty  genuine brand, genuine cert, a nephrology update        → verified, held by policy
 */

const brandHost = brandIdentity.name.toLowerCase();

/** Remembered so the replay variant can resend exactly what was verified. */
let lastBrandReach: ReachRequest | undefined;

export function buildBrandReach(): ReachRequest {
  const req = signedBrandRequest({
    kind: todaysUpdate.kind,
    payload: {
      summary: todaysUpdate.summary,
      detail: todaysUpdate.detail,
      affectedPatients: todaysUpdate.affectedPatients,
      specialty: todaysUpdate.specialty,
    },
  });
  lastBrandReach = req;
  return req;
}

export function buildImpostorReach(variant: ImpostorVariant = "no-record"): ReachRequest {
  switch (variant) {
    case "forged-cert":
      return buildForgedCert();
    case "tampered":
      return buildTampered();
    case "replay":
      return buildReplay();
    case "wrong-specialty":
      return buildWrongSpecialty();
    case "no-record":
    default:
      return buildNoRecord();
  }
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/** A look-alike domain with no ANS record, signing with a key nobody vouches for. */
function buildNoRecord(): ReachRequest {
  const req: ReachRequest = {
    id: id("req"),
    from: impostorIdentity.name,
    to: config.hcpAgentName,
    claimedDisplayName: impostorIdentity.displayName, // "Stelazio", the lie
    kind: "label_update",
    payload: {
      summary: "URGENT: Stelazio dosing has changed. Call back immediately to confirm your patients' new prescriptions.",
      detail: "This is an important safety communication. Reply with your NPI and DEA number to receive the update.",
      affectedPatients: 7,
      specialty: "Cardiology",
    },
    ts: nowIso(),
  };
  req.signature = signAs(impostorIdentity.name, canonicalReach(req));
  return req;
}

/**
 * Claims the brand's real ANS name and presents a certificate that says so:
 * subject CN and URI SAN are exactly the brand's, but it was issued by the
 * impostor's own "Stelazio Updates Root CA" over the impostor's key. The
 * registry record resolves (the name is real); the certificate does not chain
 * to the ANS CA and its fingerprint is not the one the transparency log sealed.
 */
function buildForgedCert(): ReachRequest {
  const req: ReachRequest = {
    id: id("req"),
    from: brandIdentity.name,
    to: config.hcpAgentName,
    claimedDisplayName: brandIdentity.displayName,
    kind: "label_update",
    payload: {
      summary: "Stelazio safety communication: revised titration schedule now in effect for all cardiology patients.",
      detail: "To receive the full revised prescribing information, confirm your prescriber identity (NPI and state license) at the secure portal linked in this message within 24 hours.",
      affectedPatients: 7,
      specialty: "Cardiology",
    },
    ts: nowIso(),
  };
  // Signed with the impostor's key: the one inside the forged certificate, so the forgery is internally consistent.
  req.signature = signAs(impostorIdentity.name, canonicalReach(req));
  req.certificatePem = forgedCertPem ?? FORGED_PLACEHOLDER_PEM;
  return req;
}

/**
 * A genuine brand message (real key, real certificate) whose payload was
 * edited after it was signed: the renal dose reads 50 mg instead of 5 mg.
 * The signature was made over the original bytes, so it no longer matches.
 */
function buildTampered(): ReachRequest {
  const req = signedBrandRequest({
    kind: todaysUpdate.kind,
    payload: {
      summary: todaysUpdate.summary,
      detail: todaysUpdate.detail,
      affectedPatients: todaysUpdate.affectedPatients,
      specialty: todaysUpdate.specialty,
    },
  });
  // In flight: the dose is changed after signing. Ten times the real dose.
  req.payload.summary = todaysUpdate.summary.replace(/\b5 mg\b/, "50 mg");
  req.payload.detail = todaysUpdate.detail?.replace(/\b5 mg\b/, "50 mg");
  return req;
}

/**
 * The last genuine brand message, resent as captured: same id, same body,
 * timestamp 11 minutes in the past, signed by the brand's key (that is what
 * "captured" means: the attacker holds a genuinely signed message). If no
 * brand message has been sent yet in this process, a fresh one stands in.
 */
function buildReplay(): ReachRequest {
  const captured = lastBrandReach ?? buildBrandReach();
  const req: ReachRequest = {
    id: captured.id,
    from: captured.from,
    to: captured.to,
    claimedDisplayName: captured.claimedDisplayName,
    kind: captured.kind,
    payload: { ...captured.payload },
    ts: new Date(Date.now() - 11 * 60_000).toISOString(),
  };
  req.signature = signAs(brandHost, canonicalReach(req));
  const cert = certificatePemFor(brandHost);
  if (cert) req.certificatePem = cert;
  return req;
}

/** Genuine brand, genuine cert, but a nephrology update: identity passes, the doctor's policy holds it. */
function buildWrongSpecialty(): ReachRequest {
  return signedBrandRequest({
    kind: "label_update",
    payload: {
      summary: "Stelazio in dialysis-dependent patients: new Section 8.6 guidance on dosing during hemodialysis.",
      detail: "Section 8.6 of the prescribing information now describes dosing for patients on intermittent hemodialysis. Administer the dose after dialysis on dialysis days. This update is intended for nephrology practices.",
      affectedPatients: 0,
      specialty: "Nephrology",
    },
  });
}

/** Brand-signed request with the brand's real certificate attached when one has been issued. */
function signedBrandRequest(body: Pick<ReachRequest, "kind" | "payload">): ReachRequest {
  const req: ReachRequest = {
    id: id("req"),
    from: brandIdentity.name,
    to: config.hcpAgentName,
    claimedDisplayName: brandIdentity.displayName,
    kind: body.kind,
    payload: { ...body.payload },
    ts: nowIso(),
  };
  req.signature = signAs(brandHost, canonicalReach(req));
  const cert = certificatePemFor(brandHost);
  if (cert) req.certificatePem = cert;
  return req;
}

// ---------------------------------------------------------------------------
// The forged certificate: same X.509 tooling the local registry uses, wrong CA
// ---------------------------------------------------------------------------

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const subtle = webcrypto.subtle;
const ECDSA_KEY = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

const ROGUE_CA_NAME = "stelazio-updates-rogue-ca"; // server/keys/stelazio-updates-rogue-ca.{key,pem}
const ROGUE_CA_SUBJECT = "CN=Stelazio Updates Root CA, O=stelazio-updates.xyz, C=US";
export const FORGED_CERT_PATH = path.join(KEYS_DIR, `forged-${brandHost}.pem`);
const ROGUE_CA_PATH = path.join(KEYS_DIR, `${ROGUE_CA_NAME}.pem`);

/** Fails to parse on purpose, so the certificate step still rejects if minting has not finished yet. */
const FORGED_PLACEHOLDER_PEM = "-----BEGIN CERTIFICATE-----\nZm9yZ2VkIGNlcnRpZmljYXRlIG5vdCBtaW50ZWQgeWV0\n-----END CERTIFICATE-----\n";

let forgedCertPem: string | undefined;
let forgedInit: Promise<string> | undefined;

/** Idempotent: mint (or reload) the rogue CA and the forged brand certificate. Safe to call often. */
export function ensureForgedCert(): Promise<string> {
  if (forgedCertPem) return Promise.resolve(forgedCertPem);
  forgedInit ??= mintForgedCert()
    .then((pem) => (forgedCertPem = pem))
    .catch((e) => {
      forgedInit = undefined;
      throw e;
    });
  return forgedInit;
}

/** What the forged certificate looks like, for docs/tests. Undefined until minted. */
export function forgedCertInfo(): { subject: string; issuer: string; fingerprint: string } | undefined {
  if (!forgedCertPem) return undefined;
  const c = new X509Certificate(forgedCertPem);
  return { subject: c.subject.replace(/\n/g, ", "), issuer: c.issuer.replace(/\n/g, ", "), fingerprint: c.fingerprint256.replace(/:/g, "").toLowerCase() };
}

async function keysFor(agentName: string): Promise<CryptoKeyPair> {
  const privateKey = await subtle.importKey("pkcs8", privateKeyDerFor(agentName), ECDSA_KEY, true, ["sign"]);
  const publicKey = await subtle.importKey("spki", publicKeyDerFor(agentName), ECDSA_KEY, true, ["verify"]);
  return { privateKey, publicKey };
}

async function mintForgedCert(): Promise<string> {
  const ansName = ansNameFor(brandHost);
  const impostorKey = impostorIdentity.name;

  // Reuse a cached forgery if it still says what we need and is under the impostor's key.
  const cached = readPem(FORGED_CERT_PATH);
  const cachedCa = readPem(ROGUE_CA_PATH);
  if (cached && cachedCa) {
    try {
      const c = new X509Certificate(cached);
      const ca = new X509Certificate(cachedCa);
      const sanOk = (c.subjectAltName ?? "").toLowerCase().includes(`uri:${ansName.toLowerCase()}`);
      const keyOk = c.publicKey.export({ type: "spki", format: "der" }).equals(publicKeyDerFor(impostorKey));
      if (sanOk && keyOk && c.checkIssued(ca) && c.verify(ca.publicKey) && new Date(c.validTo) > new Date()) return cached;
    } catch {
      /* re-mint */
    }
  }

  const caKeys = await keysFor(ROGUE_CA_NAME);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: ROGUE_CA_SUBJECT,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86400_000),
    signingAlgorithm: ECDSA_SIGN,
    keys: caKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign | x509.KeyUsageFlags.digitalSignature, true), await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey)],
  });
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(ROGUE_CA_PATH, ca.toString("pem"));

  const leafKeys = await keysFor(impostorKey);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    // Word for word what the real certificate says, minus "(demo)": the forgery is meant to read as genuine.
    subject: `CN=${brandHost}, O=${brandIdentity.organization.replace(/\s*\(demo\)/, "").replace(/[,=]/g, " ")}, C=US`,
    issuer: ROGUE_CA_SUBJECT,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 90 * 86400_000),
    signingAlgorithm: ECDSA_SIGN,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: "url", value: ansName },
        { type: "dns", value: brandHost },
      ]),
      await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const pem = leaf.toString("pem");
  fs.writeFileSync(FORGED_CERT_PATH, pem);
  console.log(`[impostor] minted forged certificate for ${ansName} under "${ROGUE_CA_SUBJECT.split(",")[0].slice(3)}" -> keys/${path.basename(FORGED_CERT_PATH)}`);
  return pem;
}

function readPem(p: string): string | undefined {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

const randomSerial = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex").replace(/^[89a-f]/, "1");

// Warm at boot so the first "Forged certificate" click has a real forgery to present.
void ensureForgedCert().catch((e) => console.warn("[impostor] forged cert init failed:", (e as Error).message));
