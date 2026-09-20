import { useEffect, useReducer, useRef } from "react";
import type { DoctorPolicy, ImpostorVariant, PhoneSessionResponse, PhoneState, PhoneTurnResponse, PolicyUpdateBody, ProofBundle, ServerEvent, Snapshot } from "@callsign/shared";

/**
 * One hook that owns the live state. Connects to /ws, applies every
 * ServerEvent to the snapshot, and exposes the demo actions. The Screen
 * lane builds every component on top of this and should not need to touch
 * it unless the shared contract changes.
 */

type State = { snapshot?: Snapshot; connected: boolean };

function reduce(state: State, ev: ServerEvent | { type: "ws"; connected: boolean }): State {
  if (ev.type === "ws") return { ...state, connected: ev.connected };
  const s = state.snapshot;
  switch (ev.type) {
    case "snapshot":
      return { ...state, snapshot: ev.snapshot };
    case "demo.reset":
      return state; // a snapshot follows immediately
    default:
      break;
  }
  if (!s) return state;
  switch (ev.type) {
    case "verification.update":
    case "verification.done": {
      const rest = s.verifications.filter((v) => v.requestId !== ev.result.requestId);
      return { ...state, snapshot: { ...s, verifications: [...rest, ev.result], activeVerificationId: ev.result.requestId } };
    }
    case "inbox.add":
      return { ...state, snapshot: { ...s, inbox: [ev.item, ...s.inbox] } };
    case "call.update": {
      const rest = s.calls.filter((c) => c.id !== ev.call.id);
      const active = ev.call.status === "ended" || ev.call.status === "failed" ? s.activeCallId : ev.call.id;
      return { ...state, snapshot: { ...s, calls: [...rest, ev.call], activeCallId: active ?? ev.call.id } };
    }
    case "call.transcript": {
      const calls = s.calls.map((c) => (c.id === ev.callId ? { ...c, transcript: [...c.transcript, ev.line] } : c));
      return { ...state, snapshot: { ...s, calls } };
    }
    case "negotiation.update": {
      const rest = s.negotiations.filter((n) => n.id !== ev.negotiation.id);
      return { ...state, snapshot: { ...s, negotiations: [...rest, ev.negotiation], activeNegotiationId: ev.negotiation.id } };
    }
    case "audit.add":
      return { ...state, snapshot: { ...s, audit: [ev.entry, ...s.audit].slice(0, 500) } };
    case "policy.update":
      return { ...state, snapshot: { ...s, policy: ev.policy } };
    case "network.update":
      return { ...state, snapshot: { ...s, network: ev.network } };
    case "phone.update":
      return { ...state, snapshot: { ...s, phone: ev.phone, mode: { ...s.mode, calls: ev.phone.paired && s.mode.provider === "app" ? "real" : s.mode.calls } } };
  }
  return state;
}

export function useCallsign() {
  const [state, dispatch] = useReducer(reduce, { connected: false });
  const retry = useRef<number>();

  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => dispatch({ type: "ws", connected: true });
      ws.onmessage = (m) => dispatch(JSON.parse(m.data) as ServerEvent);
      ws.onclose = () => {
        dispatch({ type: "ws", connected: false });
        if (!closed) retry.current = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry.current);
      ws?.close();
    };
  }, []);

  const post = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText);
    return r.json();
  };

  const s = state.snapshot;
  const activeVerification = s?.verifications.find((v) => v.requestId === s.activeVerificationId);
  const activeCall = s?.calls.find((c) => c.id === s.activeCallId);
  const activeNegotiation = s?.negotiations.find((n) => n.id === s.activeNegotiationId);
  /** The call the phone should be showing: ringing or in progress, newest first. */
  const liveCall = s?.calls
    .filter((c) => c.status === "ringing" || c.status === "in-progress" || c.status === "dialing")
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];

  return {
    connected: state.connected,
    snapshot: s,
    activeVerification,
    activeCall,
    activeNegotiation,
    liveCall,
    actions: {
      setPhone: (phone: string) => post<{ ok: boolean; masked: string }>("/demo/phone", { phone }),
      clearPhone: () => post("/demo/phone/clear"),
      impostor: (variant?: ImpostorVariant) => post("/demo/impostor", variant ? { variant } : undefined),
      brandCall: () => post("/demo/brand-call"),
      broadcast: () => post("/demo/broadcast"),
      reset: () => post("/demo/reset"),
      setPolicy: (patch: PolicyUpdateBody) => post<DoctorPolicy>("/policy", patch),
      proof: async (requestId: string) => (await fetch(`/api/proof/${encodeURIComponent(requestId)}`)).json() as Promise<ProofBundle>,
    },
    /** Used by the phone app (/phone). */
    phone: {
      register: (deviceName: string) => post<PhoneState>("/phone/register", { deviceName }),
      unregister: () => post<PhoneState>("/phone/unregister"),
      heartbeat: () => post("/phone/heartbeat"),
      answer: (callId: string) => post<PhoneTurnResponse>("/phone/answer", { callId }),
      decline: (callId: string) => post("/phone/decline", { callId }),
      turn: (callId: string, text: string) => post<PhoneTurnResponse>("/phone/turn", { callId, text }),
      hangup: (callId: string) => post("/phone/hangup", { callId }),
      session: async () => (await fetch("/api/phone/session")).json() as Promise<PhoneSessionResponse>,
      /** URL that returns audio/mpeg (ElevenLabs) or 204 (use speechSynthesis). */
      ttsUrl: (text: string) => `/api/phone/tts?text=${encodeURIComponent(text)}`,
    },
  };
}
