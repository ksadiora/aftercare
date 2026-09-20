import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { NOT_ESTABLISHED } from '../../server/briefing';
import { responses } from '../../shared/protocol';
import type { Language, ScenarioId } from '../../shared/types';

const gemini = { apiKey: 'test-gemini-key' };
const payload = (value: unknown) => new Response(JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
  modelVersion: 'gemini-2.5-flash-001', usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 60 },
}));

let store: Store;
let server: ReturnType<typeof createApp>;
const build = (fetcher?: typeof fetch) => { server?.close(); server = createApp(store, { gemini, fetcher, simulationDelay: 5 }); };
const brief = () => request(server.app).post('/api/patients/alvarez/briefing').send({});
const ask = (question: string) => request(server.app).post('/api/patients/alvarez/briefing/ask').send({ question });

function run(scenario: ScenarioId, language: Language = 'en') {
  const s = store.start('alvarez', 'voice', language, scenario);
  store.insertTurn(s, 'opening', 'agent', s.next.instruction);
  responses[language][scenario].forEach((text, i) => store.ingest(s.id, `t${i}`, 'user', text));
  return store.finish(s.id, 'completed');
}

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { server?.close(); store.close(); });

describe('clinician briefing', () => {
  it('refuses to brief a patient with no check-in yet', async () => {
    build(vi.fn() as unknown as typeof fetch);
    expect((await brief()).status).toBe(409);
  });

  it('returns source-linked statements with the deterministic question ledger', async () => {
    run('wound');
    const fetcher = vi.fn().mockResolvedValue(payload({
      reason: 'The patient described redness, warmth, and a fever after discharge.',
      statements: [
        { text: 'The patient reported the incision is red and warm.', turns: [3] },
        { text: 'The patient reported a fever the previous night.', turns: [3, 5] },
      ],
    }));
    build(fetcher as unknown as typeof fetch);
    const { body } = await brief();

    expect(body.draft).toBe(true);
    expect(body.model).toBe('gemini-2.5-flash-001');
    // The briefing asks for the stronger model, not the fast turn-time one.
    expect((fetcher.mock.calls[0] as [string])[0]).toContain('gemini-3.6-flash:generateContent');
    expect(body.reason).toContain('redness');
    expect(body.statements).toHaveLength(2);
    // Every citation resolves to a real stored turn.
    const ids = new Set(store.detail('alvarez').turns.map(t => t.id));
    for (const statement of body.statements) {
      expect(statement.citations.length).toBeGreaterThan(0);
      for (const citation of statement.citations) expect(ids.has(citation.turnId)).toBe(true);
    }
    // The ledger comes from the server, not the model. A red flag and a fully
    // answered questionnaire are independent facts, and both are reported.
    expect(body.answered).toHaveLength(7);
    expect(body.unanswered).toEqual([]);
  });

  it('reports the questions a cut-short check-in never reached', async () => {
    run('interrupted');
    const fetcher = vi.fn().mockResolvedValue(payload({
      reason: 'The check-in ended before the remaining questions were asked.',
      statements: [{ text: 'The patient confirmed the incision looked normal before contact was lost.', turns: [3] }],
    }));
    build(fetcher as unknown as typeof fetch);
    const { body } = await brief();
    expect(body.answered).toEqual(['consent', 'incision']);
    expect(body.unanswered).toEqual(['fever', 'medications', 'falls', 'nutrition', 'transport']);
  });

  it('drops statements that cite transcript lines which do not exist', async () => {
    run('wound');
    const fetcher = vi.fn().mockResolvedValue(payload({
      reason: 'Wound concern.',
      statements: [
        { text: 'Grounded: the patient reported redness.', turns: [3] },
        { text: 'Invented: the patient said they live alone.', turns: [99] },
        { text: 'Invented: the surgeon was called.', turns: [] },
        { text: 'Invented: a nurse visited today.', turns: ['nonsense'] },
      ],
    }));
    build(fetcher as unknown as typeof fetch);
    const { body } = await brief();
    expect(body.statements).toHaveLength(1);
    expect(body.statements[0].text).toContain('Grounded');
  });

  it('preserves Spanish wording and labels the English translation separately', async () => {
    run('wound', 'es');
    const fetcher = vi.fn().mockResolvedValue(payload({
      reason: 'Wound concern reported in Spanish.',
      statements: [{ text: 'The patient reported redness and warmth.', turns: [3] }],
      englishTranslation: 'Yes, my daughter is taking me.',
    }));
    build(fetcher as unknown as typeof fetch);
    const { body } = await brief();
    // The line that raised the flag, not whatever the patient happened to say last.
    expect(body.quote.original).toBe(responses.es.wound[1]);
    expect(body.quote.original).not.toBe(responses.es.wound.at(-1));
    expect(body.quote.language).toBe('es');
    expect(body.quote.englishTranslation).toBe('Yes, my daughter is taking me.');
    // The original is never overwritten by its translation.
    expect(body.quote.original).not.toBe(body.quote.englishTranslation);
  });

  it('headlines the flagged quote rather than the final pleasantry', async () => {
    run('transport');
    const fetcher = vi.fn().mockResolvedValue(payload({ reason: 'No ride to the appointment.', statements: [{ text: 'No transport arranged.', turns: [15] }] }));
    build(fetcher as unknown as typeof fetch);
    const { body } = await brief();
    expect(body.quote.original).toBe('I do not have a ride to my appointment.');
    expect(store.patient('alvarez').quote).toBe(body.quote.original);
  });

  it('caches per session version so repeated briefings do not spend quota', async () => {
    run('wound');
    const fetcher = vi.fn().mockResolvedValue(payload({ reason: 'Wound concern.', statements: [{ text: 'Redness reported.', turns: [3] }] }));
    build(fetcher as unknown as typeof fetch);
    await brief(); await brief(); await brief();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('answers a case question only from the transcript', async () => {
    run('wound');
    const fetcher = vi.fn().mockResolvedValue(payload({ answer: 'They said it is red and warm, and they had a fever last night.', turns: [3], grounded: true }));
    build(fetcher as unknown as typeof fetch);
    const { body } = await ask('What did the patient actually say about the incision?');
    expect(body.grounded).toBe(true);
    expect(body.answer).toContain('red and warm');
    expect(body.citations[0].text).toContain('red and warm');
  });

  it('says nothing was established rather than guessing, even if the model asserts an answer', async () => {
    run('wound');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(payload({ answer: 'The patient lives with their daughter.', turns: [], grounded: true }))
      .mockResolvedValueOnce(payload({ answer: 'Probably fine.', turns: [3], grounded: false }));
    build(fetcher as unknown as typeof fetch);
    // Claims with no citation are not claims.
    const uncited = await ask('Who does the patient live with?');
    expect(uncited.body.answer).toBe(NOT_ESTABLISHED);
    expect(uncited.body.citations).toEqual([]);
    // The model admitting it is ungrounded is honoured too.
    const ungrounded = await ask('Is the patient improving?');
    expect(ungrounded.body.answer).toBe(NOT_ESTABLISHED);
  });

  it('reports a model outage instead of inventing a briefing', async () => {
    run('wound');
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    build(fetcher as unknown as typeof fetch);
    const response = await brief();
    // Retried once for capacity, then surfaced honestly rather than fabricated.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(503);
    expect(response.body.error).toContain('oversubscribed');
    expect(response.body).not.toHaveProperty('statements');
  });

  it('refuses briefing endpoints when no key is configured', async () => {
    run('wound');
    server?.close(); server = createApp(store, { gemini: {} });
    expect((await brief()).status).toBe(503);
    expect((await ask('What happened?')).status).toBe(503);
  });

  it('rejects an empty case question', async () => {
    run('wound');
    build(vi.fn() as unknown as typeof fetch);
    expect((await ask('  ')).status).toBe(400);
  });
});

describe('citation markers stay out of nurse-facing prose', () => {
  it('strips inline line numbers the model writes into its sentences', async () => {
    run('wound');
    const fetcher = vi.fn().mockResolvedValue(payload({
      reason: 'The incision is red and warm [3], with a fever [5].',
      statements: [{ text: 'The patient reported redness [3].', turns: [3] }],
    }));
    build(fetcher as unknown as typeof fetch);
    const { body } = await brief();
    expect(body.reason).toBe('The incision is red and warm, with a fever.');
    expect(body.statements[0].text).toBe('The patient reported redness.');
    // The real source lines are still attached.
    expect(body.statements[0].citations).toHaveLength(1);
  });

  it('strips them from a case answer too', async () => {
    run('wound');
    build(vi.fn().mockResolvedValue(payload({ answer: 'They said "it is red and warm" [3, 5].', turns: [3], grounded: true })) as unknown as typeof fetch);
    const { body } = await ask('What did they say?');
    expect(body.answer).toBe('They said "it is red and warm".');
  });
});

/**
 * A provider should never open a case with nothing but "please advise". The nurse's
 * own words are optional on an escalation; an automated summary is not, and the two
 * are recorded separately so neither can be mistaken for the other.
 */
describe('escalation carries both the nurse note and an automated summary', () => {
  const escalate = (note: string) => request(server.app).post('/api/patients/alvarez/actions').send({ action: 'escalate', note });
  const queued = async () => (await request(server.app).get('/api/provider/queue')).body[0];
  const summaryPayload = () => payload({
    reason: 'The patient described redness, warmth, and a fever after discharge.',
    statements: [{ text: 'The patient reported the incision is red and warm.', turns: [3] }],
  });

  it('keeps both when the nurse writes one', async () => {
    run('wound');
    build(vi.fn().mockResolvedValue(summaryPayload()) as unknown as typeof fetch);
    expect((await escalate('Please advise on antibiotics today.')).status).toBe(200);

    const item = await queued();
    expect(item.reason).toBe('Please advise on antibiotics today.');
    expect(item.summary).toContain('redness, warmth');
    expect(item.summarySource).toContain('gemini');

    // Two entries, two actors: the audit trail never blends them into one voice.
    const audit = (await request(server.app).get('/api/patients/alvarez')).body.audit;
    expect(audit.find((a: { kind: string }) => a.kind === 'escalate')).toMatchObject({ actor: 'Demo nurse' });
    expect(audit.find((a: { kind: string }) => a.kind === 'escalation_summary').actor).toContain('Aftercare');
  });

  it('accepts a blank note and sends the summary alone', async () => {
    run('wound');
    build(vi.fn().mockResolvedValue(summaryPayload()) as unknown as typeof fetch);
    expect((await escalate('')).status).toBe(200);

    const item = await queued();
    // Empty, not a stand-in sentence dressed up as something the nurse wrote.
    expect(item.reason).toBe('');
    expect(item.summary).toContain('redness, warmth');
    expect(store.patient('alvarez').disposition).toBe('escalated');
  });

  it('writes the summary from the intake rules, and says so, when the model cannot', async () => {
    run('wound');
    build(vi.fn().mockResolvedValue(new Response('{}', { status: 429 })) as unknown as typeof fetch);
    expect((await escalate('')).status).toBe(200);

    const item = await queued();
    expect(item.summarySource).toContain('intake rules');
    expect(item.summarySource).toContain('quota');
    // Still useful: severity, the patient's own words, and what was never asked.
    expect(item.summary).toContain('Urgent review');
    expect(item.summary).toContain('red and warm');
    expect(item.summary).toMatch(/questions went unanswered|Every intake question/);
  });

  it('summarises a patient who has no check-in at all rather than failing', async () => {
    build(vi.fn() as unknown as typeof fetch);
    expect((await request(server.app).post('/api/patients/johnson/actions').send({ action: 'escalate', note: '' })).status).toBe(200);
    const item = (await request(server.app).get('/api/provider/queue')).body[0];
    expect(item.summary).toContain('No check-in has been recorded');
    expect(item.summarySource).toContain('intake rules');
  });

  it('still refuses to close a case without the nurse saying why', async () => {
    run('wound');
    build(vi.fn() as unknown as typeof fetch);
    expect((await request(server.app).post('/api/patients/alvarez/actions').send({ action: 'resolve', note: '  ' })).status).toBe(400);
  });

  it('spends one model call, not two, when the provider then opens the briefing', async () => {
    run('wound');
    const fetcher = vi.fn().mockResolvedValue(summaryPayload());
    build(fetcher as unknown as typeof fetch);
    await escalate('Please advise.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The escalation warmed the cache the provider's briefing reads.
    expect((await brief()).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
