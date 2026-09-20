import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import type { CallState, StepId, TranscriptLine, VerificationResult } from "@callsign/shared";
import { useCallsign } from "../useCallsign.ts";
import { Header } from "./Header.tsx";
import { FALLBACK_OPTIONS, IdentityPicker, Step, fetchOptions, predict, type Options, type Prediction, type WorkbenchForm } from "./Workbench.tsx";
import { IconChevron, IconPhone, usePinToBottom } from "./ui.tsx";
import { STEP_SHORT } from "./proof.ts";
import { canDictate, dictateOnce, playConnected, playHeld, playRejected, speak, startRingback, stopSpeaking, unlockAudio } from "./callAudio.ts";

/**
 * /call — BE THE CALLER
 *
 * A person tries to reach Dr. Patel: they pick who to call as, write an
 * opening line and press Call. The request goes down the same /reach path
 * as every agent's, with `asCaller` so the server relays the call to a
 * human instead of the brand's AI (server/src/call/caller.ts).
 *
 *   stage 1  who are you calling as?     the identity picker + opening line
 *   stage 2  verifying / ringing         her agent's five checks, live; ringback tone
 *            rejected · held             why, and "her phone never rang"
 *   stage 3  connected                   a call screen: bubbles, type or talk, End
 *
 * Talks to:
 *   POST /api/workbench/send   { ...WorkbenchBody, asCaller: true } → { requestId }
 *   GET  /api/caller/status/:requestId                             → { callId, callStatus, endReason }
 *   POST /api/caller/say       { callId, text }
 *   POST /api/caller/hangup    { callId }
 * and reads the checks and the transcript from the live snapshot.
 */

const DOCTOR = "Dr. Priya Patel";
const DOCTOR_SHORT = "Dr. Patel";
const DEFAULT_OPENING = "Hi Dr. Patel, quick one about the renal dosing update, do you have a minute?";

interface Sent {
  requestId: string;
  at: number;
  prediction: Prediction;
}

interface CallerStatus {
  callId?: string;
  callStatus?: CallState["status"];
  endReason?: CallState["endReason"];
}

type Stage =
  | { kind: "form" }
  | { kind: "verifying"; verification?: VerificationResult }
  | { kind: "rejected"; verification: VerificationResult; failing?: VerificationResult["steps"][number] }
  | { kind: "held"; verification: VerificationResult; detail: string }
  | { kind: "ringing"; verification?: VerificationResult; call?: CallState }
  | { kind: "connected"; call: CallState }
  | { kind: "ended"; call: CallState; verification?: VerificationResult };

export function CallPage() {
  const { connected, snapshot } = useCallsign();
  const [opts, setOpts] = useState<Options>(FALLBACK_OPTIONS);
  const [form, setForm] = useState<WorkbenchForm>({
    identity: "brand",
    from: "",
    displayName: "Stelazio",
    summary: DEFAULT_OPENING,
    specialty: "Cardiology",
    attachCert: false,
    tamper: false,
    replay: false,
  });
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [status, setStatus] = useState<CallerStatus>({});

  useEffect(() => {
    document.body.classList.add("scroll");
    const prev = document.title;
    document.title = `Call ${DOCTOR_SHORT} · Callsign`;
    return () => {
      document.body.classList.remove("scroll");
      document.title = prev;
      stopSpeaking();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void fetchOptions().then((o) => {
      if (!alive) return;
      setOpts(o);
      setForm((f) => ({ ...f, displayName: f.displayName || o.brand.displayName, specialty: f.specialty || o.doctorSpecialty }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const replayTarget = useMemo(
    () => snapshot?.verifications.filter((v) => v.verdict === "verified").sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0],
    [snapshot?.verifications],
  );
  useEffect(() => {
    if (!replayTarget && form.replay) setForm((f) => ({ ...f, replay: false }));
  }, [replayTarget, form.replay]);

  const prediction = useMemo(() => callerWords(predict(form, opts, snapshot, replayTarget)), [form, opts, snapshot, replayTarget]);
  const set = <K extends keyof WorkbenchForm>(k: K, v: WorkbenchForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // What this send produced. A replay reuses the original id, so only accept a result that started after Call was pressed.
  const verification = sent ? snapshot?.verifications.find((v) => v.requestId === sent.requestId && new Date(v.startedAt).getTime() >= sent.at - 2000) : undefined;
  const call = sent ? (snapshot?.calls.find((c) => c.id === status.callId) ?? snapshot?.calls.find((c) => c.requestId === sent.requestId)) : undefined;
  const callStatus = call?.status ?? status.callStatus;

  // Poll the caller status: it carries the callId the moment her agent places the call, WebSocket or not.
  useEffect(() => {
    if (!sent) return;
    const terminal = verification?.verdict === "quarantined" || (verification?.verdict === "verified" && verification.outcome === "inbox") || callStatus === "ended" || callStatus === "failed";
    if (terminal) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/caller/status/${encodeURIComponent(sent.requestId)}`);
        if (!r.ok || !alive) return;
        const j = (await r.json()) as CallerStatus;
        if (alive) setStatus({ callId: j.callId, callStatus: j.callStatus, endReason: j.endReason });
      } catch {
        /* the server is away; the WebSocket snapshot still carries the call */
      }
    };
    void tick();
    const iv = window.setInterval(tick, 500);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [sent, verification?.verdict, verification?.outcome, callStatus]);

  const stage: Stage = useMemo(() => {
    if (!sent) return { kind: "form" };
    if (verification?.verdict === "quarantined") return { kind: "rejected", verification, failing: verification.steps.find((s) => s.status === "fail") };
    if (verification?.verdict === "verified" && verification.outcome === "inbox") {
      const policy = verification.steps.find((s) => s.id === "policy");
      return { kind: "held", verification, detail: policy?.detail ?? "Held by her policy" };
    }
    if (call && (call.status === "ended" || call.status === "failed")) return { kind: "ended", call, verification };
    if (call && call.status === "in-progress") return { kind: "connected", call };
    if (verification?.verdict === "verified" || call) return { kind: "ringing", verification, call };
    return { kind: "verifying", verification };
  }, [sent, verification, call]);

  // Ringback while her agent checks and while her phone rings; a verdict tone when it stops.
  const ringback = useRef<(() => void) | null>(null);
  const toned = useRef<string | null>(null);
  useEffect(() => {
    const ringing = stage.kind === "verifying" || stage.kind === "ringing";
    if (ringing && !ringback.current) ringback.current = startRingback();
    if (!ringing && ringback.current) {
      ringback.current();
      ringback.current = null;
    }
    const key = sent ? `${sent.requestId}:${stage.kind}` : null;
    if (key && toned.current !== key) {
      toned.current = key;
      if (stage.kind === "rejected") playRejected();
      else if (stage.kind === "held") playHeld();
      else if (stage.kind === "connected") playConnected();
      else if (stage.kind === "ended" && stage.call.status === "failed") playRejected();
    }
  }, [stage, sent]);
  useEffect(
    () => () => {
      ringback.current?.();
      ringback.current = null;
    },
    [],
  );

  const placeCall = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    unlockAudio();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> =
      form.replay && replayTarget
        ? { identity: form.identity, summary: form.summary, replayOf: replayTarget.requestId, asCaller: true }
        : {
            identity: form.identity,
            from: form.identity === "custom" ? form.from : undefined,
            displayName: form.displayName,
            summary: form.summary,
            specialty: form.specialty,
            attachCert: form.identity === "spoof" ? form.attachCert : undefined,
            tamper: form.tamper || undefined,
            asCaller: true,
          };
    try {
      const r = await fetch("/api/workbench/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { requestId?: string; error?: string };
      if (!r.ok || !j.requestId) throw new Error(j.error ?? r.statusText ?? "could not place the call");
      setStatus({});
      setSent({ requestId: j.requestId, at: Date.now(), prediction });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const hangup = useCallback(async () => {
    const id = call?.id ?? status.callId;
    if (!id) return;
    stopSpeaking();
    try {
      await fetch("/api/caller/hangup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: id }) });
    } catch {
      /* the status poll will catch up */
    }
  }, [call?.id, status.callId]);

  const again = () => {
    stopSpeaking();
    setSent(null);
    setStatus({});
    setError(null);
  };

  const counts = snapshot
    ? {
        verified: snapshot.verifications.filter((v) => v.verdict === "verified").length,
        quarantined: snapshot.verifications.filter((v) => v.verdict === "quarantined").length,
        calls: snapshot.calls.length,
      }
    : undefined;
  const brandName = opts.brand.displayName;
  const callerName = form.displayName.trim() || brandName;

  return (
    <div className="call-page">
      <Header
        phone={snapshot?.phone ?? { paired: false, urls: [], voice: "browser" }}
        connected={connected}
        counts={counts}
        links={[
          { href: "/", label: "Console" },
          { href: "/try", label: "Try to fool it", title: "Compose a request without a call" },
        ]}
      />
      <div className="call-inner">
        {stage.kind === "form" && (
          <>
            <header className="caller-head">
              <h1>Be the caller</h1>
              <p className="proof-lede">
                Pick who to call {DOCTOR} as. Her agent checks you before her phone can ring: a look-alike hears the rejection, the real brand rings
                through.
              </p>
            </header>
            <form className="call-form card-like" onSubmit={placeCall}>
              <div className="call-form-title">Who are you calling as?</div>
              <IdentityPicker form={form} opts={opts} onChange={set} />
              <label className="field">
                <span className="field-label">Display name</span>
                <input className="input" value={form.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder={brandName} />
                <span className="field-hint">What her phone shows while it rings.</span>
              </label>
              <label className="field">
                <span className="field-label">What's your opening line?</span>
                <textarea className="input" rows={2} value={form.summary} onChange={(e) => set("summary", e.target.value)} placeholder={DEFAULT_OPENING} disabled={form.replay} />
                <span className="field-hint">Her phone speaks this the moment she picks up.</span>
              </label>

              <div className="call-advanced">
                <button type="button" className="link" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
                  Advanced <IconChevron />
                </button>
                {advanced && (
                  <div className="call-advanced-body">
                    <label className="field">
                      <span className="field-label">For</span>
                      <select className="input" value={form.specialty} onChange={(e) => set("specialty", e.target.value)}>
                        {["Cardiology", "Nephrology", "Internal Medicine"].map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="checkrow">
                      <input type="checkbox" checked={form.tamper} onChange={(e) => set("tamper", e.target.checked)} disabled={form.replay} />
                      <span>
                        Edit the message after it's signed
                        <span className="checkrow-sub">Tamper: the text is changed once the signature is made</span>
                      </span>
                    </label>
                    <label className={`checkrow ${replayTarget ? "" : "off"}`}>
                      <input type="checkbox" checked={form.replay} onChange={(e) => set("replay", e.target.checked)} disabled={!replayTarget} />
                      <span>
                        Resend the last verified message
                        <span className="checkrow-sub">{replayTarget ? `Replay: the exact bytes of ${replayTarget.requestId}, signature and all` : "Replay: get one call through as the real brand first"}</span>
                      </span>
                    </label>
                  </div>
                )}
              </div>

              <div className={`wb-predict ${prediction.tone}`} aria-live="polite">
                <span className="dot" aria-hidden />
                <span>{prediction.text}</span>
              </div>

              <div className="call-cta">
                <button type="submit" className="call-btn" disabled={busy || !snapshot} aria-label={`Call ${DOCTOR_SHORT}`}>
                  <IconPhone />
                </button>
                <span className="call-cta-label">{busy ? "Calling…" : `Call ${DOCTOR_SHORT}`}</span>
                {error && <span className="wb-error">{error}</span>}
              </div>
            </form>
          </>
        )}

        {(stage.kind === "verifying" || stage.kind === "ringing") && (
          <section className="call-screen ringing" aria-live="polite">
            <Avatar pulse />
            <div className="call-name">{DOCTOR}</div>
            <div className="call-state">
              {stage.kind === "ringing" ? `Ringing ${DOCTOR_SHORT}…` : `${DOCTOR_SHORT}'s agent is checking who you are`}
            </div>
            <div className="call-caller">
              calling as <strong>{callerName}</strong>
              {verification && (
                <>
                  {" · "}
                  <span className="mono">{verification.sender}</span>
                </>
              )}
            </div>
            <Checks verification={stage.verification} />
            {stage.kind === "ringing" && (
              <div className="call-actions">
                <EndButton onClick={hangup} label="End" disabled={!(call?.id ?? status.callId)} />
              </div>
            )}
          </section>
        )}

        {stage.kind === "rejected" && (
          <section className="call-screen rejected" aria-live="polite">
            <Avatar tone="red" />
            <div className="call-name">Call rejected</div>
            <div className="call-state">
              {stage.failing ? `Her agent stopped you at ${STEP_SHORT[stage.failing.id]}` : "Her agent could not verify you"}
            </div>
            <div className="call-reason">{stage.failing ? rejectionWords(stage.failing.id, stage.failing.detail, stage.verification.sender) : "Verification failed."}</div>
            <div className="call-silent">
              <span className="dot silent" aria-hidden />
              Her phone never rang.
            </div>
            <Checks verification={stage.verification} />
            <div className="call-actions">
              <button type="button" className="btn primary call-again" onClick={again}>
                Try again
              </button>
              <a className="link" href={`/proof/${encodeURIComponent(stage.verification.requestId)}`} target="_blank" rel="noreferrer">
                See the proof <IconChevron />
              </a>
            </div>
          </section>
        )}

        {stage.kind === "held" && (
          <section className="call-screen held" aria-live="polite">
            <Avatar tone="amber" />
            <div className="call-name">Verified, but held</div>
            <div className="call-state">You are who you say you are; her policy is holding the call.</div>
            <div className="call-reason">{stage.detail}</div>
            <div className="call-silent">
              <span className="dot silent" aria-hidden />
              Delivered to her inbox. Her phone stayed silent.
            </div>
            <Checks verification={stage.verification} />
            <div className="call-actions">
              <button type="button" className="btn primary call-again" onClick={again}>
                Try again
              </button>
              <a className="link" href={`/proof/${encodeURIComponent(stage.verification.requestId)}`} target="_blank" rel="noreferrer">
                See the proof <IconChevron />
              </a>
            </div>
          </section>
        )}

        {stage.kind === "connected" && <Connected call={stage.call} callerName={callerName} onHangup={hangup} />}

        {stage.kind === "ended" && <Ended call={stage.call} verification={stage.verification} callerName={callerName} onAgain={again} phonePaired={snapshot?.phone.paired ?? false} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 3: connected
// ---------------------------------------------------------------------------

function Connected({ call, callerName, onHangup }: { call: CallState; callerName: string; onHangup: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dictation = useRef<{ cancel: () => void } | null>(null);
  const transcriptRef = usePinToBottom<HTMLDivElement>([call.transcript.length]);

  // Her lines, read aloud as they arrive. Lines already there when this screen opened are not replayed.
  const spoken = useRef<number>(call.transcript.length);
  useEffect(() => {
    const lines = call.transcript;
    if (spoken.current > lines.length) spoken.current = lines.length;
    const fresh = lines.slice(spoken.current);
    spoken.current = lines.length;
    for (const l of fresh) if (l.role === "doctor") void speak(l.text);
  }, [call.transcript]);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      dictation.current?.cancel();
      stopSpeaking();
    };
  }, []);

  const send = useCallback(
    async (line: string) => {
      const t = line.trim();
      if (!t || sending) return;
      setSending(true);
      setError(null);
      try {
        const r = await fetch("/api/caller/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: call.id, text: t }) });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? r.statusText);
        }
        setText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [call.id, sending],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  const talk = async () => {
    if (listening) {
      dictation.current?.cancel();
      return;
    }
    if (!canDictate()) {
      inputRef.current?.focus();
      return;
    }
    stopSpeaking();
    setListening(true);
    const d = dictateOnce();
    dictation.current = d;
    const heard = await d.done;
    dictation.current = null;
    setListening(false);
    if (heard) {
      setText(heard);
      await send(heard);
    }
  };

  return (
    <section className="call-screen connected" aria-label="On the call">
      <div className="call-top">
        <Avatar tone="green" small />
        <div className="call-top-text">
          <div className="call-name small">
            {DOCTOR} <span className="call-dot">·</span> <span className="call-connected-word">connected</span>
          </div>
          <div className="call-state">
            <Timer since={call.answeredAt ?? call.startedAt} /> · you are {callerName}
          </div>
        </div>
      </div>

      <Bubbles lines={call.transcript} transcriptRef={transcriptRef} />

      <form className="call-say" onSubmit={submit}>
        <button type="button" className={`talk ${listening ? "on" : ""}`} onClick={() => void talk()} title={canDictate() ? "Dictate one line" : "Dictation is not available in this browser"} aria-pressed={listening}>
          <IconMic />
          <span>{listening ? "Listening…" : "Talk"}</span>
        </button>
        <input
          ref={inputRef}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Say something…"
          aria-label="Say something"
          autoComplete="off"
          disabled={sending}
        />
        <button type="submit" className="btn primary" disabled={sending || !text.trim()}>
          Send
        </button>
      </form>
      <div className={`call-say-hint ${error ? "err" : ""}`}>{error ?? "Her phone speaks your line; her reply appears here and is read aloud."}</div>

      <div className="call-actions">
        <EndButton onClick={onHangup} label="End" />
      </div>
    </section>
  );
}

function Ended({
  call,
  verification,
  callerName,
  onAgain,
  phonePaired,
}: {
  call: CallState;
  verification?: VerificationResult;
  callerName: string;
  onAgain: () => void;
  phonePaired: boolean;
}) {
  const transcriptRef = usePinToBottom<HTMLDivElement>([call.transcript.length]);
  const failed = call.status === "failed";
  const talked = Boolean(call.answeredAt);
  const dur = talked ? fmtDuration(new Date(call.endedAt ?? Date.now()).getTime() - new Date(call.answeredAt!).getTime()) : undefined;
  let word: string;
  let sub: string;
  let tone: "green" | "amber" | "red" = "green";
  if (failed) {
    word = "Couldn't ring her phone";
    sub = call.error ?? "The call failed.";
    tone = "red";
  } else if (call.endReason === "no-answer") {
    word = "No answer";
    sub = "You were verified and her phone rang, but nobody picked up. Your message is in her inbox.";
    tone = "amber";
  } else if (call.endReason === "declined") {
    word = "Declined";
    sub = `${DOCTOR_SHORT} declined the call. Your message is in her inbox.`;
    tone = "amber";
  } else {
    word = `Call ended${dur ? ` · ${dur}` : ""}`;
    sub = talked ? `You spoke with ${DOCTOR} as ${callerName}.` : "The call ended before it was answered.";
  }
  return (
    <section className="call-screen ended" aria-live="polite">
      <Avatar tone={tone} />
      <div className="call-name">{word}</div>
      <div className="call-state">{sub}</div>
      {failed && !phonePaired && <div className="call-reason">Dock the phone on the console, or open /phone on a device on this Wi-Fi, then call again.</div>}
      {talked && <Bubbles lines={call.transcript} transcriptRef={transcriptRef} />}
      <div className="call-actions">
        <button type="button" className="btn primary call-again" onClick={onAgain}>
          Call again
        </button>
        {verification && (
          <a className="link" href={`/proof/${encodeURIComponent(verification.requestId)}`} target="_blank" rel="noreferrer">
            See the proof <IconChevron />
          </a>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Her agent's five checks, compact, with the trust card's glyphs. Pending steps shown as such while the result is still on its way. */
function Checks({ verification }: { verification?: VerificationResult }) {
  const steps = verification?.steps ?? [];
  return (
    <ol className="checks compact call-checks" aria-label="Checks">
      {steps.length === 0 ? (
        <li className="wb-waiting">Reaching {DOCTOR_SHORT}'s agent…</li>
      ) : (
        steps.map((s) => <Step key={s.id} step={s} />)
      )}
    </ol>
  );
}

/** The conversation as a call would look on your own phone: your lines on the right, hers on the left. */
function Bubbles({ lines, transcriptRef }: { lines: TranscriptLine[]; transcriptRef: RefObject<HTMLDivElement> }) {
  return (
    <div className="call-bubbles" ref={transcriptRef}>
      {lines.length === 0 && (
        <div className="call-bubble-wrap system">
          <div className="call-bubble">Connected</div>
        </div>
      )}
      {lines.map((l, i) => {
        const side = l.role === "agent" ? "me" : l.role === "doctor" ? "her" : "system";
        const prev = lines[i - 1];
        const showWho = side !== "system" && prev?.role !== l.role;
        return (
          <div key={`${l.ts}-${i}`} className={`call-bubble-wrap ${side}`}>
            {showWho && <div className="call-bubble-who">{side === "me" ? "You" : DOCTOR_SHORT}</div>}
            <div className="call-bubble">{l.text}</div>
          </div>
        );
      })}
    </div>
  );
}

function Avatar({ tone, pulse, small }: { tone?: "green" | "amber" | "red"; pulse?: boolean; small?: boolean }) {
  return (
    <div className={`call-avatar ${tone ?? ""} ${pulse ? "pulse" : ""} ${small ? "small" : ""}`} aria-hidden>
      <span>PP</span>
    </div>
  );
}

function EndButton({ onClick, label, disabled }: { onClick: () => void | Promise<void>; label: string; disabled?: boolean }) {
  return (
    <div className="call-end">
      <button type="button" className="call-btn end" onClick={() => void onClick()} disabled={disabled} aria-label={label}>
        <IconPhone />
      </button>
      <span className="call-cta-label">{label}</span>
    </div>
  );
}

function Timer({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(iv);
  }, []);
  const t0 = new Date(since).getTime();
  return <span className="num">{fmtDuration(Number.isNaN(t0) ? 0 : now - t0)}</span>;
}

function IconMic() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The workbench prediction, said from the caller's side. */
function callerWords(p: Prediction): Prediction {
  let text = p.text
    .replace(/^This will fail at /, "Her agent will reject this at ")
    .replace(/^Enter a domain to send as\. Whatever it is, this will fail at Resolve: no registry knows it\.$/, "Enter a domain to call as. Whatever it is, her agent will reject it at Resolve: no registry knows it.")
    .replace(/^This should pass all five checks and ring the phone\./, "This should get through and ring her phone.")
    .replace(/^This should pass all five identity checks, then be held/, "This will get through the five identity checks, then be held");
  if (p.tone === "red" && p.failsAt) text = text.replace(/\. Her phone stays silent.*$/, ".");
  return { ...p, text };
}

/** One sentence for the rejection screen, in plain words, with the check's own detail. */
function rejectionWords(step: StepId, detail: string | undefined, sender: string): string {
  const d = detail?.trim().replace(/[.\s]+$/, "");
  switch (step) {
    case "resolve":
      return `Her agent could not resolve ${sender} in the Agent Name Service.`;
    case "certificate":
      return `The certificate presented for ${sender} did not check out${d ? `: ${d}` : "."}`;
    case "transparency":
      return `${sender} has no receipt in the transparency log${d ? `: ${d}` : "."}`;
    case "signature":
      return `The message was not signed by ${sender}'s registered key${d ? `: ${d}` : "."}`;
    default:
      return d ?? "Verification failed.";
  }
}
