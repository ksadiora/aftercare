import { useEffect, useState } from "react";

export function DeskReceiverPolicy({ onChange }: { onChange: () => Promise<void> }) {
  const [acceptCalls, setAcceptCalls] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/policy", { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Policy unavailable");
      const policy = await response.json() as { acceptCalls: boolean };
      setAcceptCalls(policy.acceptCalls);
    }).catch(() => { if (!controller.signal.aborted) setError("Could not load doctor policy."); });
    return () => controller.abort();
  }, []);
  const toggle = async () => {
    if (busy || acceptCalls === null) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acceptCalls: !acceptCalls }) });
      if (!response.ok) throw new Error("Policy update failed");
      const policy = await response.json() as { acceptCalls: boolean };
      setAcceptCalls(policy.acceptCalls);
      await onChange();
    } catch { setError("Could not refresh policy. Please try again."); }
    finally { setBusy(false); }
  };
  return <div className="desk-receiver-policy"><button className="desk-text-button" role="switch" aria-checked={acceptCalls === true} disabled={busy || acceptCalls === null} onClick={() => void toggle()} aria-label="Accept calls">{acceptCalls === null ? "Loading policy…" : acceptCalls ? "Accept calls · On" : "Accept calls · Off"}</button>{acceptCalls === false && <p>New calls are held in the inbox. Your phone stays silent.</p>}{error && <p role="alert">{error}</p>}</div>;
}
