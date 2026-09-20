import type { Negotiation as NegotiationT, NegotiationEvent } from "@callsign/shared";
import { IconCheck, IconHandshake, Pill, fmtTime, usePinToBottom } from "./ui.tsx";

const ACTOR_LABEL: Record<NegotiationEvent["actor"], string> = {
  hcp: "Dr. Patel's agent",
  brand: "Brand agent",
  system: "System",
};

const PHASE_LABEL: Record<NegotiationEvent["phase"], string> = {
  verify_peer: "Verify peer",
  check_license: "License",
  check_eligibility: "Eligibility",
  propose: "Proposal",
  agree: "Agreement",
  sign: "Signing",
  done: "Done",
  failed: "Failed",
};

const KIND_LABEL: Record<NegotiationT["kind"], string> = {
  samples: "Samples",
  followup: "Follow-up",
  rep_visit: "Rep visit",
};

const short = (s: string, n = 16) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Agent-to-agent negotiation, rendered inside the live call card. */
export function Negotiation({ negotiation, brandName }: { negotiation: NegotiationT; brandName: string }) {
  const n = negotiation;
  const eventsRef = usePinToBottom<HTMLDivElement>([n.id, n.events.length, n.receipt]);

  const tone = n.status === "agreed" ? "green" : n.status === "failed" ? "red" : "amber";
  const word = n.status === "agreed" ? "Signed" : n.status === "failed" ? "Failed" : "Negotiating";

  return (
    <section className="nego" aria-label="Agent-to-agent negotiation">
      <div className="nego-head">
        <span className="card-title">
          <IconHandshake /> Agent to agent · {KIND_LABEL[n.kind]}
        </span>
        <Pill tone={tone} dot>
          {word}
        </Pill>
      </div>

      {n.receipt && (
        <dl className="receipt">
          <div className="receipt-title">
            <IconCheck /> Signed receipt
          </div>
          <dt>Terms</dt>
          <dd>
            {short(n.receipt.hash)} <span className="dim">sha256</span>
          </dd>
          <dt>HCP</dt>
          <dd>{short(n.receipt.hcpSignature, 24)}</dd>
          <dt>Brand</dt>
          <dd>{short(n.receipt.brandSignature, 24)}</dd>
          <dt>Signed</dt>
          <dd>{fmtTime(n.receipt.signedAt)}</dd>
        </dl>
      )}

      <div className="nego-request">
        Doctor asked: <b>“{n.requestText}”</b>
      </div>
      <div className="events" ref={eventsRef}>
        {n.events.map((e, i) => (
          <div key={i} className={`event ${e.actor} ${e.phase}`}>
            <span className="event-actor">
              <span className="who">{e.actor === "brand" ? `${brandName} agent` : ACTOR_LABEL[e.actor]}</span>
              <span className="phase">{PHASE_LABEL[e.phase]}</span>
            </span>
            <span className="event-text">
              {e.text}
              {e.signature && <span className="event-sig">sig {short(e.signature, 20)}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
