import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Store } from '../../server/store';
import { createApp } from '../../server/app';
import { reviewClarification } from '../../server/respond';
import type { GeminiConfig } from '../../server/gemini';

const gemini: GeminiConfig = { apiKey: 'test-gemini-key' };
const model = (clarification: string, rationale = 'The answer did not say whether the skin is red.', onTopic = true) =>
  new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ onTopic, clarification, rationale }) }] } }],
    modelVersion: 'gemini-2.5-flash-001', usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20 },
  }));

let store: Store;
let server: ReturnType<typeof createApp>;
const build = (fetcher?: typeof fetch, config = gemini) => {
  server?.close();
  server = createApp(store, { gemini: config, fetcher, simulationDelay: 10 });
  return server;
};
const startChat = (language = 'en') => request(server.app).post('/api/sessions').send({ patientId: 'alvarez', mode: 'chat', language });
const say = (id: string, text: string, eventId = `chat-${Math.random()}`) => request(server.app).post(`/api/sessions/${id}/message`).send({ eventId, text });
const CONSENT = 'Yes, that is me. You can continue.';
const audits = (kind: string) => store.detail('alvarez').audit.filter(a => a.kind === kind);

beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { server?.close(); store.close(); });

describe('clarification safety review', () => {
  const pass = (t: string, lang: 'en' | 'es' = 'en') => reviewClarification(t, lang, 'incision').ok;
  const why = (t: string, lang: 'en' | 'es' = 'en') => (reviewClarification(t, lang, 'incision') as { reason: string }).reason;

  it('accepts a plain single question in the session language', () => {
    expect(pass('When you look at the incision now, is the skin pink or bright red?')).toBe(true);
    expect(pass('¿Puede mirar la herida ahora y decirme de qué color está la piel?', 'es')).toBe(true);
  });

  it('rejects reassurance, diagnosis, treatment advice, and emergency instructions', () => {
    expect(why('Some redness is completely normal, but is it spreading?')).toContain('reassurance');
    expect(why('Does the wound look like it has an infection?')).toContain('diagnosis');
    expect(why('Did you take 500 mg of the antibiotic today?')).toContain('treatment advice');
    expect(why('Should I tell you to call 911 about the incision?')).toContain('emergency instruction');
    expect(why('This case is resolved, but how is the incision?')).toContain('case closure');
    expect(why('No se preocupe, ¿pero está roja la piel?', 'es')).toContain('reassurance');
  });

  it('rejects malformed, multi-part, and wrong-language output', () => {
    expect(why('Okay.')).toContain('length');
    expect(why('Please describe the skin around the incision in detail for me now.')).toContain('not phrased as a question');
    expect(why('Is it red? Is it warm?')).toContain('more than one question');
    expect(why('Is the skin around the incision red or warm?', 'es')).toContain('not written in Spanish');
    expect(why('¿Está roja la piel alrededor de la incisión?', 'en')).toContain('not written in English');
  });

  it('rejects a clarification that just repeats the scripted question', () => {
    expect(why('Is the skin around your incision red or warm, or is anything draining from it?')).toContain('identical');
  });
});

describe('adaptive intake with a mocked model', () => {
  it('refuses text chat when no key is configured instead of falling back to a script', async () => {
    build(undefined, {});
    const capabilities = await request(server.app).get('/api/capabilities');
    expect(capabilities.body.chat).toBe(false);
    expect(capabilities.body.chatReason).toContain('GEMINI_API_KEY');
    const started = await startChat();
    expect(started.status).toBe(503);
    expect(store.activeSession()).toBe(null);
  });

  it('asks one model clarification, holds the question, then resumes the script', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('When you look at the incision now, is the skin pink or bright red?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    expect(session.adaptive).toBe(true);

    await say(session.id, CONSENT);
    const unclear = await say(session.id, 'I am not sure, I cannot really tell.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(unclear.body.session.next.instruction).toBe('When you look at the incision now, is the skin pink or bright red?');
    // Held in place: still the incision question, not advanced to fever.
    expect(unclear.body.session.questionIndex).toBe(1);

    const answered = await say(session.id, 'No, it is not red or warm. There is no drainage.');
    expect(answered.body.session.questionIndex).toBe(2);
    // A second unclear answer to a later question gets one clarification of its own,
    // but the same question is never clarified twice.
    expect(store.session(session.id).clarified).toEqual(['incision']);
  });

  it('keeps the rule-based flag even when the clarified answer is benign', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('Is the skin pink, or is it bright red and hot?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'I am not sure.');
    await say(session.id, 'No, it is not red or warm. There is no drainage.');
    // The model rephrased the question; it never touched urgency.
    expect(store.patient('alvarez').severity).toBe('yellow');
    expect(store.patient('alvarez').disposition).toBe('open');
  });

  it('records the adaptive question and its model metadata in the audit trail', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('Can you tell me what colour the skin around the incision is today?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'I am not sure.');
    const entry = audits('adaptive_question')[0];
    expect(entry.text).toContain('colour the skin');
    expect(entry.text).toContain('gemini-2.5-flash-001');
  });

  it('never consults the model for an emergency and never delays the 911 instruction', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('unused'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    const emergency = await say(session.id, 'Actually, my chest hurts and I cannot breathe.');
    expect(fetcher).not.toHaveBeenCalled();
    expect(emergency.body.session.next.instruction).toContain('911');
    expect(emergency.body.session.status).toBe('emergency');
    expect(store.patient('alvarez').severity).toBe('emergency');
  });

  it('falls back to the scripted question when the model fails, without completing intake', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    const unclear = await say(session.id, 'I am not sure.');
    expect(unclear.body.session.next.instruction).toContain('incision');
    expect(unclear.body.session.next.done).toBe(false);
    expect(store.session(session.id).status).toBe('active');
    expect(store.patient('alvarez').severity).toBe('yellow');
    expect(audits('adaptive_skipped')[0].text).toContain('quota');
  });

  it('discards an unsafe clarification and asks the scripted question instead', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('That redness is completely normal, but is it spreading?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    const unclear = await say(session.id, 'I am not sure.');
    expect(unclear.body.session.next.instruction).not.toContain('normal');
    expect(unclear.body.session.next.instruction).toContain('incision');
    expect(audits('adaptive_skipped')[0].text).toContain('reassurance');
  });

  it('discards a model result that arrives after the conversation moved on', async () => {
    let release: (value: Response) => void = () => {};
    const fetcher = vi.fn().mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    const pending = say(session.id, 'I am not sure.').then(r => r);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    store.finish(session.id, 'interrupted', 'Participant left.');
    release(model('Is the skin around the wound bright red today?'));
    await pending;
    expect(store.session(session.id).status).toBe('interrupted');
    expect(store.session(session.id).next.instruction).not.toContain('bright red');
    expect(audits('adaptive_skipped')[0].text).toContain('moved on');
  });

  it('never sends a simulation to the provider', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('unused'));
    build(fetcher as unknown as typeof fetch);
    const started = await request(server.app).post('/api/sessions').send({ patientId: 'alvarez', mode: 'simulation', language: 'en', scenario: 'wound' });
    expect(started.body.adaptive).toBe(false);
    await vi.waitFor(() => expect(store.activeSession()).toBe(null));
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.patient('alvarez').severity).toBe('red');
  });

  it('runs a full Spanish chat intake and documents the outcome', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('¿De qué color está la piel alrededor de la herida hoy?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat('es');
    const script = ['Sí, soy yo. Puede continuar.', 'No, no está roja ni caliente. No sale líquido.', 'No, no he tenido fiebre.', 'Sí, recogí todas las recetas y entiendo qué tomar.', 'No, no me he caído.', 'Sí, estoy comiendo y bebiendo normalmente.', 'Sí, mi hija me va a llevar.'];
    let last;
    for (const [index, text] of script.entries()) last = await say(session.id, text, `chat-${index}`);
    expect(fetcher).not.toHaveBeenCalled();
    expect(last!.body.session.next.done).toBe(true);
    expect(last!.body.session.status).toBe('completed');
    expect(store.patient('alvarez')).toMatchObject({ severity: 'green', contactStatus: 'Outreach documented' });
    const turns = store.detail('alvarez').turns;
    expect(turns.filter(t => t.role === 'agent')).toHaveLength(script.length + 1);
    expect(turns.every(t => t.language === 'es')).toBe(true);
  });

  it('deduplicates a resubmitted chat message without advancing the intake', async () => {
    build(vi.fn() as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT, 'chat-0');
    const repeat = await say(session.id, CONSENT, 'chat-0');
    expect(repeat.body.duplicate).toBe(true);
    expect(store.session(session.id).questionIndex).toBe(1);
    expect(store.detail('alvarez').turns).toHaveLength(3);
  });
});

describe('probing follow-ups on a flagged answer', () => {
  it('asks a follow-up when the patient reports something concerning', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('Is the redness spreading past the edges of the incision, or staying in one spot?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    const flagged = await say(session.id, 'It is red and warm, and I had a fever last night.');

    // The model was asked to probe, not to rephrase.
    const sent = JSON.parse(String((fetcher.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.systemInstruction.parts[0].text).toContain('follow-up question');
    expect(sent.contents[0].parts[0].text).toContain('raised a concern');

    expect(flagged.body.session.next.instruction).toContain('spreading past the edges');
    expect(flagged.body.session.questionIndex).toBe(1);
    expect(store.patient('alvarez').severity).toBe('red');
    expect(audits('adaptive_question')[0].text).toContain('probe');
  });

  it('cannot undo the flag when the follow-up answer sounds reassuring', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('Is the redness spreading past the edges of the incision?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'It is red and warm, and I had a fever last night.');
    await say(session.id, 'No, it is not spreading at all.');
    // Severity is monotonic: a calmer follow-up never walks a concern back.
    expect(store.patient('alvarez').severity).toBe('red');
    expect(store.session(session.id).severity).toBe('red');
    expect(store.patient('alvarez').disposition).toBe('open');
  });

  it('counts a question once even when it is asked twice', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('Is the redness spreading past the edges of the incision?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'It is red and warm, and I had a fever last night.');
    await say(session.id, 'No, it is not spreading.');
    const answers = store.session(session.id).answers;
    expect(answers).toEqual([...new Set(answers)]);
    expect(answers.filter(q => q === 'incision')).toHaveLength(1);
  });

  it('still probes at most once per question', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('Is the redness spreading past the edges of the incision?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'It is red and warm, and I had a fever last night.');
    await say(session.id, 'It still looks red to me.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.session(session.id).questionIndex).toBe(2);
  });

  it('never probes an emergency and never delays the 911 instruction', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('unused'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    const emergency = await say(session.id, 'My chest hurts and I cannot breathe.');
    expect(fetcher).not.toHaveBeenCalled();
    expect(emergency.body.session.next.instruction).toContain('911');
  });

  it('does not probe a clean answer', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('unused'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'No, it is not red or warm. There is no drainage.');
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.session(session.id).questionIndex).toBe(2);
  });
});

describe('answering a follow-up', () => {
  it('does not tell the patient it failed to understand a descriptive follow-up answer', async () => {
    const fetcher = vi.fn().mockResolvedValue(model('What does the redness look like right now, and how large is the area?'));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'It is red and warm, and I had a fever last night.');
    const detail = await say(session.id, 'It started yesterday and it is about the size of a quarter.');
    // Free-text detail is not a failed re-answer.
    expect(detail.body.session.next.instruction).not.toContain('could not clearly assess');
    expect(detail.body.session.next.instruction).toContain('fever');
    // The detail is still on the record for the nurse, and the flag still stands.
    expect(store.detail('alvarez').turns.some(t => t.text.includes('size of a quarter'))).toBe(true);
    expect(store.patient('alvarez').severity).toBe('red');
  });

  it('still says so when an answer to a normal scripted question is unreadable', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }));
    build(fetcher as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    await say(session.id, 'I am not sure.');
    const second = await say(session.id, 'Hard to say really.');
    expect(second.body.session.next.instruction).toContain('could not clearly assess');
  });
});

describe('compound and treatment-adjacent probes', () => {
  const why = (t: string) => { const r = reviewClarification(t, 'en', 'fever'); return r.ok ? 'ACCEPTED' : r.reason; };

  it('rejects two asks hidden behind a single question mark', () => {
    expect(why('Did you take anything to bring your temperature down, and did it work?')).not.toBe('ACCEPTED');
    expect(why('Is the area warm, and has it changed since yesterday?')).toContain('two questions');
  });

  it('still allows a single question that continues with how or what', () => {
    expect(why('What does the redness look like right now, and how large is the area?')).toBe('ACCEPTED');
  });

  it('rejects asking the patient to judge whether a remedy worked', () => {
    expect(why('Did you take anything for the fever?')).toContain('treatment self-assessment');
    expect(why('Did that help at all?')).toContain('treatment self-assessment');
    expect(reviewClarification('¿Tomó algo para la fiebre?', 'es', 'fever')).toMatchObject({ ok: false });
  });

  it('still allows a plain observable follow-up', () => {
    expect(why('How high was your temperature when you last checked it?')).toBe('ACCEPTED');
    expect(why('When did you first notice the fever?')).toBe('ACCEPTED');
  });
});

describe('a probe that cannot be asked must not strand the questionnaire', () => {
  const flag = async (id: string) => {
    await say(id, CONSENT);
    return say(id, 'It is red and warm, and I had a fever last night.');
  };

  it('moves on when the model says there is no sensible follow-up', async () => {
    build(vi.fn().mockResolvedValue(model('unused', 'off topic', false)) as unknown as typeof fetch);
    const { body: session } = await startChat();
    const after = await flag(session.id);
    // Advanced to fever rather than re-asking about the incision.
    expect(after.body.session.questionIndex).toBe(2);
    expect(after.body.session.next.instruction).toContain('fever');
    expect(audits('adaptive_skipped')[0].text).toContain('moved on');
  });

  it('moves on when the follow-up is rejected by the safety review', async () => {
    build(vi.fn().mockResolvedValue(model('Did you take anything for the fever?')) as unknown as typeof fetch);
    const { body: session } = await startChat();
    const after = await flag(session.id);
    expect(after.body.session.questionIndex).toBe(2);
    expect(after.body.session.next.instruction).not.toContain('incision');
    expect(audits('adaptive_skipped')[0].text).toContain('treatment self-assessment');
  });

  it('moves on when the model is unavailable', async () => {
    build(vi.fn().mockResolvedValue(new Response('{}', { status: 429 })) as unknown as typeof fetch);
    const { body: session } = await startChat();
    const after = await flag(session.id);
    expect(after.body.session.questionIndex).toBe(2);
    // The concern the rules found is untouched by any of this.
    expect(store.patient('alvarez').severity).toBe('red');
  });

  it('a failed rephrase still re-asks, because that answer was never understood', async () => {
    build(vi.fn().mockResolvedValue(new Response('{}', { status: 429 })) as unknown as typeof fetch);
    const { body: session } = await startChat();
    await say(session.id, CONSENT);
    const unclear = await say(session.id, 'I am not sure.');
    expect(unclear.body.session.questionIndex).toBe(1);
    expect(unclear.body.session.next.instruction).toContain('incision');
  });
});
