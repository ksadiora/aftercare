import { useEffect, useState } from "react";
import { IMPOSTOR_VARIANTS, type ImpostorVariant, type StepId } from "@callsign/shared";
import { useCallsign } from "../useCallsign.ts";
import { Workbench } from "../components/Workbench.tsx";
import { AttackPicker } from "../components/DemoPanel.tsx";
import { TrustCard } from "../components/TrustCard.tsx";
import { ProofDrawer } from "../components/ProofDrawer.tsx";
import { PhoneCard } from "../components/PhoneCard.tsx";
import { LiveCall } from "../components/LiveCall.tsx";
import { DemoCredentials, Qr } from "../components/ui.tsx";
import { proofUrl } from "../components/proof.ts";
import "./identity.css";

export function IdentityWorkspace() {
  const { connected, snapshot, activeVerification, activeCall, activeNegotiation, actions, phone } = useCallsign();
  const [variant, setVariant] = useState<ImpostorVariant>("no-record");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [docked, setDocked] = useState(false);
  const [proof, setProof] = useState<{ requestId: string; step: StepId }>();
  const selected = IMPOSTOR_VARIANTS.find((item) => item.id === variant)!;
  const checking = snapshot?.verifications.some((item) => !item.verdict) ?? false;
  const disabled = busy || checking || !connected;
  const url = activeVerification ? proofUrl(activeVerification.requestId, snapshot?.phone.urls) : "";
  const proofVerification = snapshot?.verifications.find((item) => item.requestId === proof?.requestId);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setProof(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  const runAttack = async () => {
    if (disabled) return;
    setBusy(true);
    setError("");
    try { await actions.impostor(variant); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not send the attack. Try again."); }
    finally { setBusy(false); }
  };

  return (
    <div className="identity-workspace">
      <div className="identity-heading">
        <div><h2>Prove it before the phone rings.</h2><p>Choose an identity, predict the outcome, then inspect what each check actually examined.</p></div>
        <span role="status">{connected ? "Verifier online" : "Connecting to verifier…"}</span>
      </div>
      <DemoCredentials />
      <section className="identity-presets" aria-labelledby="attack-heading">
        <div className="identity-section-heading"><h3 id="attack-heading">Five attack presets</h3><a className="link" href="/try">Full scenario deck →</a></div>
        <AttackPicker value={variant} onChange={setVariant} disabled={disabled} tabbable />
        <div className="identity-preset-actions">
          <p aria-live="polite">Prediction: {selected.failsAt === "none" ? "demo credentials pass; the specialty policy holds the call in the inbox." : `fails at ${selected.failsAt}; the phone stays silent.`}</p>
          <button className="btn primary" disabled={disabled} onClick={() => void runAttack()}>{busy || checking ? "Checking…" : "Run attack"}</button>
        </div>
        {error && <p className="wb-error" role="alert">{error}</p>}
      </section>
      <div className="identity-grid">
        <section className="card identity-compose" aria-labelledby="identity-compose-heading">
          <div className="card-head"><h3 className="card-title" id="identity-compose-heading">Build your own request</h3></div>
          <Workbench snapshot={connected ? snapshot : undefined} compact />
        </section>
        <div className="identity-evidence">
          <TrustCard verification={activeVerification} call={snapshot?.calls.find((item) => item.requestId === activeVerification?.requestId)} doctorName={snapshot?.doctor.name ?? "Dr. Patel"} onProof={(step) => { if (activeVerification) setProof({ requestId: activeVerification.requestId, step }); }} />
          {activeVerification && <section className="card identity-share" aria-label="Share verification proof"><Qr value={url} size={132} /><div><h3>Take the evidence with you.</h3><a className="link" href={url} target="_blank" rel="noreferrer">Open proof page →</a><p>Scan on your phone. For a local address, connect to the same Wi-Fi.</p><a className="identity-url" href={url} target="_blank" rel="noreferrer">{url}</a></div></section>}
          <section className="card" aria-label="Phone pairing"><div className="card-head"><h3 className="card-title">Dr. Patel’s demo phone</h3></div><PhoneCard phone={snapshot?.phone ?? { paired: false, urls: [], voice: "browser" }} inSheet onDock={() => setDocked(true)} docked={docked} /></section>
        </div>
      </div>
      <LiveCall call={activeCall} negotiation={activeNegotiation} brandName={snapshot?.brand.displayName ?? "Demo brand"} phone={snapshot?.phone} docked={docked} onDock={() => setDocked(true)} onUndock={() => setDocked(false)} onTurn={phone.turn} />
      <ProofDrawer open={Boolean(proof)} verification={proofVerification} stepId={proof?.step} onStep={(step) => setProof((current) => current ? { ...current, step } : current)} onClose={() => setProof(undefined)} phoneUrls={snapshot?.phone.urls} />
    </div>
  );
}
