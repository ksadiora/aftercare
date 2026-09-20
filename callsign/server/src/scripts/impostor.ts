/**
 * Sends an impostor ReachRequest to the doctor's agent from outside the
 * process, the way a real attacker would. Usage:
 *   npm run impostor                     (no-record, targets http://localhost:8787)
 *   npm run impostor -- forged-cert      (any ImpostorVariant)
 *   TARGET=https://patel.callsign-hcp.com npm run impostor
 */
import { buildImpostorReach } from "../agents/brand.ts";

const target = process.env.TARGET ?? `http://localhost:${process.env.PORT ?? 8787}`;
const variant = (process.argv[2] as import("@callsign/shared").ImpostorVariant | undefined) ?? "no-record";
const req = buildImpostorReach(variant);
const res = await fetch(`${target}/reach`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(req),
});
console.log(res.status, await res.text());
