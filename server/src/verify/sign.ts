import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReachRequest } from "@callsign/shared";

/**
 * SIGNING  (owner: Identity lane)
 *
 * Canonicalization + sign/verify for ReachRequests and negotiation receipts,
 * with real ECDSA P-256 / SHA-256 (ES256, the algorithm ANS uses everywhere:
 * https://github.com/godaddy/ans-registry/blob/main/spec/ans-4-transparency.md#3-cryptographic-standards).
 *
 * Keys live in server/keys/<agent-name>.key (PKCS#8 PEM) and are generated on
 * first use. Certificates issued for an agent (by the local registry or by
 * GoDaddy's RA via scripts/register-ans.ts) sit next to them as
 * server/keys/<agent-name>.pem. Both patterns are gitignored.
 *
 * Signature wire format: base64url of the raw 64-byte r||s (IEEE P1363), the
 * same encoding JWS ES256 uses. A verifier that only has a certificate can
 * check it with verifyWithPublicKey().
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const KEYS_DIR = path.resolve(here, "../../keys");

const EC_ALG = { namedCurve: "prime256v1" } as const; // P-256

const safeName = (agentName: string) => agentName.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
export const keyPathFor = (agentName: string) => path.join(KEYS_DIR, `${safeName(agentName)}.key`);
export const certPathFor = (agentName: string) => path.join(KEYS_DIR, `${safeName(agentName)}.pem`);

const keyCache = new Map<string, KeyObject>();

/** Load the agent's private key, generating a fresh P-256 key on first use. */
export function privateKeyFor(agentName: string): KeyObject {
  const cached = keyCache.get(agentName);
  if (cached) return cached;
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const file = keyPathFor(agentName);
  let key: KeyObject;
  if (fs.existsSync(file)) {
    key = createPrivateKey(fs.readFileSync(file, "utf8"));
  } else {
    const pair = generateKeyPairSync("ec", EC_ALG);
    fs.writeFileSync(file, pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    key = pair.privateKey;
    console.log(`[sign] generated P-256 key for ${agentName} -> ${path.relative(process.cwd(), file)}`);
  }
  keyCache.set(agentName, key);
  return key;
}

/** SPKI PEM of the agent's public key (what goes in its CSR / agent card). */
export function publicKeyPemFor(agentName: string): string {
  return createPublicKey(privateKeyFor(agentName)).export({ type: "spki", format: "pem" }) as string;
}

/** SPKI DER of the agent's public key, for building CSRs / certificates. */
export function publicKeyDerFor(agentName: string): Buffer {
  return createPublicKey(privateKeyFor(agentName)).export({ type: "spki", format: "der" }) as Buffer;
}

/** PKCS#8 DER of the private key, for WebCrypto importKey("pkcs8", ...). */
export function privateKeyDerFor(agentName: string): Buffer {
  return privateKeyFor(agentName).export({ type: "pkcs8", format: "der" }) as Buffer;
}

/** The certificate issued for this agent, if one has been saved (server/keys/<name>.pem). */
export function certificatePemFor(agentName: string): string | undefined {
  const file = certPathFor(agentName);
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalReach(req: ReachRequest): string {
  const { id, from, to, claimedDisplayName, kind, payload, ts } = req;
  return JSON.stringify({ id, from, to, claimedDisplayName, kind, payload, ts });
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** ES256 detached signature over `message`, base64url(r||s). */
export function signAs(agentName: string, message: string): string {
  const sig = cryptoSign("sha256", Buffer.from(message, "utf8"), {
    key: privateKeyFor(agentName),
    dsaEncoding: "ieee-p1363",
  });
  return sig.toString("base64url");
}

/** Verify with the key this server holds for `agentName` (used for our own agents' receipts). */
export function verifySignature(agentName: string, message: string, signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    return verifyWithPublicKey(publicKeyPemFor(agentName), message, signature);
  } catch {
    return false;
  }
}

/** Verify against an arbitrary SPKI public key PEM (e.g. the key inside an ANS identity certificate). */
export function verifyWithPublicKey(publicKeyPem: string, message: string, signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const sig = Buffer.from(signature, "base64url");
    if (sig.length !== 64) return false; // ES256 raw r||s
    return cryptoVerify("sha256", Buffer.from(message, "utf8"), { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}
