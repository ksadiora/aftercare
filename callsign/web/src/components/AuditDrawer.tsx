import type { AuditEntry } from "@callsign/shared";
import { Sheet, fmtTime } from "./ui.tsx";

const TYPE_LABEL: Record<AuditEntry["type"], string> = {
  reach: "Reach",
  verification: "Verify",
  call: "Call",
  tool: "Tool",
  negotiation: "Negotiate",
  demo: "Demo",
};

/** Audit log as a wide sheet from the right. */
export function AuditDrawer({ open, entries, onClose }: { open: boolean; entries: AuditEntry[]; onClose: () => void }) {
  return (
    <Sheet open={open} wide title="Audit log" label="Audit log" meta={`${entries.length} entries`} onClose={onClose}>
      <div className="audit-list">
        {entries.length === 0 && <div className="audit-empty">Nothing logged yet.</div>}
        {entries.map((a) => (
          <div key={a.id} className={`audit-entry t-${a.type}`}>
            <span className="ts">{fmtTime(a.ts)}</span>
            <span className="type">{TYPE_LABEL[a.type]}</span>
            <span className="summary">{a.summary}</span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
