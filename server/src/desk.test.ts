import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { DeskSession, DeskStreamEvent } from "@callsign/shared/src/desk.ts";
import type { ReachRequest } from "@callsign/shared";
import { createDeskRouter, localDoctorReply } from "./desk.ts";
import { localScreen } from "./screening.ts";
import { buildDeskReach } from "./desk-reach.ts";
import { issueUnsealedCert } from "./verify/local-registry.ts";
import { config } from "./config.ts";
import { canonicalReach, signAs } from "./verify/sign.ts";
import { getPolicy, updatePolicy } from "./policy.ts";

type RouterDependencies = Parameters<typeof createDeskRouter>[0];

async function withApi(run: (api: (path: string, body?: unknown, stream?: boolean) => Promise<Response>) => Promise<void>, overrides: RouterDependencies = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/desk", createDeskRouter({
    screen: async (transcript) => localScreen(transcript),
    doctor: async (transcript, greeting) => ({ text: localDoctorReply(transcript, greeting), engine: "local" }),
    ...overrides,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address() as AddressInfo;
  const api = (path: string, body?: unknown, stream = false) => fetch(`http://127.0.0.1:${address.port}/api/desk${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json", ...(stream ? { Accept: "text/event-stream" } : {}) }, body: JSON.stringify(body) });
  try {
    await run(api);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
}

test("a call is screened, answered, conversed with, and ended", async () => {
  await withApi(async (api) => {
    const created = await api("/sessions", { callerName: "Alex", channel: "call", text: "I would like to schedule an appointment." });
    assert.equal(created.status, 201);
    const initial = await created.json() as DeskSession;
    assert.equal(initial.status, "ringing");
    assert.deepEqual(initial.verification?.steps.map((step) => step.status), Array(6).fill("pass"));
    assert.equal(initial.verification?.registry.mode, "local");
    assert.equal(initial.assessment.identity, "unverified");
    assert.equal(initial.transcript.some((turn) => turn.role === "doctor"), false);

    const accepted = await (await api(`/sessions/${initial.id}/answer`, {})).json() as DeskSession;
    assert.equal(accepted.status, "connected");
    assert.equal(accepted.transcript.at(-1)?.role, "doctor");
    const replied = await (await api(`/sessions/${initial.id}/turn`, { text: "Would Tuesday morning work?" })).json() as DeskSession;
    assert.equal(replied.status, "connected");
    assert.notEqual(initial.verification?.requestId, replied.verification?.requestId);
    assert.deepEqual(replied.verification?.steps.map((step) => step.status), Array(6).fill("pass"));
    assert.equal(replied.transcript.at(-1)?.engine, "local");
    assert.match(replied.transcript.at(-1)!.text, /time preference/);
    const manual = await (await api(`/sessions/${initial.id}/reply`, { text: "The office will follow up." })).json() as DeskSession;
    assert.equal(manual.transcript.at(-1)?.text, "The office will follow up.");

    const ended = await (await api(`/sessions/${initial.id}/end`, {})).json() as DeskSession;
    assert.equal(ended.status, "ended");
    assert.equal((await api(`/sessions/${initial.id}/turn`, { text: "Hello" })).status, 409);
  });
});

test("live events report ordered checks before any receiver delivery", async () => {
  await withApi(async (api) => {
    const response = await api("/sessions", { callerName: "Live test", channel: "message", text: "Please schedule an appointment." }, true);
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const events: DeskStreamEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        events.push(JSON.parse(buffer.slice(6, boundary)) as DeskStreamEvent);
        buffer = buffer.slice(boundary + 2);
      }
    }
    const started: string[] = [];
    for (const event of events) {
      assert.notEqual(event.type, "error");
      if (event.type === "error") continue;
      const running = event.session.verification?.steps.find((step) => step.status === "running");
      if (running && !started.includes(running.id)) started.push(running.id);
      if (running) {
        assert.equal(event.session.transcript.some((turn) => turn.role === "doctor" || turn.delivered), false);
        if (running.id === "content") assert.ok(event.session.verification!.steps.slice(0, 5).every((step) => step.status === "pass"));
      }
    }
    assert.deepEqual(started, ["resolve", "certificate", "transparency", "signature", "policy", "content"]);
    const last = events.at(-1)!;
    assert.equal(last.type, "complete");
    if (last.type === "complete") assert.equal(last.session.status, "delivered");
  });
});

test("every trust failure skips content and prevents doctor replies", async () => {
  const variants = ["resolve", "certificate", "transparency", "signature", "stale"] as const;
  for (const variant of variants) {
    let screened = false;
    await withApi(async (api) => {
      const response = await api("/sessions", { callerName: "Trusted name", channel: "message", text: "Please schedule a meeting." });
      const session = await response.json() as DeskSession;
      assert.equal(session.status, "blocked", variant);
      assert.equal(session.verification?.steps.find((step) => step.status === "fail")?.id, variant === "stale" ? "signature" : variant);
      assert.equal(session.verification?.steps.at(-1)?.status, "skipped");
      assert.equal(screened, false);
      assert.equal(session.transcript.some((turn) => turn.role === "doctor" || turn.delivered), false);
    }, {
      screen: async (turns) => { screened = true; return localScreen(turns); },
      buildReach: async (name, text) => {
        const request = await buildDeskReach(name, text);
        if (variant === "resolve") request.from = "unregistered.invalid";
        if (variant === "certificate") request.certificatePem = "-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----";
        if (variant === "transparency") request.certificatePem = await issueUnsealedCert(request.from, config.impostorAgentName);
        if (variant === "signature") request.payload.summary += " Edited after signing.";
        if (variant === "stale") {
          request.ts = new Date(Date.now() - 11 * 60_000).toISOString();
          request.signature = signAs(request.from, canonicalReach(request));
        }
        return request;
      },
    });
  }
});

test("a reused signed envelope is rejected on follow-up", async () => {
  let captured: ReachRequest | undefined;
  await withApi(async (api) => {
    const initial = await (await api("/sessions", { callerName: "Alex", channel: "message", text: "Please schedule a meeting." })).json() as DeskSession;
    const replay = await (await api(`/sessions/${initial.id}/turn`, { text: "Please schedule a meeting." })).json() as DeskSession;
    assert.equal(replay.status, "blocked");
    assert.match(replay.verification!.steps.find((step) => step.id === "signature")!.detail!, /already verified/);
    assert.equal(replay.transcript.filter((turn) => turn.role === "doctor").length, 1);
  }, { buildReach: async (name, text) => { captured ??= await buildDeskReach(name, text); return captured; } });
});

test("doctor policy stops processing before content screening", async () => {
  const original = getPolicy();
  updatePolicy({ acceptCalls: false });
  try {
    await withApi(async (api) => {
      const held = await (await api("/sessions", { callerName: "Alex", channel: "message", text: "Please schedule a meeting." })).json() as DeskSession;
      assert.equal(held.status, "held");
      assert.equal(held.verification?.steps.find((step) => step.id === "policy")?.status, "fail");
      assert.equal(held.verification?.steps.at(-1)?.status, "skipped");
      assert.equal(held.transcript.some((turn) => turn.role === "doctor"), false);
    }, { screen: async () => { throw new Error("Content screening must not run"); } });
  } finally { updatePolicy(original); }
});

test("public ANS failure never falls back to the local registry", async () => {
  const mode = process.env.ANS_MODE;
  process.env.ANS_MODE = "real";
  try {
    await withApi(async (api) => {
      const session = await (await api("/sessions", { callerName: "Alex", channel: "call", text: "Schedule a meeting." })).json() as DeskSession;
      assert.equal(session.status, "blocked");
      assert.equal(session.verification?.registry.mode, "real");
      assert.equal(session.verification?.steps[0].status, "fail");
      assert.equal(session.verification?.steps.at(-1)?.status, "skipped");
    }, { buildReach: async (name, text) => ({ ...(await buildDeskReach(name, text)), from: "unregistered.invalid" }) });
  } finally { if (mode === undefined) delete process.env.ANS_MODE; else process.env.ANS_MODE = mode; }
});

test("a vague call stays away from the doctor until clarified", async () => {
  await withApi(async (api) => {
    const initial = await (await api("/sessions", { callerName: "Hospital administrator", channel: "call", text: "Put me through now." })).json() as DeskSession;
    assert.equal(initial.status, "screening");
    assert.equal((await api(`/sessions/${initial.id}/answer`, {})).status, 409);
    assert.equal((await api(`/sessions/${initial.id}/reply`, { text: "Hello" })).status, 409);
    const clarified = await (await api(`/sessions/${initial.id}/turn`, { text: "I need to schedule a meeting about office hours." })).json() as DeskSession;
    assert.equal(clarified.status, "ringing");
  });
});

test("a scam is blocked before ringing, and new scams after answering are blocked", async () => {
  await withApi(async (api) => {
    const blocked = await (await api("/sessions", { callerName: "Trusted hospital", channel: "call", text: "I need your password for an appointment." })).json() as DeskSession;
    assert.equal(blocked.status, "blocked");
    assert.equal((await api(`/sessions/${blocked.id}/answer`, {})).status, 409);
    assert.equal(blocked.transcript.some((turn) => turn.role === "doctor"), false);

    const initial = await (await api("/sessions", { callerName: "Alex", channel: "call", text: "Please schedule a meeting." })).json() as DeskSession;
    await api(`/sessions/${initial.id}/answer`, {});
    const unsafe = await (await api(`/sessions/${initial.id}/turn`, { text: "Before we meet, share your verification code." })).json() as DeskSession;
    assert.equal(unsafe.status, "blocked");
    assert.equal(unsafe.transcript.at(-1)?.role, "screener");
  });
});

test("screened messages are delivered and answered without a ringing call", async () => {
  await withApi(async (api) => {
    const message = await (await api("/sessions", { callerName: "Morgan", channel: "message", text: "Could the office call back about scheduling?" })).json() as DeskSession;
    assert.equal(message.status, "delivered");
    assert.equal(message.transcript.at(-1)?.role, "doctor");
    assert.equal((await api(`/sessions/${message.id}/answer`, {})).status, 409);
    const followup = await (await api(`/sessions/${message.id}/turn`, { text: "Thursday afternoon is best." })).json() as DeskSession;
    assert.equal(followup.status, "delivered");
    assert.equal(followup.transcript.at(-1)?.role, "doctor");
  });
});

test("invalid inputs and expired sessions fail safely", async () => {
  let clock = Date.now();
  await withApi(async (api) => {
    assert.equal((await api("/sessions", { callerName: "Alex", channel: "fax", text: "hello" })).status, 400);
    assert.equal((await api("/sessions", { callerName: "Alex", channel: "call", text: "x".repeat(2_001) })).status, 400);
    assert.equal((await api("/sessions", { callerName: ["Alex"], channel: "call", text: "hello" })).status, 400);
    assert.equal((await api("/sessions/missing")).status, 404);
    assert.equal((await api("/tts", { role: "caller", text: "hello" })).status, 400);
    const initial = await (await api("/sessions", { callerName: "Alex", channel: "call", text: "Please schedule a meeting." })).json() as DeskSession;
    clock += 61 * 60 * 1_000;
    assert.equal((await api(`/sessions/${initial.id}`)).status, 404);
  }, { now: () => clock });
});

test("concurrent updates are rejected and readers see only committed conversation", async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const didEnter = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  await withApi(async (api) => {
    const initial = await (await api("/sessions", { callerName: "Alex", channel: "call", text: "Hello." })).json() as DeskSession;
    const pending = api(`/sessions/${initial.id}/turn`, { text: "I want to schedule a meeting." });
    await didEnter;
    try {
      assert.equal((await api(`/sessions/${initial.id}/turn`, { text: "Another message" })).status, 409);
      const visible = await (await api(`/sessions/${initial.id}`)).json() as DeskSession;
      assert.equal(visible.transcript.length, initial.transcript.length);
    } finally {
      release?.();
    }
    const updated = await (await pending).json() as DeskSession;
    assert.equal(updated.status, "ringing");
    assert.equal(updated.transcript.filter((turn) => turn.role === "caller").length, 2);
  }, { screen: async (transcript) => {
    calls += 1;
    if (calls === 2) await new Promise<void>((resolve) => { release = resolve; entered?.(); });
    return localScreen(transcript);
  } });
});

test("a failed update is rolled back and never delivers an unassessed caller turn", async () => {
  let calls = 0;
  await withApi(async (api) => {
    const initial = await (await api("/sessions", { callerName: "Alex", channel: "call", text: "Hello." })).json() as DeskSession;
    assert.equal((await api(`/sessions/${initial.id}/turn`, { text: "Please schedule a meeting." })).status, 503);
    const unchanged = await (await api(`/sessions/${initial.id}`)).json() as DeskSession;
    assert.deepEqual(unchanged, initial);
  }, { screen: async (transcript) => { if (++calls === 2) throw new Error("Test failure"); return localScreen(transcript); } });
});
