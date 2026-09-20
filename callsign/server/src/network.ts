import type { NetworkReach, NetworkState, ReachRequest } from "@callsign/shared";
import { emit, id, nowIso } from "./events.ts";
import { audit } from "./store.ts";
import { doctor, otherDoctors } from "./seed/data.ts";
import { handleReach } from "./agent.ts";

/**
 * NETWORK FAN-OUT
 *
 * One brand update reaches every physician on Callsign at once. Dr. Patel's
 * agent is the live one (full verification, real ring). The other three are
 * simulated with their own policies so the console can show the shape of
 * the network: who got called, who was held, and why. This is the
 * "Impiricus has a million of these" slide, animated.
 */

const state: NetworkState = { reaches: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function networkState(): NetworkState {
  return { ...state, reaches: state.reaches.map((r) => ({ ...r })) };
}

function push() {
  emit({ type: "network.update", network: networkState() });
}

/** Simulated policies for the seeded colleagues. */
const simulated: Record<string, { acceptCalls: boolean; note?: string }> = {
  "reed.callsign-hcp.com": { acceptCalls: true },
  "sousa.callsign-hcp.com": { acceptCalls: false, note: "in clinic until 3:00 PM" },
  "liu.callsign-hcp.com": { acceptCalls: true },
};

export async function broadcast(req: ReachRequest): Promise<NetworkState> {
  state.broadcastId = id("bc");
  state.startedAt = nowIso();
  state.reaches = [doctor, ...otherDoctors].map((d) => ({
    agentName: d.agentName,
    doctor: d.name,
    specialty: d.specialty,
    status: "pending" as const,
  }));
  push();
  audit("reach", `Broadcast from ${req.from} to ${state.reaches.length} physicians`, state.broadcastId);

  // The live one runs the real pipeline; its row follows the real outcome.
  const live = state.reaches[0];
  live.status = "verifying";
  push();
  const livePromise = handleReach(req).then((result) => {
    live.ms = result.steps.reduce((n, s) => n + (s.ms ?? 0), 0);
    if (result.verdict !== "verified") {
      live.status = "quarantined";
      live.reason = result.steps.find((s) => s.status === "fail")?.detail;
    } else if (result.outcome === "call") {
      live.status = "called";
      live.reason = "called";
    } else {
      live.status = "inbox";
      live.reason = result.steps.find((s) => s.id === "policy")?.detail ?? "held";
    }
    push();
  });

  // The simulated ones stagger in behind it.
  for (const r of state.reaches.slice(1)) {
    await sleep(350 + Math.random() * 400);
    r.status = "verifying";
    push();
  }
  for (const r of state.reaches.slice(1)) {
    await sleep(900 + Math.random() * 900);
    const pol = simulated[r.agentName] ?? { acceptCalls: true };
    const relevant = !req.payload.specialty || req.payload.specialty === r.specialty;
    r.ms = 2200 + Math.round(Math.random() * 900);
    if (!pol.acceptCalls) {
      r.status = "inbox";
      r.reason = pol.note ?? "not taking calls";
    } else if (!relevant) {
      r.status = "inbox";
      r.reason = `not relevant to ${r.specialty}`;
    } else {
      r.status = "called";
      r.reason = "called";
    }
    push();
  }
  await livePromise;
  return networkState();
}

export function resetNetwork() {
  state.broadcastId = undefined;
  state.startedAt = undefined;
  state.reaches = [];
  push();
}

export function seedReach(): NetworkReach[] {
  return [doctor, ...otherDoctors].map((d) => ({ agentName: d.agentName, doctor: d.name, specialty: d.specialty, status: "pending" }));
}
