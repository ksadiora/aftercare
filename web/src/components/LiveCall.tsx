import { useEffect, useState, type FormEvent, type RefObject } from "react";
import type { CallState, Negotiation as NegotiationT, PhoneState } from "@callsign/shared";
import { Empty, IconChevron, IconPhone, Pill, usePinToBottom } from "./ui.tsx";
import { Negotiation } from "./Negotiation.tsx";
import { DOCKED_DEVICE, openPhoneWindow } from "./PhoneCard.tsx";

const STATUS: Record<CallState["status"], { word: string; tone?: "green" | "red" | "amber" }> = {
  queued: { word: "Calling", tone: "amber" },
  dialing: { word: "Calling", tone: "amber" },
  ringing: { word: "Ringing", tone: "amber" },
  "in-progress": { word: "On the call", tone: "green" },
  ended: { word: "Ended" },
  failed: { word: "Failed", tone: "red" },
};

export { DOCKED_DEVICE };

/**
 * The live call, and below its transcript, the agent-to-agent negotiation
 * that runs mid-call when the doctor asks for something.
 *
 * Docked mode: the doctor's phone lives inside this card as an iframe of
 * /phone (popups get blocked; an iframe on the same origin does not). The
 * phone sits on the left, the transcript and negotiation beside it, so the
 * ringing phone and the signed agreement are both on screen at once.
 */
export function LiveCall({
  call,
  negotiation,
  brandName,
  phone,
  docked,
  onDock,
  onUndock,
  onTurn,
}: {
  call?: CallState;
  negotiation?: NegotiationT;
  brandName: string;
  phone?: PhoneState;
  docked?: boolean;
  onDock?: () => void;
  onUndock?: () => void;
  /** Send a typed line as the doctor during an in-progress call. */
  onTurn?: (callId: string, text: string) => Promise<unknown>;
}) {
  const transcriptRef = usePinToBottom<HTMLDivElement>([call?.id, call?.transcript.length, call?.status, Boolean(negotiation)]);
  // The phone can be docked when nothing is paired, or to take over from an earlier dock (page reload).
  const canDock = Boolean(onDock) && (!phone?.paired || phone.deviceName === DOCKED_DEVICE);

  const head = call ? (
    <CallHead call={call} brandName={brandName} phone={phone} />
  ) : (
    <div className="card-head">
      <span className="card-title">Live call</span>
      {docked && phone?.paired && (
        <span className="card-meta">
          <span className="dot paired" aria-hidden /> Paired · {phone.deviceName}
        </span>
      )}
    </div>
  );

  const main = !call ? (
    <Empty
      title={docked ? "Waiting for a verified agent." : "No call in progress."}
      sub={docked ? "Unverified ones will never make it ring." : "The phone only rings for a verified agent."}
      glyph={<IconPhone />}
    />
  ) : (
    <>
      <Transcript call={call} brandName={brandName} transcriptRef={transcriptRef} />
      {call.status === "in-progress" && onTurn && <DoctorInput callId={call.id} onTurn={onTurn} />}
      {negotiation && <Negotiation negotiation={negotiation} brandName={brandName} />}
    </>
  );

  if (docked) {
    return (
      <section className={`card call docked ${negotiation ? "with-nego" : ""}`} aria-label="Live call">
        {head}
        <div className="dock-split">
          <div className="dock">
            <div className="dock-phone">
              <iframe src={`/phone?device=${encodeURIComponent(DOCKED_DEVICE)}&embedded=1`} allow="microphone; autoplay" title="Dr. Patel's phone" />
            </div>
            <div className="dock-caption">
              <span className="dock-caption-text">Dr. Patel's phone · this computer</span>
              <span className="dock-caption-links">
                <button type="button" className="link" onClick={onUndock}>
                  Undock
                </button>
                <button type="button" className="link" onClick={openPhoneWindow} title="Open the phone as its own window instead">
                  Window <IconChevron />
                </button>
              </span>
            </div>
          </div>
          <div className="dock-main">{main}</div>
        </div>
      </section>
    );
  }

  return (
    <section className={`card call ${negotiation ? "with-nego" : ""}`} aria-label="Live call">
      {head}
      {main}
      {canDock && (!call || call.status === "ended" || call.status === "failed") && (
        <div className="dock-cta">
          <button type="button" className="btn primary" onClick={onDock}>
            Use this computer as the phone
          </button>
          <button type="button" className="link" onClick={openPhoneWindow}>
            Open in a window instead <IconChevron />
          </button>
        </div>
      )}
    </section>
  );
}

/** The caller page relays a person's call; her agent marks it in the transcript. */
function isHumanCaller(call: CallState): boolean {
  return call.transcript.some((l) => l.role === "system" && / is a live caller$/.test(l.text));
}

function CallHead({ call, brandName, phone }: { call: CallState; brandName: string; phone?: PhoneState }) {
  const st = STATUS[call.status];
  const human = isHumanCaller(call);
  return (
    <div className="call-head">
      <span className={`phone-glyph ${call.status}`} aria-hidden>
        <IconPhone />
      </span>
      <div className="call-who">
        <div className="call-to">{call.to}</div>
        <div className="call-sub">
          {human ? `${call.callerName ?? brandName} (live caller)` : `${brandName} agent`} → Dr. Patel{call.mock ? " · simulated" : ""}
        </div>
      </div>
      {phone?.paired && call.status === "ringing" ? (
        // Cosmetic mirror of the paired phone: it is ringing in someone's hand right now.
        <span className="pill amber phone-mirror" title={`Ringing ${phone.deviceName ?? "the paired phone"}`}>
          <span className="mirror-device" aria-hidden>
            <span className="mirror-halo" />
          </span>
          <span className="mirror-text">Ringing {phone.deviceName ?? "phone"}</span>
        </span>
      ) : (
        <Pill tone={st.tone} dot>
          {st.word}
        </Pill>
      )}
    </div>
  );
}

function Transcript({ call, brandName, transcriptRef }: { call: CallState; brandName: string; transcriptRef: RefObject<HTMLDivElement> }) {
  const who = { agent: isHumanCaller(call) ? `${call.callerName ?? brandName} · live caller` : `${brandName} agent`, doctor: "Dr. Patel", system: "" } as const;
  return (
    <div className="transcript" ref={transcriptRef}>
      {call.transcript.length === 0 && (
        <div className="bubble-wrap system">
          <div className="bubble">Placing call…</div>
        </div>
      )}
      {call.transcript.map((l, i) => {
        const prev = call.transcript[i - 1];
        const showWho = l.role !== "system" && prev?.role !== l.role;
        return (
          <div key={i} className={`bubble-wrap ${l.role}`}>
            {showWho && <div className="bubble-who">{who[l.role]}</div>}
            <div className="bubble">{l.text}</div>
          </div>
        );
      })}
      {call.error && (
        <div className="bubble-wrap system error">
          <div className="bubble">{call.error}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Type a line as the doctor. The server adds it to the transcript and
 * answers in text; the phone only speaks replies it asked for itself, so a
 * typed turn is silent on the handset. Good for a judge without a mic.
 */
function DoctorInput({ callId, onTurn }: { callId: string; onTurn: (callId: string, text: string) => Promise<unknown> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText("");
    setError(null);
  }, [callId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const line = text.trim();
    if (!line || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onTurn(callId, line);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="doctor-input" onSubmit={submit}>
      <input
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type as Dr. Patel…"
        aria-label="Type as Dr. Patel"
        disabled={busy}
        autoComplete="off"
      />
      <button type="submit" className="btn gray" disabled={busy || !text.trim()}>
        Send
      </button>
      <div className={`doctor-input-hint ${error ? "err" : ""}`}>{error ?? "Text only; the phone speaks only what it hears."}</div>
    </form>
  );
}
