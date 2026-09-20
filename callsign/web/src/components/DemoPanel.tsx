import { useCallback, useEffect, useState } from "react";
import { IMPOSTOR_VARIANTS, type DoctorPolicy, type ImpostorVariant, type PolicyUpdateBody, type Snapshot } from "@callsign/shared";
import { PhoneCard } from "./PhoneCard.tsx";
import { Workbench } from "./Workbench.tsx";
import { Sheet } from "./ui.tsx";
import { elapsedSeconds } from "./proof.ts";
import type { AutopilotState } from "./useAutopilot.ts";

type Actions = {
  impostor: (variant?: ImpostorVariant) => Promise<unknown>;
  brandCall: () => Promise<unknown>;
  broadcast: () => Promise<unknown>;
  reset: () => Promise<unknown>;
  setPolicy: (patch: PolicyUpdateBody) => Promise<unknown>;
};

const DEFAULT_POLICY: DoctorPolicy = { acceptCalls: true, specialtyOnly: true, requireReceipt: true };

/**
 * Presenter sheet. Slides in from the right on the backtick key or the
 * "Present" link in the nav. Shortcuts arm only after the sheet has been
 * opened once, so a stray keypress during the pitch cannot fire a scenario,
 * and never fire while typing in a field.
 *
 *   1  run the selected attack     2  brand calls     3  reach the network
 *   A  autopilot                   0  reset           Esc  close / cancel
 */
export function DemoPanel({
  open,
  onOpenChange,
  snapshot,
  actions,
  onUnpair,
  onDock,
  auditOpen,
  onAudit,
  proofOpen,
  onCloseProof,
  variant,
  onVariant,
  autopilot,
  soundsOn,
  onSounds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: Snapshot;
  actions: Actions;
  onUnpair: () => Promise<unknown>;
  /** Dock the phone in the live call card; undefined while it already is. */
  onDock?: () => void;
  auditOpen: boolean;
  onAudit: (open: boolean) => void;
  proofOpen: boolean;
  onCloseProof: () => void;
  variant: ImpostorVariant;
  onVariant: (v: ImpostorVariant) => void;
  autopilot: { state: AutopilotState; running: boolean; start: () => void; cancel: () => void };
  soundsOn: boolean;
  onSounds: (on: boolean) => void;
}) {
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastAttack, setLastAttack] = useState<{ requestId?: string; variant: ImpostorVariant } | null>(null);

  useEffect(() => {
    if (open) setArmed(true);
  }, [open]);

  // A reset (from anywhere) empties the verifications; forget the last attack with them.
  useEffect(() => {
    if (snapshot.verifications.length === 0) setLastAttack(null);
  }, [snapshot.verifications.length]);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      if (busy) return undefined;
      setBusy(true);
      setStatus({ kind: "info", text: `${label}…` });
      try {
        const r = await fn();
        setStatus({ kind: "ok", text: label });
        return r;
      } catch (e) {
        setStatus({ kind: "err", text: e instanceof Error ? e.message : String(e) });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const fire = useCallback(
    (which: "attack" | "brand" | "broadcast" | "reset" | "autopilot") => {
      if (autopilot.running) return;
      if (which === "attack") {
        const v = IMPOSTOR_VARIANTS.find((x) => x.id === variant);
        setLastAttack({ variant });
        void run(`${v?.label ?? "Attack"} sent`, () => actions.impostor(variant)).then((r) => {
          const id = r && typeof r === "object" && typeof (r as { requestId?: unknown }).requestId === "string" ? (r as { requestId: string }).requestId : undefined;
          setLastAttack({ variant, requestId: id });
        });
      }
      if (which === "brand") void run("Brand request sent", actions.brandCall);
      if (which === "broadcast") void run("Reaching the network", actions.broadcast);
      if (which === "reset") {
        setLastAttack(null);
        void run("Reset", actions.reset);
      }
      if (which === "autopilot") {
        // Hands-free: the sheet slides away and the toast carries the progress.
        autopilot.start();
        onOpenChange(false);
      }
    },
    [actions, run, variant, autopilot, onOpenChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
      if (typing) return;
      if (e.key === "`") {
        e.preventDefault();
        if (auditOpen) onAudit(false);
        if (proofOpen) onCloseProof();
        onOpenChange(!open);
        return;
      }
      if (e.key === "Escape") {
        if (autopilot.running) autopilot.cancel();
        else if (proofOpen) onCloseProof();
        else if (auditOpen) onAudit(false);
        else if (open) onOpenChange(false);
        return;
      }
      if (!armed || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "1") fire("attack");
      else if (e.key === "2") fire("brand");
      else if (e.key === "3") fire("broadcast");
      else if (e.key === "0") fire("reset");
      else if (e.key === "a" || e.key === "A") fire("autopilot");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed, open, auditOpen, proofOpen, fire, onOpenChange, onAudit, onCloseProof, autopilot]);

  const toggleAudit = () => {
    const next = !auditOpen;
    onAudit(next);
    if (next) onOpenChange(false);
  };

  const policy = snapshot.policy ?? DEFAULT_POLICY;
  const setPolicy = (patch: PolicyUpdateBody) => {
    actions.setPolicy(patch).catch((e: unknown) => setStatus({ kind: "err", text: e instanceof Error ? e.message : String(e) }));
  };

  const disabled = busy || autopilot.running;
  const ap = autopilot.state;
  const line = ap.status !== "idle" ? `Autopilot: ${ap.phase}${ap.status === "running" ? " · Esc cancels" : ""}` : (status?.text ?? "Ready.");
  const lineKind = ap.status === "error" ? "err" : ap.status !== "idle" ? "info" : (status?.kind ?? "");

  return (
    <Sheet open={open} title="Present" label="Presenter panel" onClose={() => onOpenChange(false)}>
      <section className="group">
        <h3>Phone</h3>
        <PhoneCard phone={snapshot.phone} inSheet onUnpair={() => void run("Phone unpaired", onUnpair)} onDock={onDock} docked={!onDock} />
      </section>

      <section className="group">
        <h3>Try to fool it</h3>
        <Workbench snapshot={snapshot} compact tabbable={open} />
        <p className="sheet-hint">
          Compose your own request and watch the five checks handle it. The full workbench is at{" "}
          <a className="link" href="/try" tabIndex={open ? 0 : -1}>
            /try
          </a>
          .
        </p>
      </section>

      <section className="group">
        <h3>Run</h3>
        <AttackPicker value={variant} onChange={onVariant} disabled={disabled} tabbable={open} />
        <div className="stack">
          <button type="button" className="btn gray full" disabled={disabled} onClick={() => fire("attack")}>
            Run attack <kbd>1</kbd>
          </button>
          <AttackOutcome last={lastAttack} snapshot={snapshot} />
          <button type="button" className="btn primary full" disabled={disabled} onClick={() => fire("brand")}>
            Brand calls <kbd>2</kbd>
          </button>
          <button type="button" className="btn primary full" disabled={disabled} onClick={() => fire("broadcast")}>
            Reach the network <kbd>3</kbd>
          </button>
          <div className="pair">
            {autopilot.running ? (
              <button type="button" className="btn gray full" onClick={autopilot.cancel}>
                Cancel <kbd>Esc</kbd>
              </button>
            ) : (
              <button type="button" className="btn gray full" disabled={disabled} onClick={() => fire("autopilot")}>
                Autopilot <kbd>A</kbd>
              </button>
            )}
            <button type="button" className="btn text full" disabled={disabled} onClick={() => fire("reset")}>
              Reset <kbd>0</kbd>
            </button>
          </div>
        </div>
        <div className={`sheet-status ${lineKind}`} aria-live="polite">
          {line}
        </div>
      </section>

      <section className="group">
        <h3>Dr. Patel</h3>
        <div className="toggle-row">
          <span className="toggle-text">
            <span>Accepting calls</span>
            {!policy.acceptCalls && <span className="toggle-sub amber">{policy.note ?? "In clinic"}</span>}
          </span>
          <button
            type="button"
            className={`switch ${policy.acceptCalls ? "on" : ""}`}
            role="switch"
            aria-checked={policy.acceptCalls}
            aria-label="Accepting calls"
            onClick={() => setPolicy({ acceptCalls: !policy.acceptCalls })}
            tabIndex={open ? 0 : -1}
          />
        </div>
        <div className="toggle-row">
          <span className="toggle-text">
            <span>Specialty only</span>
            <span className="toggle-sub">{policy.specialtyOnly ? `${snapshot.doctor.specialty} only` : "Any specialty may call"}</span>
          </span>
          <button
            type="button"
            className={`switch ${policy.specialtyOnly ? "on" : ""}`}
            role="switch"
            aria-checked={policy.specialtyOnly}
            aria-label="Specialty only"
            onClick={() => setPolicy({ specialtyOnly: !policy.specialtyOnly })}
            tabIndex={open ? 0 : -1}
          />
        </div>
        <div className="toggle-row readonly">
          <span className="toggle-text">
            <span>Receipt required</span>
            <span className="toggle-sub">Only senders sealed in the transparency log may call</span>
          </span>
          <span className="toggle-value">{policy.requireReceipt ? "on" : "off"}</span>
        </div>
      </section>

      <section className="group">
        <h3>More</h3>
        <div className="toggle-row">
          <span className="toggle-text">
            <span>Be the caller</span>
            <span className="toggle-sub">Call Dr. Patel yourself; get rejected, or talk to her</span>
          </span>
          <a className="link" href="/call" tabIndex={open ? 0 : -1}>
            /call
          </a>
        </div>
        <div className="toggle-row">
          <span className="toggle-text">
            <span>Try to fool it</span>
            <span className="toggle-sub">Compose a request and predict what the checks do</span>
          </span>
          <a className="link" href="/try" tabIndex={open ? 0 : -1}>
            /try
          </a>
        </div>
        <div className="toggle-row">
          <span>Show audit log</span>
          <button type="button" className={`switch ${auditOpen ? "on" : ""}`} role="switch" aria-checked={auditOpen} aria-label="Show audit log" onClick={toggleAudit} tabIndex={open ? 0 : -1} />
        </div>
        <div className="toggle-row">
          <span className="toggle-text">
            <span>Sounds</span>
            <span className="toggle-sub">A chime on verified, a thud on quarantined</span>
          </span>
          <button type="button" className={`switch ${soundsOn ? "on" : ""}`} role="switch" aria-checked={soundsOn} aria-label="Sounds" onClick={() => onSounds(!soundsOn)} tabIndex={open ? 0 : -1} />
        </div>
        <p className="sheet-hint">
          Press ` to toggle this sheet. Once it has been opened: 1 runs the selected attack, 2 brand calls, 3 reaches the network, A runs autopilot
          (reset → attack → brand calls, hands-free), 0 resets. Esc closes a sheet, or cancels autopilot while it runs.
        </p>
      </section>
    </Sheet>
  );
}

/** The five ways an attacker tries; each fails at a different step. */
export function AttackPicker({ value, onChange, disabled, tabbable }: { value: ImpostorVariant; onChange: (v: ImpostorVariant) => void; disabled: boolean; tabbable: boolean }) {
  return (
    <div className="attack-picker" role="radiogroup" aria-label="Attack">
      {IMPOSTOR_VARIANTS.map((v) => {
        const tag = v.failsAt === "none" ? "held by policy" : `fails at ${v.failsAt}`;
        const selected = v.id === value;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`attack ${selected ? "selected" : ""} ${v.failsAt === "none" ? "held" : ""}`}
            disabled={disabled}
            onClick={() => onChange(v.id)}
            tabIndex={tabbable ? 0 : -1}
          >
            <span className="attack-top">
              <span className="attack-label">{v.label}</span>
              <span className="attack-tag">{tag}</span>
            </span>
            <span className="attack-blurb">{v.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

/** "Quarantined at certificate · 1.2 s" for the last attack fired from this sheet. */
function AttackOutcome({ last, snapshot }: { last: { requestId?: string; variant: ImpostorVariant } | null; snapshot: Snapshot }) {
  if (!last) return null;
  const v = last.requestId ? snapshot.verifications.find((x) => x.requestId === last.requestId) : undefined;
  let text: string;
  let tone = "";
  if (!v) text = "Sending…";
  else if (!v.verdict) text = "Verifying…";
  else if (v.verdict === "quarantined") {
    const failing = v.steps.find((s) => s.status === "fail");
    text = `Quarantined at ${failing?.id ?? "verification"} · ${elapsedSeconds(v)}`;
    tone = "red";
  } else if (v.outcome === "inbox") {
    text = `Verified · held by policy · ${elapsedSeconds(v)}`;
    tone = "amber";
  } else {
    text = `Verified · calling · ${elapsedSeconds(v)}`;
    tone = "green";
  }
  return (
    <div className={`attack-outcome ${tone}`} aria-live="polite">
      {text}
    </div>
  );
}
