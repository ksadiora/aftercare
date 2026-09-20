import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { STEP_ORDER, type ReachRequest } from "@callsign/shared";
import type { DeskSession, DeskStreamEvent } from "@callsign/shared/src/desk.ts";
import { deskDeliveryApproved } from "@callsign/shared/src/desk-gate.ts";
import { createDeskRouter, localDoctorReply } from "./desk.ts";
import { buildDeskReach } from "./desk-reach.ts";
import { getPolicy, updatePolicy } from "./policy.ts";
import { localScreen } from "./screening.ts";
import { canonicalReach, signAs } from "./verify/sign.ts";

type Dependencies = Parameters<typeof createDeskRouter>[0];
async function withApi(run: (api: (path: string, body?: unknown, streaming?: boolean) => Promise<Response>) => Promise<void>, overrides: Dependencies = {}) {
  const policy = getPolicy();
  updatePolicy({ acceptCalls: true, specialtyOnly: true, requireReceipt: true, note: "" });
  const app = express();
  app.use(express.json());
  app.use(createDeskRouter({ screen: async (turns) => localScreen(turns), doctor: async (turns, greeting) => ({ text: localDoctorReply(turns, greeting), engine: "local" }), ...overrides }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run((path, body, streaming) => fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", ...(streaming ? { accept: "text/event-stream" } : {}) }, body: JSON.stringify(body) }));
  } finally {
    updatePolicy({ ...policy, note: policy.note ?? "" });
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
const contact = { callerName: "Demo caller", channel: "call", text: "Please schedule an appointment." };
const hasDoctor = (session: DeskSession) => session.transcript.some((turn) => turn.role === "doctor");

test("every verification, policy, and content step is mandatory for receiver delivery", async () => {
  await withApi(async (api) => {
    const session = await (await api("/sessions", contact)).json() as DeskSession;
    assert.equal(session.status, "ringing");
    assert.equal(deskDeliveryApproved(session), true);
    assert.equal(hasDoctor(session), false);
    for (const id of [...STEP_ORDER, "content"]) {
      for (const status of ["pending", "running", "fail", "skipped", "ask"] as const) {
        const altered = structuredClone(session);
        altered.verification!.steps.find((step) => step.id === id)!.status = status;
        assert.equal(deskDeliveryApproved(altered), false, `${id}/${status}`);
      }
      const missing = structuredClone(session);
      missing.verification!.steps = missing.verification!.steps.filter((step) => step.id !== id);
      assert.equal(deskDeliveryApproved(missing), false, `missing ${id}`);
    }
    const stale = structuredClone(session);
    stale.verification!.turnId = "another-turn";
    assert.equal(deskDeliveryApproved(stale), false);
    delete stale.verification;
    assert.equal(deskDeliveryApproved(stale), false);
  });
});

for (const attack of ["unsigned", "tampered", "wrong-key", "wrong-specialty"] as const) {
  test(`${attack} cannot ring or use answer/reply endpoints to bypass checks`, async () => {
    let screened = false;
    await withApi(async (api) => {
      const session = await (await api("/sessions", { ...contact, verified: true, status: "ringing", assessment: { decision: "allow" } })).json() as DeskSession;
      assert.equal(session.status, attack === "wrong-specialty" ? "held" : "blocked");
      assert.equal(screened, false);
      assert.equal(deskDeliveryApproved(session), false);
      assert.equal(hasDoctor(session), false);
      assert.equal((await api(`/sessions/${session.id}/answer`, {})).status, 409);
      assert.equal((await api(`/sessions/${session.id}/reply`, { text: "Bypass" })).status, 409);
    }, {
      screen: async (turns) => { screened = true; return localScreen(turns); },
      buildReach: async (name, text) => {
        const request = await buildDeskReach(name, text);
        if (attack === "unsigned") delete request.signature;
        if (attack === "tampered") request.payload.summary += " altered";
        if (attack === "wrong-key") request.signature = signAs("call-gating-rogue.invalid", canonicalReach(request));
        if (attack === "wrong-specialty") {
          request.payload.specialty = "Nephrology";
          request.signature = signAs(request.from, canonicalReach(request));
        }
        return request;
      },
    });
  });
}

test("a replayed signed request cannot create another ringing session", async () => {
  let request: ReachRequest | undefined;
  await withApi(async (api) => {
    assert.equal((await (await api("/sessions", contact)).json() as DeskSession).status, "ringing");
    const replayed = await (await api("/sessions", contact)).json() as DeskSession;
    assert.equal(replayed.status, "blocked");
    assert.match(replayed.verification!.steps.find((step) => step.id === "signature")!.detail!, /already verified/);
    assert.equal(hasDoctor(replayed), false);
  }, { buildReach: async (name, text) => request ??= await buildDeskReach(name, text) });
});

test("acceptCalls false gives an explained inbox hold without screening or doctor replies", async () => {
  let screened = false;
  await withApi(async (api) => {
    updatePolicy({ acceptCalls: false, note: "In a consultation" });
    const held = await (await api("/sessions", contact)).json() as DeskSession;
    assert.equal(held.status, "held");
    assert.match(held.holdReason!, /In a consultation.*held in inbox/i);
    assert.equal(screened, false);
    assert.equal(hasDoctor(held), false);
    assert.equal((await api(`/sessions/${held.id}/answer`, {})).status, 409);
  }, { screen: async (turns) => { screened = true; return localScreen(turns); } });
});

test("policy changes during screening prevent ringing and delivery", async () => {
  await withApi(async (api) => {
    const held = await (await api("/sessions", contact)).json() as DeskSession;
    assert.equal(held.status, "held");
    assert.match(held.holdReason!, /held in inbox/);
    assert.equal(hasDoctor(held), false);
    assert.equal(deskDeliveryApproved(held), false);
  }, { screen: async (turns) => { updatePolicy({ acceptCalls: false }); return localScreen(turns); } });
});

test("a policy change after ringing is enforced at pickup", async () => {
  await withApi(async (api) => {
    const initial = await (await api("/sessions", contact)).json() as DeskSession;
    assert.equal(initial.status, "ringing");
    updatePolicy({ acceptCalls: false, note: "Unavailable now" });
    const held = await (await api(`/sessions/${initial.id}/answer`, {})).json() as DeskSession;
    assert.equal(held.status, "held");
    assert.match(held.holdReason!, /Unavailable now/);
    assert.equal(hasDoctor(held), false);
    assert.equal((await api(`/sessions/${initial.id}/reply`, { text: "Should not pass" })).status, 409);
  });
});

test("policy changes during an asynchronous doctor reply discard that reply", async () => {
  await withApi(async (api) => {
    const initial = await (await api("/sessions", contact)).json() as DeskSession;
    const held = await (await api(`/sessions/${initial.id}/answer`, {})).json() as DeskSession;
    assert.equal(held.status, "held");
    assert.equal(hasDoctor(held), false);
  }, { doctor: async () => { updatePolicy({ acceptCalls: false }); return { text: "Must never be delivered", engine: "local" }; } });
});

test("policy changes revoke a ringing session on refresh and prevent manual replies", async () => {
  await withApi(async (api) => {
    const initial = await (await api("/sessions", contact)).json() as DeskSession;
    await api(`/sessions/${initial.id}/answer`, {});
    updatePolicy({ acceptCalls: false });
    const held = await (await api(`/sessions/${initial.id}/reply`, { text: "Must never arrive" })).json() as DeskSession;
    assert.equal(held.status, "held");
    assert.notEqual(held.transcript.at(-1)?.text, "Must never arrive");
  });
});

test("decline ends a verified call without invoking the simulated or manual doctor", async () => {
  await withApi(async (api) => {
    const initial = await (await api("/sessions", contact)).json() as DeskSession;
    const declined = await (await api(`/sessions/${initial.id}/decline`, {})).json() as DeskSession;
    assert.equal(declined.status, "ended");
    assert.equal(declined.endReason, "declined");
    assert.equal(hasDoctor(declined), false);
    assert.equal((await api(`/sessions/${initial.id}/answer`, {})).status, 409);
    assert.equal((await api(`/sessions/${initial.id}/turn`, { text: "Call me again" })).status, 409);
  });
});

test("streamed progress never advertises ringing before all approvals", async () => {
  await withApi(async (api) => {
    const response = await api("/sessions", contact, true);
    const events = (await response.text()).trim().split("\n\n").map((frame) => JSON.parse(frame.slice(6)) as DeskStreamEvent);
    assert.ok(events.some((event) => event.type === "progress" && event.session.verification?.steps.some((step) => step.status === "running")));
    for (const event of events) {
      if (event.type === "error") assert.fail(event.error);
      if (event.session.status === "ringing") assert.equal(deskDeliveryApproved(event.session), true);
      assert.equal(hasDoctor(event.session), false);
    }
    assert.equal(events.at(-1)?.type, "complete");
  });
});
