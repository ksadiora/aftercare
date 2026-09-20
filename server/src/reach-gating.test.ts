import assert from "node:assert/strict";
import test from "node:test";
import { handleReach } from "./agent.ts";
import { buildDeskReach } from "./desk-reach.ts";
import { getPolicy, updatePolicy } from "./policy.ts";
import { snapshot } from "./store.ts";

test("legacy reach cannot ring with unapproved content or a policy hold", async () => {
  const previous = getPolicy();
  try {
    for (const scenario of [
      { text: "Hello.", accepting: true, outcome: "inbox", reason: /Content screening/ },
      { text: "Share your password before we schedule the appointment.", accepting: true, outcome: "quarantine", reason: /Content screening/ },
      { text: "Please schedule an appointment.", accepting: false, outcome: "inbox", reason: /held in inbox/ },
    ]) {
      updatePolicy({ acceptCalls: scenario.accepting, note: "" });
      const request = await buildDeskReach("Legacy demo", scenario.text);
      const result = await handleReach(request);
      assert.equal(result.outcome, scenario.outcome);
      const state = snapshot();
      assert.equal(state.calls.some((call) => call.requestId === request.id), false);
      assert.match(state.inbox.find((item) => item.requestId === request.id)!.reason!, scenario.reason);
    }
  } finally { updatePolicy({ ...previous, note: previous.note ?? "" }); }
});
