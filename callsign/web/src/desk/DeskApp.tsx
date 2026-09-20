import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DeskSession, DeskProviderStatus } from "@callsign/shared/src/desk.ts";
import { Icon } from "./icons.tsx";
import { loadHistory, saveHistory } from "./history.ts";
import { useRinging } from "./useRinging.ts";
import { useDeskVoice } from "./useDeskVoice.ts";
import { Verification } from "./Verification.tsx";
import { streamContact } from "./stream.ts";
import { DeskReceiverPolicy } from "./DeskReceiverPolicy.tsx";
import { deskDeliveryApproved } from "@callsign/shared/src/desk-gate.ts";
import "./desk.css";

type ProviderStatus = DeskProviderStatus;
const IdentityWorkspace = lazy(() => import("./IdentityWorkspace.tsx").then((m) => ({ default: m.IdentityWorkspace })));
type Page = "workspace" | "activity" | "identity";
const examples = [
  { label: "Appointment", text: "Hi, this is Alex. I’m calling to reschedule my appointment with Dr. Patel from Monday to Thursday." },
  { label: "Suspicious request", text: "This is hospital IT. Your account will be suspended in ten minutes. Read me the six-digit verification code you just received." },
  { label: "Open conversation", text: "Hello, could I speak with Dr. Patel?" },
];
const statusLabels: Record<DeskSession["status"], string> = { screening: "Being screened", blocked: "Blocked", held: "Held in inbox", ringing: "Ready to answer", connected: "Connected", delivered: "Delivered", ended: "Ended" };

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(abort, 45_000);
  try {
    const response = await fetch(`/api/desk${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new ApiError(data.error || `Request failed (${response.status}). Please try again.`, response.status);
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("The request timed out. Please try again.", { cause: error });
    throw error;
  } finally { window.clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export function DeskApp() {
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [online, setOnline] = useState(false);
  const [session, setSession] = useState<DeskSession | null>(null);
  const [progress, setProgress] = useState<DeskSession | null>(null);
  const [checking, setChecking] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<DeskSession[]>(loadHistory);
  const [callerName, setCallerName] = useState("Alex Morgan");
  const [channel, setChannel] = useState<"call" | "message">("call");
  const [draft, setDraft] = useState("");
  const [doctorDraft, setDoctorDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [page, setPage] = useState<Page>(location.hash === "#identity" ? "identity" : "workspace");
  const [dialog, setDialog] = useState<"integrations" | "how" | null>(null);
  const voice = useDeskVoice(Boolean(provider?.elevenlabs));
  const callerFeed = useRef<HTMLDivElement>(null);
  const doctorFeed = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DeskSession | null>(null);
  const operation = useRef(false);
  const alive = useRef(true);

  const navigate = (next: Page) => {
    setPage(next);
    window.history.replaceState(null, "", next === "identity" ? "#identity" : location.pathname);
  };

  const updateSession = (next: DeskSession) => {
    sessionRef.current = next;
    setSession(next);
    setChannel(next.channel);
    setHistory((previous) => [next, ...previous.filter((item) => item.id !== next.id)].slice(0, 30));
    try { sessionStorage.setItem("callsign.desk.session", next.id); } catch { /* Storage is optional. */ }
  };

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void api<ProviderStatus>("/status", undefined, controller.signal).then((value) => { if (alive.current) { setProvider(value); setOnline(true); } }).catch(() => { if (alive.current) setOnline(false); });
    let saved: string | null = null;
    try { saved = sessionStorage.getItem("callsign.desk.session"); } catch { /* Storage is optional. */ }
    if (saved) void api<DeskSession>(`/sessions/${encodeURIComponent(saved)}`, undefined, controller.signal).then((value) => { if (!controller.signal.aborted && !operation.current && !sessionRef.current) updateSession(value); }).catch(() => {
      if (controller.signal.aborted) return;
      const archived = loadHistory().find((item) => item.id === saved);
      if (archived && !operation.current && !sessionRef.current) updateSession({ ...archived, status: archived.status === "blocked" ? "blocked" : "ended" });
      else { try { sessionStorage.removeItem("callsign.desk.session"); } catch { /* Storage is optional. */ } }
    });
    return () => { alive.current = false; controller.abort(); activeRequest.current?.abort(); };
  }, []);

  useEffect(() => { setStorageError(!saveHistory(history)); }, [history]);

  useEffect(() => {
    callerFeed.current?.scrollTo({ top: callerFeed.current.scrollHeight, behavior: "smooth" });
    doctorFeed.current?.scrollTo({ top: doctorFeed.current.scrollHeight, behavior: "smooth" });
  }, [session?.transcript.length, busy]);

  const refreshStatus = async () => {
    try { setProvider(await api<ProviderStatus>("/status")); setOnline(true); }
    catch { setOnline(false); }
  };
  const perform = async (path: string, body: unknown, clearDraft = false) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    voice.stopListening();
    voice.stop();
    const controller = new AbortController();
    activeRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 90_000);
    const contact = path === "/sessions" || path.endsWith("/turn");
    setChecking(contact);
    setProgress(null);
    const seen = new Set(sessionRef.current?.transcript.map((line) => line.id) ?? []);
    try {
      const next = contact ? await streamContact(path, body, (value) => {
        if (alive.current) {
          setProgress(value);
          try { sessionStorage.setItem("callsign.desk.session", value.id); } catch { /* Storage is optional. */ }
        }
      }, controller.signal) : await api<DeskSession>(path, body, controller.signal);
      if (!alive.current) return;
      setOnline(true);
      updateSession(next);
      if (clearDraft) setDraft("");
      if (path.endsWith("/reply")) setDoctorDraft("");
      const last = next.transcript.filter((line) => line.role !== "caller" && !seen.has(line.id)).at(-1);
      if (last) void voice.speak(last.text, last.role as "screener" | "doctor");
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : "Something went wrong. Please try again.");
        if (failure instanceof ApiError && failure.status === 404 && sessionRef.current) updateSession({ ...sessionRef.current, status: "ended" });
      }
    } finally { window.clearTimeout(timer); activeRequest.current = null; operation.current = false; if (alive.current) { setBusy(false); setChecking(false); setProgress(null); } }
  };
  const terminal = session?.status === "ended" || session?.status === "blocked" || session?.status === "held";
  const hasLiveSession = Boolean(session && !terminal);
  const canSend = !busy && !terminal && session?.status !== "ringing";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    void perform(session ? `/sessions/${session.id}/turn` : "/sessions", session ? { text } : { callerName: callerName.trim() || "Unknown caller", channel, text }, true);
  };
  const reset = () => {
    if (hasLiveSession || busy) return;
    voice.stop(); voice.stopListening();
    setSession(null); sessionRef.current = null; setDraft(""); setDoctorDraft(""); setError(""); setPage("workspace");
    try { sessionStorage.removeItem("callsign.desk.session"); } catch { /* Storage is optional. */ }
  };
  const reachedDoctor = Boolean(session?.transcript.some((line) => line.role === "doctor"));
  const status = session?.status === "ringing" && !deskDeliveryApproved(session) ? "screening" : session?.status;
  const screening = checking;
  const visible = progress ?? session;
  const proof = visible?.verification;
  const contentRan = proof?.steps.some((step) => step.id === "content" && ["pass", "fail", "ask"].includes(step.status));
  useRinging(status === "ringing" && !busy && online, voice.enabled);
  const assessment = contentRan ? visible?.assessment : undefined;
  const connected = status === "connected" || status === "delivered";
  const readLatest = session?.transcript.filter((line) => line.role !== "caller").at(-1);
  const end = () => { if (session) void perform(`/sessions/${session.id}/end`, {}); };
  const refreshSession = async () => {
    const current = sessionRef.current;
    if (!current || operation.current) return;
    const next = await api<DeskSession>(`/sessions/${current.id}`);
    if (alive.current && !operation.current && sessionRef.current?.id === current.id) updateSession(next);
  };
  useEffect(() => {
    const initial = sessionRef.current;
    if (!initial || !["ringing", "connected", "delivered"].includes(initial.status)) return;
    const controller = new AbortController();
    let pending = false;
    const timer = window.setInterval(() => {
      const current = sessionRef.current;
      if (!current || operation.current || pending) return;
      pending = true;
      void api<DeskSession>(`/sessions/${current.id}`, undefined, controller.signal).then((next) => {
        if (!controller.signal.aborted) setOnline(true);
        if (!controller.signal.aborted && !operation.current && sessionRef.current === current && next.status !== current.status) updateSession(next);
      }).catch(() => { if (!controller.signal.aborted) setOnline(false); }).finally(() => { pending = false; });
    }, 2000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [session?.id, session?.status]);

  return (
    <div className="desk-app">
      <header className="desk-header">
        <a className="desk-brand" href="/" aria-label="Callsign home"><span className="desk-brand-mark"><i /><i /><i /><i /></span>callsign<span className="desk-brand-period">.</span></a>
        <nav aria-label="Main navigation" className="desk-nav">
          <button className={page === "workspace" ? "active" : ""} onClick={() => navigate("workspace")}>Workspace</button>
          <button className={page === "identity" ? "active" : ""} onClick={() => navigate("identity")}>Identity checks</button>
          <button className={page === "activity" ? "active" : ""} onClick={() => navigate("activity")}>Activity{history.length > 0 && <span>{history.length}</span>}</button>
          <button onClick={() => setDialog("how")}>How it works <Icon name="arrow" size={14} /></button>
        </nav>
        <div className="desk-header-right"><button className="desk-icon-button" onClick={voice.toggle} aria-label={voice.enabled ? "Mute voice" : "Enable voice"} title={voice.enabled ? "Mute voice" : "Enable voice"}><Icon name={voice.enabled ? "volume" : "muted"} /></button><button className="desk-integrations" onClick={() => { setDialog("integrations"); void refreshStatus(); }}><Icon name="settings" size={16} /> Integrations</button><span className="desk-avatar" title="Dr. Priya Patel">PP</span></div>
      </header>

      <main className="desk-main">
        <div className="desk-heading-row"><div><div className="desk-eyebrow"><span className="desk-live-dot" /> YOUR PRACTICE, PROTECTED</div><h1>A little distance from unwanted calls.</h1><p>Verify the agent. Apply your policy. Screen every message.</p></div><div className="desk-doctor-label"><span className="desk-avatar large">PP</span><div><strong>Dr. Priya Patel</strong><span>Cardiology <span aria-hidden="true">·</span> Personal agent</span></div></div></div>

        {page === "workspace" ? <>
          <div className="desk-workspace-toolbar"><div className="desk-workspace-title"><Icon name="phone" size={17} /><strong>Live workspace</strong><span className="desk-tag">Browser demo</span></div><div className="desk-workspace-tools"><span className={`desk-server-state ${online ? "online" : "offline"}`}><i />{online ? "Agent online" : "Connecting to agent"}</span><button className="desk-text-button" disabled={hasLiveSession || busy} onClick={reset}><Icon name="plus" size={15} /> New session</button></div></div>
          <div className="desk-grid">
            <section className="desk-panel desk-caller" aria-labelledby="caller-heading">
              <PanelHeading number="01" title="The caller" subtitle="Start the conversation" icon="phone" id="caller-heading" />
              <div className="desk-channel-switch" role="group" aria-label="Contact type"><button aria-pressed={channel === "call"} disabled={Boolean(session) || busy} onClick={() => setChannel("call")}><Icon name="phone" size={15} /> Phone call</button><button aria-pressed={channel === "message"} disabled={Boolean(session) || busy} onClick={() => setChannel("message")}><Icon name="message" size={15} /> Text message</button></div>
              <div className="desk-caller-identity"><label htmlFor="caller-name">CALLER NAME <span>Self-reported</span></label><div><span className="desk-person-avatar">{(session?.callerName ?? callerName).trim().slice(0, 1).toUpperCase() || "?"}</span><input id="caller-name" value={session?.callerName ?? callerName} onChange={(event) => setCallerName(event.target.value)} maxLength={80} disabled={Boolean(session) || busy} autoComplete="off" /><Icon name="arrow" size={16} /><span className="desk-destination">Dr. Patel</span></div></div>
              <div className="desk-caller-feed" ref={callerFeed} role="log" aria-label="Caller conversation" aria-live="polite">
                {!session && !busy ? <div className="desk-empty-caller"><div className="desk-chat-illustration"><span><Icon name="message" size={26} /></span><span><Icon name="shield" size={20} /></span><i /><i /><i /></div><h3>Every conversation starts here.</h3><p>Say why you’re calling. Your words go to Dr. Patel’s agent first.</p><div className="desk-example-label">NEED A STARTING POINT?</div><div className="desk-examples">{examples.map((example) => <button key={example.label} onClick={() => setDraft(example.text)}>{example.label}<Icon name="arrow" size={12} /></button>)}</div></div> : <>
                  {visible?.transcript.map((line) => <div key={line.id} className={`desk-chat-line ${line.role}`}><div className="desk-chat-line-meta">{line.role === "caller" ? "You" : line.role === "doctor" ? "Dr. Patel · demo receiver" : "Callsign agent"}<span>{time(line.ts)}</span></div><div className="desk-chat-bubble">{line.text}</div></div>)}
                  {busy && <div className="desk-thinking"><span /><span /><span />{screening ? "Verifying this message…" : "Preparing a response…"}</div>}
                </>}
              </div>
              <form className="desk-compose" onSubmit={submit}>
                <label className="desk-sr-only" htmlFor="caller-message">Message to Dr. Patel’s agent</label><textarea id="caller-message" placeholder={terminal ? "Start a new session to try another conversation." : status === "ringing" ? "Waiting for Dr. Patel to answer…" : connected ? "Continue your conversation…" : "Hi, I’m calling about…"} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (draft.trim()) submit(event); } }} maxLength={2000} disabled={!canSend} rows={3} />
                <div className="desk-compose-actions"><button type="button" className={`desk-mic-button ${voice.listening ? "listening" : ""}`} disabled={!canSend} onClick={() => voice.dictate(setDraft)} aria-label={voice.listening ? "Stop microphone" : "Dictate message"}><Icon name="mic" size={17} />{voice.listening ? "Listening…" : "Use mic"}</button><button className="desk-button primary" disabled={!canSend || !draft.trim()} type="submit"><Icon name={session ? "send" : channel === "call" ? "phone" : "send"} size={16} />{busy ? "Please wait…" : session ? "Send" : channel === "call" ? "Place call" : "Send message"}</button></div>
              </form>
              <div className="desk-panel-foot"><Icon name="lock" size={12} />{terminal ? "Session finished. Start a new one above." : "A browser conversation. No phone number needed."}</div>
            </section>

            <section className="desk-panel desk-agent" aria-labelledby="agent-heading">
              <PanelHeading number="02" title="Your Callsign agent" subtitle="A thoughtful first line of defense" icon="shield" id="agent-heading" />
              <div className={`desk-agent-core ${screening ? "thinking" : ""} ${status === "blocked" ? "blocked" : ""}`}><div className="desk-orbit orbit-one" /><div className="desk-orbit orbit-two" /><div className="desk-orbit orbit-three" /><div className="desk-orb"><Icon name={status === "blocked" ? "shield" : "spark"} size={36} /></div><span className="desk-orbit-dot dot-one" /><span className="desk-orbit-dot dot-two" /><span className="desk-agent-mini-tag"><i />{screening ? "Verifying every message" : status === "blocked" ? "Risk intercepted" : connected ? "Monitoring conversation" : "Always before the ring"}</span></div>
              <div className="desk-agent-message" aria-live="polite"><h2>{screening ? "Checking before connecting." : status === "held" ? "Your policy holds this request." : status === "blocked" ? "This conversation stops here." : status === "ringing" ? "Ready for your attention." : connected ? "A clearer connection." : status === "ended" ? "Conversation complete." : session ? "A little more context, please." : "Good conversations get through."}</h2><p>{screening ? "ANS, certificate, log, signature and policy checks run before content screening." : visible?.assessment.summary ?? "Your agent verifies the sender, applies your policy, then screens what they say."}</p></div>
              <Verification proof={proof} registry={provider?.registry} />
              {assessment && <details className="desk-evidence"><summary>View decision evidence <Icon name="chevron" size={13} /></summary><div>{assessment.signals.map((signal, index) => <div className="desk-evidence-item" key={`${signal.label}-${index}`}><strong>{signal.label}</strong><p>{signal.detail}</p>{signal.quote && <blockquote>“{signal.quote}”</blockquote>}</div>)}<p className="desk-evidence-note">Content screening is an assessment, not a guarantee that a caller is genuine.</p></div></details>}
              <div className={`desk-route-outcome ${status === "blocked" ? "blocked" : connected || status === "ringing" ? "allowed" : ""}`}><Icon name={status === "blocked" ? "shield" : connected || status === "ringing" ? "check" : "arrow"} size={17} /><span>{screening ? "Checks in progress · This message is not delivered" : status === "held" ? "Held in inbox · Phone stays silent" : status === "blocked" ? reachedDoctor ? "Conversation stopped · Latest request blocked" : "Blocked · Doctor’s phone stayed protected" : status === "ringing" ? "Screening passed · Waiting for pickup" : status === "connected" ? "Screening passed · Call connected" : status === "delivered" ? "Screening passed · Message delivered" : status === "ended" ? "Session closed" : "Screen first. Connect when appropriate."}</span></div>
              <div className="desk-panel-foot">{proof?.verdict === "verified" ? "Agent checks passed" : "Agent verification required"}<span>•</span>Human name is self-reported</div>
            </section>

            <section className="desk-panel desk-doctor" aria-labelledby="doctor-heading">
              <PanelHeading number="03" title="The doctor" subtitle="Only the conversations that matter" icon="phone" id="doctor-heading" />
              <DeskReceiverPolicy onChange={refreshSession} />
              <div className="desk-receiver-profile"><span className="desk-avatar doctor-avatar">PP<span /></span><h3>Dr. Priya Patel</h3><p>Cardiology <span>·</span> Personal line</p><span className={`desk-receiver-status ${status === "ringing" ? "ringing" : connected ? "connected" : ""}`}><i />{status === "ringing" ? "Incoming screened call" : connected ? channel === "message" ? "Message received" : "Call in progress" : "Protected by Callsign"}</span></div>
              <div className={`desk-phone-screen ${connected ? "in-call" : ""}`}>
                {connected ? <><div className="desk-phone-screen-top"><span><i />{status === "delivered" ? "Message thread" : "Connected"}</span><span>AI doctor demo</span></div><div className="desk-doctor-feed" ref={doctorFeed} role="log" aria-label="Doctor conversation">{session?.transcript.filter((line) => (line.role === "doctor" || (line.role === "caller" && line.delivered))).map((line) => <div className={`desk-receiver-line ${line.role}`} key={line.id}><strong>{line.role === "caller" ? session.callerName : "Dr. Patel"}</strong><p>{line.text}</p>{line.role === "doctor" && <small>{line.engine === "gemini" ? "Gemini reply" : line.engine === "local" ? "Local reply" : "Manual reply"}</small>}</div>)}</div><form className="desk-doctor-compose" onSubmit={(event) => { event.preventDefault(); if (doctorDraft.trim() && session) { void perform(`/sessions/${session.id}/reply`, { text: doctorDraft.trim() }); } }}><label className="desk-sr-only" htmlFor="doctor-message">Reply as doctor</label><input id="doctor-message" placeholder="Or reply as the doctor…" value={doctorDraft} onChange={(event) => setDoctorDraft(event.target.value)} maxLength={2000} disabled={busy} /><button className="desk-icon-button" aria-label="Send doctor reply" disabled={busy || !doctorDraft.trim()}><Icon name="send" size={16} /></button></form></> : status === "ringing" ? <div className="desk-incoming"><span className="desk-incoming-icon"><Icon name="phone" size={27} /></span><span className="desk-eyebrow">INCOMING CALL</span><h3>{session?.callerName}</h3><p>Agent checks, policy and content screening passed. The human name is self-reported.</p><div className="desk-incoming-actions"><button className="desk-decline" onClick={() => session && void perform(`/sessions/${session.id}/decline`, {})} disabled={busy}><Icon name="phone" size={19} />Decline</button><button className="desk-answer" disabled={busy} onClick={() => session && void perform(`/sessions/${session.id}/answer`, {})}><Icon name="phone" size={19} />Accept call</button></div></div> : <div className="desk-receiver-empty"><span className={`desk-silent-icon ${status === "blocked" ? "blocked" : ""}`}><Icon name={status === "blocked" ? "shield" : "phone"} size={28} /></span><h3>{status === "held" ? "Held in your inbox." : status === "blocked" ? reachedDoctor ? "The conversation was stopped." : "One less interruption." : status === "ended" ? session?.endReason === "declined" ? "Call declined." : "You’re all caught up." : "Quiet, until it matters."}</h3><p>{status === "held" ? session?.holdReason ?? "Your policy stopped delivery. This contact is held in the inbox and the phone stays silent." : status === "blocked" ? reachedDoctor ? "The agent detected a suspicious follow-up and stopped the conversation before another reply." : "The agent blocked this request. It never reached the doctor’s line." : status === "ended" ? "This session has ended. The conversation is saved in this browser’s activity." : "Screened calls appear here. You choose when to answer."}</p><div className="desk-silent-wave">{Array.from({ length: 23 }, (_, index) => <i key={index} style={{ height: `${6 + Math.sin(index * 1.7) ** 2 * 16}px` }} />)}</div></div>}
              </div>
              <div className="desk-doctor-bottom">{hasLiveSession ? <button className="desk-end-button" disabled={busy} onClick={end}><Icon name="phone" size={15} />{connected ? "End conversation" : "Cancel session"}</button> : <span><Icon name="shield" size={15} />Your time stays yours.</span>}{readLatest && <button className="desk-icon-button" disabled={busy} title="Replay latest reply" aria-label="Replay latest reply" onClick={() => void voice.speak(readLatest.text, readLatest.role as "screener" | "doctor", true)}><Icon name="volume" size={17} /></button>}</div>
              <div className="desk-panel-foot">Demo receiver · {provider?.gemini ? "Gemini conversation" : "Local replies"}</div>
            </section>
          </div>
          <div className="desk-feedback" aria-live="polite">{storageError && <div className="desk-error">Browser storage is unavailable. History will last only while this page is open.</div>}{error && <div className="desk-error" role="alert"><Icon name="alert" size={16} />{error}</div>}{session?.error && <div className="desk-error"><Icon name="alert" size={16} />{session.error}</div>}{voice.notice && <div className="desk-voice-notice"><Icon name="volume" size={15} />{voice.notice}</div>}</div>
          <div className="desk-bottom-bar"><span><Icon name="lock" size={14} /> Every caller message passes verification, policy and content checks.</span><div><span>{provider?.gemini ? "Gemini configured" : "Gemini not configured"}</span><i /><span>{voice.enabled ? provider?.elevenlabs ? "ElevenLabs voice" : "Browser voice" : "Voice off"}</span>{voice.speaking && <span className="desk-speaking">Speaking</span>}</div></div>
        </> : page === "identity" ? <Suspense fallback={<p>Opening identity checks…</p>}><IdentityWorkspace /></Suspense> : <section className="desk-activity"><div className="desk-activity-heading"><div><h2>Conversation activity</h2><p>Sessions from this workspace. Saved only in this browser. No database.</p></div><div className="desk-activity-tools"><button className="desk-text-button" disabled={hasLiveSession || busy || !history.length} onClick={() => { setHistory([]); reset(); setPage("activity"); }}>Clear history</button><button className="desk-button primary" onClick={() => setPage("workspace")}><Icon name="arrow" size={16} />Back to workspace</button></div></div>{history.length ? <div className="desk-activity-list">{history.map((item) => <button disabled={hasLiveSession && session?.id !== item.id} onClick={() => { updateSession(item.id === session?.id ? item : { ...item, status: item.status === "blocked" ? "blocked" : "ended" }); setChannel(item.channel); setPage("workspace"); }} key={item.id}><span className="desk-activity-icon"><Icon name={item.channel === "call" ? "phone" : "message"} /></span><span><strong>{item.callerName}</strong><small>{item.transcript.find((line) => line.role === "caller")?.text}</small></span><span className={`desk-history-status ${item.status}`}>{item.endReason === "declined" ? "Declined" : statusLabels[item.status]}</span><span>{time(item.createdAt)}</span><Icon name="chevron" size={16} /></button>)}</div> : <div className="desk-activity-empty"><Icon name="clock" size={32} /><h3>A fresh start.</h3><p>Your conversations will appear here after you start a session.</p></div>}</section>}
        <footer className="desk-footer"><span>callsign<span>.</span> <span>A calmer way to connect.</span></span><span>Agent identity is checked. The human name stays self-reported.</span></footer>
      </main>
      {dialog && <Dialog title={dialog === "integrations" ? "Connected intelligence" : "Three steps. One protected line."} onClose={() => setDialog(null)}>{dialog === "integrations" ? <><p className="desk-dialog-intro">Provider keys stay on the server. A configured key is checked when a request is made.</p><div className="desk-provider-card"><div><Icon name="spark" /><strong>Google Gemini</strong><span className={provider?.gemini ? "configured" : ""}>{provider?.gemini ? "Configured" : "Not configured"}</span></div><p>Assesses the conversation and gives the demo doctor natural, contextual replies.</p><code>GEMINI_API_KEY</code><small>Model: {provider?.model || "Loading…"}</small></div><div className="desk-provider-card"><div><Icon name="volume" /><strong>ElevenLabs</strong><span className={provider?.elevenlabs ? "configured" : ""}>{provider?.elevenlabs ? "Configured" : "Not configured"}</span></div><p>Natural speech for the screening agent and the doctor’s replies.</p><code>ELEVENLABS_API_KEY</code><small>Optional: ELEVENLABS_VOICE_ID</small></div><p className="desk-dialog-note">Add keys to the ignored <code>.env</code> file and restart the server. Without keys, local screening and browser speech remain available and are labeled as such.</p><button className="desk-button primary" onClick={() => void refreshStatus()}><Icon name="refresh" size={16} />Refresh status</button></> : <><div className="desk-how-step"><b>01</b><div><h3>Be the caller</h3><p>Type or dictate a message. The server signs it as the displayed demo agent. That proves the agent key, not the human caller’s name. Examples only fill the composer.</p></div></div><div className="desk-how-step"><b>02</b><div><h3>See the agent’s assessment</h3><p>Every initial message and follow-up goes through ANS resolution, certificate verification, transparency log, signature and replay checks, the doctor’s policy, then content screening. Expand any live step to inspect its evidence. The source badge distinguishes this server’s local demo registry from GoDaddy’s public ANS.</p></div></div><div className="desk-how-step"><b>03</b><div><h3>Pick up when you’re ready</h3><p>Allowed calls ring the receiver. Answer to start a conversation with the clearly labeled AI doctor demo, or type a reply as the doctor. Allowed texts are delivered directly.</p></div></div><p className="desk-dialog-note">This is an in-browser demo, with no real phone call or clinical service. Use fictional information. With Gemini enabled, conversation text is sent to Google; with ElevenLabs voice enabled, replies are sent to ElevenLabs.</p></>}</Dialog>}
    </div>
  );
}

function PanelHeading({ number, title, subtitle, icon, id }: { number: string; title: string; subtitle: string; icon: "phone" | "shield"; id: string }) {
  return <div className="desk-panel-heading"><span className="desk-panel-icon"><Icon name={icon} size={20} /></span><div><h2 id={id}>{title}</h2><p>{subtitle}</p></div><span className="desk-panel-number">{number}</span></div>;
}
function time(value: string) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} className="desk-dialog" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="desk-dialog-heading"><h2>{title}</h2><button className="desk-icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close" /></button></div>{children}</dialog>;
}
