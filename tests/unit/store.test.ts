import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../server/store';
import { responses } from '../../shared/protocol';
import type { Language, ScenarioId } from '../../shared/types';
let store: Store;
beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => store.close());
function run(scenario: ScenarioId, language: Language = 'en') {
  const s = store.start('alvarez', 'simulation', language, scenario);
  responses[language][scenario].forEach((text, i) => store.ingest(s.id, String(i), 'user', text));
  return store.finish(s.id, scenario === 'interrupted' ? 'interrupted' : 'completed');
}
describe('persistent intake and nurse workflow', () => {
  it('seeds three featured patients within a cohort of forty', () => { expect(store.dashboard().patients).toHaveLength(40); expect(store.dashboard().patients.filter(p => p.featured)).toHaveLength(3); });
  it.each(['en', 'es'] as const)('preserves exact wound evidence in %s and never resolves automatically', language => {
    run('wound', language); const detail = store.detail('alvarez');
    expect(detail.patient.severity).toBe('red'); expect(detail.patient.disposition).toBe('open');
    expect(detail.observations.some(o => o.quote === responses[language].wound[1])).toBe(true);
    expect(detail.patient.quote).toBe(responses[language].wound[1]);
    expect(detail.turns.some(t => t.text === responses[language].wound[1] && t.language === language)).toBe(true);
  });
  it.each(['en', 'es'] as const)('only completes a fully answered recovery intake in %s', language => { run('recovery', language); expect(store.patient('alvarez')).toMatchObject({ severity: 'green', disposition: 'open', contactStatus: 'Outreach documented' }); });
  it('incomplete sessions never become green', () => { run('interrupted'); expect(store.patient('alvarez')).toMatchObject({ severity: 'yellow', lastContact: null }); });
  it('emergency ends the script and prevents further questions', () => {
    const s = store.start('alvarez', 'simulation', 'en', 'emergency');
    store.ingest(s.id, '1', 'user', 'Yes, that is me. You can continue.');
    const next = store.ingest(s.id, '2', 'user', 'My chest hurts.');
    expect(next.session.next).toMatchObject({ done: true, reason: 'emergency' });
    expect(next.session.next.instruction).toContain('call 911');
    expect(() => store.ingest(s.id, '3', 'user', 'No fever')).toThrow('intake has ended');
    expect(store.finish(s.id, 'interrupted').status).toBe('emergency');
  });
  it('deduplicates a repeated delivery without advancing questions', () => {
    const s = store.start('alvarez', 'simulation', 'en', 'wound');
    store.ingest(s.id, 'same', 'user', 'Yes, continue.'); store.ingest(s.id, 'same', 'user', 'Yes, continue.');
    expect(store.session(s.id).questionIndex).toBe(1); expect(store.detail('alvarez').turns.filter(t => t.role === 'user')).toHaveLength(1);
  });
  it('rejects simultaneous sessions and resetting an active session', () => {
    store.start('alvarez', 'simulation', 'en', 'wound');
    expect(() => store.start('johnson', 'simulation', 'en', 'recovery')).toThrow('already active'); expect(() => store.reset()).toThrow('End the active');
  });
  it('requires a note for resolution and keeps the audit', () => {
    expect(() => store.action('johnson', 'resolve', ' ')).toThrow('Add a note');
    store.action('johnson', 'resolve', 'Ride arranged with daughter.');
    expect(store.detail('johnson').audit[0]).toMatchObject({ actor: 'Demo nurse', text: 'Ride arranged with daughter.' });
    expect(store.patient('johnson').disposition).toBe('resolved');
  });
  it('new concern reopens a resolved case without deleting the nurse note', () => {
    store.action('alvarez', 'resolve', 'Reviewed earlier.'); run('wound');
    expect(store.patient('alvarez').disposition).toBe('open'); expect(store.detail('alvarez').audit.some(e => e.text === 'Reviewed earlier.')).toBe(true);
  });
  it('a later uneventful call cannot clear an unresolved concern', () => { run('wound'); run('recovery'); expect(store.patient('alvarez').severity).toBe('red'); });
  it('green quotations use real patient text instead of an AI summary', () => { run('recovery'); expect(store.patient('alvarez').quote).toBe(responses.en.recovery.at(-1)); });
  it('reset preserves previous sessions and actions in history', () => {
    run('wound'); store.action('alvarez', 'escalate', 'On-call nurse notified in demonstration.'); const oldRun = store.runId;
    store.reset(); expect(store.patient('alvarez').severity).toBe('unassessed');
    expect(store.history(oldRun).events.some(e => e.kind === 'escalate')).toBe(true); expect(store.history().runs).toHaveLength(2);
  });
  it('sorts unresolved emergencies before urgent concerns and resolved cases last', () => { run('emergency'); store.action('johnson', 'resolve', 'Transport arranged.'); const list = store.dashboard().patients; expect(list[0].id).toBe('alvarez'); expect(list.at(-1)?.id).toBe('johnson'); });
  it('recovers an interrupted voice session after process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aftercare-test-')); const path = join(dir, 'test.sqlite');
    const first = new Store(path); first.start('alvarez', 'voice', 'en', null); first.close();
    const second = new Store(path); expect(second.activeSession()).toBe(null); expect(second.patient('alvarez').contactStatus).toBe('Intake incomplete'); second.close(); rmSync(dir, { recursive: true });
  });
});

describe('a clean run shows only what the demo produced', () => {
  it('starts every patient unassessed, with nothing pre-filled', () => {
    store.reset(false);
    const patients = store.dashboard().patients;
    expect(patients).toHaveLength(40);
    for (const p of patients) {
      expect(p.severity).toBe('unassessed');
      expect(p.disposition).toBe('open');
      expect(p.quote).toBe('');
      expect(p.lastContact).toBe(null);
      expect(p.contactStatus).toBe('Ready for check-in');
    }
    // The chart itself is still real: names, procedure, appointment, caregiver.
    const miguel = store.patient('alvarez');
    expect(miguel).toMatchObject({ name: 'Miguel Alvarez', language: 'es', procedure: 'Total knee replacement' });
    expect(miguel.medications.length).toBeGreaterThan(0);
  });

  it('makes all three featured patients due, so each has a link to send', () => {
    store.reset(false);
    expect(store.dueForOutreach().map(p => p.id).sort()).toEqual(['alvarez', 'chen', 'johnson']);
  });

  it('still offers the pre-filled worklist when asked for it', () => {
    store.reset(true);
    const patients = store.dashboard().patients;
    expect(patients.some(p => p.severity !== 'unassessed')).toBe(true);
    expect(patients.some(p => p.lastContact)).toBe(true);
  });

  it('a check-in on a clean run is the only thing that flags anyone', () => {
    store.reset(false);
    expect(store.dashboard().patients.filter(p => p.severity === 'red')).toHaveLength(0);
    run('wound');
    const flagged = store.dashboard().patients.filter(p => p.severity === 'red');
    expect(flagged.map(p => p.id)).toEqual(['alvarez']);
  });
});
