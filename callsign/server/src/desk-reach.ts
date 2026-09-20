import { randomUUID } from "node:crypto";
import type { ReachRequest } from "@callsign/shared";
import type { DeskRegistry } from "@callsign/shared/src/desk.ts";
import { config } from "./config.ts";
import { ansMode, TL_BASE } from "./verify/ans.ts";
import { agentByHost, ensureLocalRegistry } from "./verify/local-registry.ts";
import { canonicalReach, certificatePemFor, signAs } from "./verify/sign.ts";

export function deskRegistry(): DeskRegistry {
  const mode = ansMode();
  return {
    mode,
    sender: config.brandAgentName,
    label: mode === "local" ? "Local demo registry" : mode === "real" ? "Public ANS" : "Mock registry checks",
    description: mode === "local"
      ? "This server’s ANS-shaped registry, local CA and transparency log. No GoDaddy public ANS registration is claimed."
      : mode === "real"
        ? "Public DNS and the configured public transparency log are checked. Public failures never fall back to the local demo registry."
        : "Simulated registry, certificate and log checks. GoDaddy’s public ANS is not queried. Signature and replay checks still run.",
    logUrl: mode === "local" ? `${config.publicBaseUrl.replace(/\/$/, "")}/ans` : TL_BASE,
  };
}

/** The browser demo signs with this server's configured sender key, never a
 * caller-supplied name/key. This authenticates the demo agent, not the human. */
export async function buildDeskReach(callerName: string, text: string): Promise<ReachRequest> {
  if (ansMode() === "local") await ensureLocalRegistry();
  const request: ReachRequest = {
    id: randomUUID(), from: config.brandAgentName, to: config.hcpAgentName,
    claimedDisplayName: callerName, kind: "general", payload: { summary: text },
    ts: new Date().toISOString(),
    certificatePem: ansMode() === "local" ? agentByHost(config.brandAgentName)?.certPem : certificatePemFor(config.brandAgentName),
  };
  request.signature = signAs(request.from, canonicalReach(request));
  return request;
}
