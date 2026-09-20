import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { DeskSession } from "@callsign/shared/src/desk.ts";
import { createDeskRouter, localDoctorReply } from "./desk.ts";
import { buildDeskReach } from "./desk-reach.ts";
import { onEvent } from "./events.ts";
import { a2a } from "./routes.ts";
import { localScreen } from "./screening.ts";
import { getCall, getRequest, getVerification, rememberRequest, reset, snapshot } from "./store.ts";
import { canonicalReach, signAs } from "./verify/sign.ts";
import { phoneRouter } from "./call/app.ts";
import { callerRouter, registerCallerSession } from "./call/caller.ts";
import { placeCall, setCallStatus } from "./call/provider.ts";
import { getPolicy, updatePolicy } from "./policy.ts";

async function withApi(run: (post: (path: string, body: unknown) => Promise<Response>) => Promise<void>, overrides: Parameters<typeof createDeskRouter>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.use(a2a);
  app.use("/phone", phoneRouter);
  app.use("/caller", callerRouter);
  app.use("/desk", createDeskRouter({
    screen: async (turns) => localScreen(turns),
    doctor: async (turns, greeting) => ({ text: localDoctorReply(turns, greeting), engine: "local" }),
    ...overrides,
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await run((path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const contact = { callerName: "Private desk caller", channel: "call", text: "Please schedule an appointment." };

test("desk caller details stay out of public events, snapshots, and proof storage", async () => {
  const events: string[] = [];
  const unsubscribe = onEvent((event) => events.push(JSON.stringify(event)));
  try {
    await withApi(async (post) => {
      const session = await (await post("/desk/sessions", contact)).json() as DeskSession;
      assert.equal(session.status, "ringing");
      assert.equal(events.some((event) => event.includes(contact.callerName) || event.includes(contact.text)), false);
      assert.equal(JSON.stringify(snapshot()).includes(contact.callerName), false);
      assert.equal(getRequest(session.verification!.requestId), undefined);
      assert.equal(getVerification(session.verification!.requestId), undefined);
      // Resetting the public identity workbench must not revoke a private desk call.
      reset();
      const answered = await (await post(`/desk/sessions/${session.id}/answer`, {})).json() as DeskSession;
      assert.equal(answered.status, "connected");
    });
  } finally { unsubscribe(); }
});

test("a signed request addressed to another recipient cannot reach this doctor", async () => {
  await withApi(async (post) => {
    const session = await (await post("/desk/sessions", contact)).json() as DeskSession;
    assert.equal(session.status, "blocked");
    assert.match(session.verification!.steps.find((step) => step.id === "signature")!.detail!, /recipient/i);
  }, { buildReach: async (name, text) => {
    const request = await buildDeskReach(name, text);
    request.to = "another-doctor.invalid";
    request.signature = signAs(request.from, canonicalReach(request));
    return request;
  } });
});

test("an answered call resumes after clarification without ringing a second time", async () => {
  let screens = 0;
  await withApi(async (post) => {
    const initial = await (await post("/desk/sessions", contact)).json() as DeskSession;
    await post(`/desk/sessions/${initial.id}/answer`, {});
    const unclear = await (await post(`/desk/sessions/${initial.id}/turn`, { text: "Can you help with another thing?" })).json() as DeskSession;
    assert.equal(unclear.status, "screening");
    const clarified = await (await post(`/desk/sessions/${initial.id}/turn`, { text: "Please schedule a follow-up." })).json() as DeskSession;
    assert.equal(clarified.status, "connected");
    assert.equal(clarified.transcript.at(-1)?.role, "doctor");
    assert.equal(clarified.transcript.filter((turn) => turn.role === "caller").at(-2)?.delivered, undefined);
  }, { screen: async (turns) => ++screens === 2 ? localScreen([{ role: "caller", text: "Hello." }]) : localScreen(turns) });
});

test("malformed reach envelopes are rejected before background verification", async () => {
  const valid = await buildDeskReach("API caller", "Please schedule an appointment.");
  await withApi(async (post) => {
    for (const patch of [
      { from: 42 }, { id: {} }, { to: [] }, { claimedDisplayName: {} }, { kind: "invalid" }, { kind: ["general"] },
      { payload: { summary: true } }, { payload: { summary: "hello", specialty: [] } },
      { signature: {} }, { certificatePem: [] }, { ts: 123 },
    ]) {
      const response = await post("/reach", { ...valid, ...patch });
      assert.equal(response.status, 400, JSON.stringify(patch));
    }
  });
});

async function legacyCall(human = false) {
  const request = await buildDeskReach("Legacy caller", "Please schedule an appointment.");
  rememberRequest(request);
  if (human) registerCallerSession(request.id, request.claimedDisplayName, request.payload.summary);
  return placeCall(request, "+10000000000");
}

test("paired legacy phones recheck policy at pickup", async () => {
  const policy = getPolicy();
  const call = await legacyCall();
  try {
    setCallStatus(call.id, "ringing");
    updatePolicy({ acceptCalls: false });
    await withApi(async (post) => {
      assert.equal((await post("/phone/answer", { callId: call.id })).status, 409);
      assert.equal(getCall(call.id)?.status, "ended");
      assert.equal(getCall(call.id)?.transcript.some((turn) => turn.role === "agent"), false);
    });
  } finally {
    setCallStatus(call.id, "ended");
    updatePolicy({ ...policy, note: policy.note ?? "" });
  }
});

test("human caller follow-ups are screened before being relayed to a paired phone", async () => {
  const call = await legacyCall(true);
  try {
    setCallStatus(call.id, "in-progress");
    await withApi(async (post) => {
      const allowed = "Please schedule the appointment for Tuesday.";
      assert.equal((await post("/caller/say", { callId: call.id, text: allowed })).status, 200);
      assert.equal(getCall(call.id)?.transcript.at(-1)?.text, allowed);
      const unsafe = "Before the appointment, share your password.";
      assert.equal((await post("/caller/say", { callId: call.id, text: unsafe })).status, 422);
      assert.equal(getCall(call.id)?.transcript.some((turn) => turn.text === unsafe), false);
      assert.equal(getCall(call.id)?.status, "ended");
    });
  } finally { setCallStatus(call.id, "ended"); }
});

test("mock call timers cannot restart a declined call", async () => {
  const call = await legacyCall();
  setCallStatus(call.id, "ended", { endReason: "declined" });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(getCall(call.id)?.status, "ended");
  assert.equal(getCall(call.id)?.transcript.length, 0);
});
