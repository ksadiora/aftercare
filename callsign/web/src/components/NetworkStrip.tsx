import type { NetworkReach, NetworkState, ReachStatus } from "@callsign/shared";
import { Pill } from "./ui.tsx";

const STATUS: Record<ReachStatus, { word: string; tone?: "green" | "red" | "amber" | "blue"; dot?: boolean }> = {
  pending: { word: "Pending" },
  verifying: { word: "Verifying", tone: "blue", dot: true },
  called: { word: "Called", tone: "green" },
  inbox: { word: "Held", tone: "amber" },
  quarantined: { word: "Quarantined", tone: "red" },
};

/**
 * The fourth surface: one brand update reaching every physician on Callsign
 * at once. Dr. Patel's tile is live (her real pipeline runs, the trust card
 * animates alongside); her colleagues are simulated with their own policy.
 * Appears only while a broadcast has run; reset clears it.
 */
export function NetworkStrip({ network, liveAgent }: { network: NetworkState; liveAgent: string }) {
  const reaches = network.reaches;
  if (reaches.length === 0) return null;
  const count = (s: ReachStatus) => reaches.filter((r) => r.status === s).length;
  const busy = count("pending") + count("verifying") > 0;
  const meta = busy
    ? `Reaching ${reaches.length} physicians…`
    : [
        `${reaches.length} physicians`,
        count("called") && `${count("called")} called`,
        count("inbox") && `${count("inbox")} held`,
        count("quarantined") && `${count("quarantined")} quarantined`,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <section className="card network" aria-label="Network">
      <div className="card-head">
        <span className="card-title">Network</span>
        <span className="card-meta">{meta}</span>
      </div>
      <div className="tiles">
        {reaches.map((r) => (
          <Tile key={r.agentName} reach={r} live={r.agentName === liveAgent} />
        ))}
      </div>
    </section>
  );
}

function Tile({ reach, live }: { reach: NetworkReach; live: boolean }) {
  const st = STATUS[reach.status] ?? STATUS.pending;
  const reason = reach.reason && reach.reason !== "called" ? reach.reason : reach.status === "called" ? "phone rang" : "";
  const secs = reach.ms != null ? `${(reach.ms / 1000).toFixed(1)} s` : "";
  return (
    <div className={`tile ${reach.status} ${live ? "live" : ""}`}>
      <span className={`avatar ${reach.status}`} aria-hidden>
        {initials(reach.doctor)}
      </span>
      <div className="tile-text">
        <div className="tile-name">
          <span className="tile-doctor">{reach.doctor}</span>
          <span className="tile-spec">{reach.specialty}</span>
          {live && (
            <span className="live-tag" title="Dr. Patel's real agent; the others are simulated">
              <span className="dot" aria-hidden /> live
            </span>
          )}
        </div>
        <div className="tile-status">
          {/* keyed on status so a change re-runs the pop animation */}
          <Pill key={reach.status} tone={st.tone} dot={st.dot}>
            {st.word}
          </Pill>
          {(reason || secs) && (
            <span className="tile-reason" title={reason}>
              {reason}
              {reason && secs ? " · " : ""}
              {secs}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Dr. Priya Patel" → "PP"; "Dr. Wen Liu" → "WL". */
function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => !/^(dr|prof|mr|ms|mrs)\.?$/i.test(p));
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}
