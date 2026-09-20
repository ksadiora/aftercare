import { describe, expect, it } from 'vitest';
import { BARGE_IN, createBargeInGate, createMicMeter } from '../../src/barge-in';

/** Feed a run of identical samples at the call's real sampling interval. */
const run = (gate: ReturnType<typeof createBargeInGate>, level: number, ms: number, from: number) => {
  let at = from;
  for (; at < from + ms; at += 60) gate.feed(level, at);
  return at;
};

const SPEECH = 0.12;      // a person talking at a normal volume, one arm's length from a laptop
const ROOM = 0.004;       // a quiet room with the agent playing through speakers and echo cancellation on
const KNOCK_MS = 60;      // a table tap, a chair creak — energetic but over almost at once

describe('barge-in gate', () => {
  it('ignores a knock, however loud', () => {
    const gate = createBargeInGate();
    let at = run(gate, ROOM, 600, 0);
    at = run(gate, 0.9, KNOCK_MS, at);
    expect(gate.open).toBe(false);
    run(gate, ROOM, 600, at);
    expect(gate.open).toBe(false);
  });

  it('ignores a burst of separate knocks that never join up', () => {
    const gate = createBargeInGate();
    let at = 0;
    for (let i = 0; i < 6; i++) { at = run(gate, 0.7, KNOCK_MS, at); at = run(gate, ROOM, 180, at); }
    expect(gate.open).toBe(false);
  });

  it('opens for someone actually speaking', () => {
    const gate = createBargeInGate();
    const at = run(gate, SPEECH, 300, 0);
    expect(gate.open).toBe(true);
    // Opening costs the participant roughly the attack window, not a whole word.
    expect(at).toBeLessThanOrEqual(BARGE_IN.attackMs + 120);
  });

  it('stays open across the gaps between words', () => {
    const gate = createBargeInGate();
    let at = run(gate, SPEECH, 300, 0);
    at = run(gate, ROOM, 300, at);            // a pause mid-sentence
    expect(gate.open).toBe(true);
    at = run(gate, SPEECH, 300, at);
    expect(gate.open).toBe(true);
  });

  it('closes again once they have finished', () => {
    const gate = createBargeInGate();
    let at = run(gate, SPEECH, 400, 0);
    expect(gate.open).toBe(true);
    at = run(gate, ROOM, BARGE_IN.releaseMs + 200, at);
    expect(gate.open).toBe(false);
  });

  it('starts every agent turn closed', () => {
    const gate = createBargeInGate();
    run(gate, SPEECH, 400, 0);
    expect(gate.open).toBe(true);
    gate.close();
    expect(gate.open).toBe(false);
    // And a knock straight after the reset still does not reopen it.
    run(gate, 0.9, KNOCK_MS, 1000);
    expect(gate.open).toBe(false);
  });

  it('reports no meter rather than throwing where Web Audio is missing', () => {
    // A browser we cannot measure leaves the microphone open: degraded barge-in
    // filtering is a smaller failure than a check-in that will not start.
    expect(createMicMeter({} as MediaStream)).toBeUndefined();
  });
});
