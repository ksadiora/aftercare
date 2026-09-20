import test from "node:test";
import assert from "node:assert/strict";
import {
  freshState,
  sanitizeState,
  worldObjective,
  applyWorldAction,
} from "../dist/game.js";

const snapshot = (state) => structuredClone(state);
const reload = (state) => sanitizeState(JSON.parse(JSON.stringify(state)));

function assertNoChange(state, action) {
  const before = snapshot(state);
  const result = applyWorldAction(state, action);
  assert.equal(result.changed, false, `${action} must not advance progress`);
  assert.equal(result.reward, null, `${action} must not award a badge`);
  assert.deepEqual(state, before, `${action} must leave state unchanged`);
  return result;
}

test("bank requires two savings interactions and the useful item; rewards only once", () => {
  const state = freshState();
  assert.equal(worldObjective(state, "bank").target, "bank");
  assertNoChange(state, "helmet");
  assertNoChange(state, "stickers");

  assert.equal(applyWorldAction(state, "bank").changed, true);
  assert.equal(state.coins, 100);
  assert.equal(state.savings, 20);
  assert.equal(state.bankDeposited, false);
  assertNoChange(state, "helmet");

  applyWorldAction(state, "bank");
  assert.equal(state.coins + state.savings, 120, "saving conserves coins");
  assert.equal(state.savings, 40);
  assert.equal(worldObjective(state, "bank").target, "helmet");
  assertNoChange(state, "bank");
  assertNoChange(state, "stickers");

  assert.equal(applyWorldAction(state, "helmet").reward, "bank");
  assert.deepEqual(state.completed, ["bank"]);
  assert.equal(state.xp, 50);
  assert.equal(state.coins, 100);
  assertNoChange(state, "helmet");
  assert.equal(worldObjective(state, null).quest, "classroom");
  assert.equal(
    worldObjective(state, "bank").quest,
    "bank",
    "explicit tracking keeps a completed location selected",
  );
});

test("bank handles a low balance without negative coins and resumes after a pickup", () => {
  const state = freshState();
  state.savings = 35;
  state.coins = 3;
  applyWorldAction(state, "bank");
  assert.equal(state.coins, 0);
  assert.equal(state.savings, 38);
  assert.equal(state.bankDeposited, false);
  assertNoChange(state, "bank");
  applyWorldAction(state, "star-0");
  applyWorldAction(state, "bank");
  assert.equal(state.savings, 40);
  assert.equal(state.coins, 3, "only the remaining savings goal is deposited");
  assert.equal(state.bankDeposited, true);
});

test("planning advances only at the next physical station and finishes once", () => {
  const state = freshState();
  const steps = ["snack", "homework", "pack", "play"];
  for (const [index, step] of steps.entries()) {
    assert.equal(worldObjective(state, "classroom").target, `plan-${step}`);
    const wrongStep = steps[(index + 1) % steps.length];
    assertNoChange(state, `plan-${wrongStep}`);
    const result = applyWorldAction(state, `plan-${step}`);
    assert.equal(state.planStep, index + 1);
    assert.equal(result.changed, true);
    assert.equal(result.reward, index === 3 ? "classroom" : null);
    if (index < 3) assertNoChange(state, `plan-${step}`);
  }
  assert.deepEqual(state.plannerOrder, steps);
  assert.deepEqual(state.completed, ["classroom"]);
  assert.equal(state.coins, 140);
  assert.equal(state.xp, 50);
  for (const step of steps) assertNoChange(state, `plan-${step}`);
});

test("garden requires a watering can and an actual harvest before sharing", () => {
  const state = freshState();
  assert.equal(worldObjective(state, "garden").target, "garden");
  assertNoChange(state, "share");
  applyWorldAction(state, "garden");
  assert.equal(state.gardenStep, 1);
  assert.equal(worldObjective(state, "garden").target, "watering-can");
  assertNoChange(state, "garden");
  assertNoChange(state, "share");

  applyWorldAction(state, "watering-can");
  assert.equal(state.hasWateringCan, true);
  assertNoChange(state, "watering-can");
  assert.equal(worldObjective(state, "garden").target, "garden");
  applyWorldAction(state, "garden");
  assert.equal(state.gardenStep, 2);
  assertNoChange(state, "share");
  applyWorldAction(state, "garden");
  assert.equal(state.gardenStep, 3);
  assert.equal(worldObjective(state, "garden").target, "share");
  assert.equal(
    state.xp,
    0,
    "harvesting alone does not complete the community quest",
  );
  assertNoChange(state, "garden");

  assert.equal(applyWorldAction(state, "share").reward, "garden");
  assert.equal(state.xp, 50);
  assert.equal(state.coins, 140);
  assertNoChange(state, "share");
  assertNoChange(state, "garden");
});

test("collectibles award exactly once per ID, including after reload", () => {
  let state = freshState();
  for (const id of ["star-0", "star-1", "star-2"]) {
    const result = applyWorldAction(state, id);
    assert.equal(result.changed, true);
    assert.equal(result.reward, null);
    assertNoChange(state, id);
  }
  assert.equal(state.coins, 135);
  assert.equal(state.xp, 0);
  state = reload(state);
  for (const id of state.collectibles) assertNoChange(state, id);
  assert.deepEqual(state.collectibles, ["star-0", "star-1", "star-2"]);
});

test("reload preserves intermediate physical quest progress and objectives", () => {
  let state = freshState();
  for (const action of [
    "bank",
    "plan-snack",
    "plan-homework",
    "garden",
    "watering-can",
    "star-1",
  ]) {
    applyWorldAction(state, action);
  }
  const before = snapshot(state);
  state = reload(state);
  assert.deepEqual(state, before);
  assert.equal(worldObjective(state, "bank").target, "bank");
  assert.equal(worldObjective(state, "classroom").target, "plan-pack");
  assert.equal(worldObjective(state, "garden").target, "garden");
  assertNoChange(state, "star-1");

  for (const action of [
    "bank",
    "helmet",
    "plan-pack",
    "plan-play",
    "garden",
    "garden",
    "share",
  ]) {
    applyWorldAction(state, action);
  }
  state = reload(state);
  assert.deepEqual(state.completed, ["bank", "classroom", "garden"]);
  assert.equal(state.xp, 150);
  assert.equal(state.coins, 145);
  assert.equal(state.savings, 40);
  assert.equal(worldObjective(state, null).quest, null);
  assert.equal(worldObjective(state, null).target, "codi");
  assert.equal(worldObjective(state, "garden").quest, "garden");
  for (const action of ["helmet", "plan-play", "share"])
    assertNoChange(state, action);
});

test("sanitization supports older saves and removes invalid collectible IDs", () => {
  const oldSave = {
    version: 1,
    coins: 100,
    savings: 40,
    xp: 100,
    bankDeposited: true,
    completed: ["bank", "classroom"],
    plannerOrder: ["snack", "homework", "pack", "play"],
  };
  const old = sanitizeState(oldSave);
  assert.equal(old.planStep, 4);
  assert.equal(old.hasWateringCan, false);
  assert.deepEqual(old.collectibles, []);
  assert.equal(worldObjective(old, null).quest, "garden");
  assert.equal(worldObjective(old, "classroom").quest, "classroom");

  const dirty = sanitizeState({
    version: 1,
    planStep: -9,
    gardenStep: 99,
    collectibles: ["star-1", "star-1", "star-3", null, "star-2", 0],
    completed: ["bank", "not-a-quest", "bank"],
  });
  assert.equal(dirty.planStep, 0);
  assert.equal(dirty.gardenStep, 3);
  assert.deepEqual(dirty.collectibles, ["star-1", "star-2"]);
  assert.deepEqual(dirty.completed, ["bank"]);
  assert.equal(sanitizeState({ version: 1, planStep: "2" }).planStep, 0);
  assert.deepEqual(sanitizeState({ version: 999 }), freshState());
});

test("sanitization recovers an incomplete planner save beyond the last station", () => {
  const state = sanitizeState({ version: 1, planStep: 999, completed: [] });
  assert.equal(state.planStep, 3);
  assert.equal(worldObjective(state, "classroom").target, "plan-play");
  assert.equal(applyWorldAction(state, "plan-play").reward, "classroom");
  assert.equal(state.planStep, 4);
  assert.deepEqual(state.completed, ["classroom"]);
  assert.equal(
    reload(state).planStep,
    4,
    "completed progress remains completed",
  );
});

test("invalid actions cannot mutate progress or issue rewards", () => {
  const state = freshState();
  for (const action of [
    "unknown",
    "plan-sleep",
    "star-3",
    "star--1",
    "",
    null,
    undefined,
    {},
    0,
  ]) {
    const before = snapshot(state);
    assert.throws(() => applyWorldAction(state, action));
    assert.deepEqual(state, before);
  }
  assert.equal(worldObjective(state, "unknown").target, "bank");
});
