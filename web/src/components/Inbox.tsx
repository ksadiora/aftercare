import { useState } from "react";
import type { InboxItem, ReachKind } from "@callsign/shared";
import { Empty, IconCheck, IconCross, IconInbox, Pill, fmtTime } from "./ui.tsx";

const KIND_LABEL: Record<ReachKind, string> = {
  label_update: "Label update",
  sample_offer: "Sample offer",
  general: "General",
};

const OUTCOME_LABEL: Record<InboxItem["outcome"], string> = {
  call: "Called",
  inbox: "Inbox",
  quarantine: "Not delivered",
};

export function Inbox({ items }: { items: InboxItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const quarantined = items.filter((i) => i.verdict === "quarantined").length;

  return (
    <section className="card inbox" aria-label="Inbox">
      <div className="card-head">
        <span className="card-title">Inbox</span>
        <span className="card-meta">
          {items.length} {items.length === 1 ? "item" : "items"}
          {quarantined > 0 && ` · ${quarantined} quarantined`}
        </span>
      </div>
      {items.length === 0 ? (
        <Empty title="Nothing here yet." sub="Verified agents land here. Impostors are held, never delivered." glyph={<IconInbox />} />
      ) : (
        <div className="card-body">
          {items.map((item) => (
            <Row key={item.id} item={item} open={open === item.id} onToggle={() => setOpen(open === item.id ? null : item.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function Row({ item, open, onToggle }: { item: InboxItem; open: boolean; onToggle: () => void }) {
  const ok = item.verdict === "verified";
  // Verified identity, but the doctor's policy kept the phone silent.
  const held = ok && item.outcome === "inbox";
  return (
    <button type="button" className={`row ${item.verdict} ${held ? "held" : ""}`} onClick={onToggle} aria-expanded={open}>
      <div className="row-top">
        <span className="row-name">{item.displayName}</span>
        <span className="row-from">{item.from}</span>
        <span className="row-time">{fmtTime(item.ts)}</span>
      </div>
      <div className="row-summary">{item.summary}</div>
      {!ok && <div className="row-reason">{item.reason ?? "Verification failed"}</div>}
      {held && item.reason && <div className="row-reason held">{item.reason}</div>}
      <div className="row-meta">
        <Pill>{KIND_LABEL[item.kind]}</Pill>
        {ok ? (
          <Pill tone="green">
            <IconCheck /> Verified via ANS
          </Pill>
        ) : (
          <Pill tone="red">
            <IconCross /> Quarantined
          </Pill>
        )}
        {held ? <Pill tone="amber">Held</Pill> : <Pill>{OUTCOME_LABEL[item.outcome]}</Pill>}
      </div>
      {open && <div className="row-detail">{item.detail ?? "No further detail was included with this message."}</div>}
    </button>
  );
}
