import test from "node:test";
import assert from "node:assert/strict";
import {
  freshState,
  sanitizeState,
  deposit,
  completeQuest,
  validPlan,
  guideReply,
} from "../dist/game.js";

test("saving conserves money, rejects invalid deposits, and requires the first savings step", () => {
  const s = freshState();
  assert.throws(() => completeQuest(s, "bank"));
  for (const value of [0, -1, 121, 1.5, NaN, Infinity, "40"])
    assert.throws(() => deposit(s, value));
  assert.equal(s.coins, 120);
  deposit(s, 20);
  assert.equal(s.bankDeposited, false);
  deposit(s, 20);
  assert.equal(s.coins, 80);
  assert.equal(s.savings, 40);
  assert.equal(s.coins + s.savings, 120);
  assert.equal(s.bankDeposited, true);
});
test("every quest rewards exactly once and the full journey has consistent totals", () => {
  const s = freshState();
  deposit(s, 40);
  assert.equal(completeQuest(s, "bank"), true);
  assert.equal(completeQuest(s, "bank"), false);
  assert.equal(s.coins, 100);
  assert.equal(s.xp, 50);
  assert.throws(() => completeQuest(s, "classroom"));
  s.plannerOrder = ["snack", "homework", "pack", "play"];
  completeQuest(s, "classroom");
  assert.throws(() => completeQuest(s, "garden"));
  s.gardenStep = 3;
  completeQuest(s, "garden");
  assert.equal(s.xp, 150);
  assert.equal(s.coins, 140);
  assert.equal(s.savings, 40);
  assert.equal(s.completed.length, 3);
  for (const id of s.completed) assert.equal(completeQuest(s, id), false);
  assert.equal(s.coins, 140);
  assert.throws(() => completeQuest(s, "unknown"));
});
test("corrupt and incompatible saves fall back safely; valid progress survives serialization", () => {
  assert.deepEqual(sanitizeState(null), freshState());
  assert.deepEqual(sanitizeState({ version: 7 }), freshState());
  const dirty = sanitizeState({
    version: 1,
    coins: -10,
    savings: "1000",
    xp: Infinity,
    completed: ["garden", "garden", "fake"],
    plannerOrder: ["play", "play"],
    gardenStep: 99,
  });
  assert.equal(dirty.coins, 120);
  assert.equal(dirty.savings, 0);
  assert.equal(dirty.xp, 0);
  assert.deepEqual(dirty.completed, ["garden"]);
  assert.equal(dirty.gardenStep, 3);
  assert.equal(dirty.plannerOrder.length, 4);
  const s = freshState();
  deposit(s, 40);
  completeQuest(s, "bank");
  assert.deepEqual(sanitizeState(JSON.parse(JSON.stringify(s))), s);
});
test("planner enforces the scenario’s explicit dependencies", () => {
  assert.equal(validPlan(["snack", "homework", "pack", "play"]), true);
  assert.equal(validPlan(["snack", "pack", "homework", "play"]), false);
  assert.equal(validPlan([]), false);
});
test("guide handles ordinary questions without accidental AI keyword matches", () => {
  const s = freshState();
  assert.match(
    guideReply("Explain how I save coins", s),
    /saving|save|saving|coins/i,
  );
  assert.doesNotMatch(
    guideReply("Explain how I save coins", s),
    /No real bank/,
  );
  assert.match(guideReply("What is my daily plan?", s), /snack/);
  assert.match(guideReply("Are you AI?", s), /built-in/);
  assert.match(guideReply("What next?", s), /CapitalTwo Bank/);
});
