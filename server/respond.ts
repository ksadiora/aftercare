import type { Language, QuestionId, Session } from '../shared/types.js';
import { questions } from '../shared/protocol.js';
import { generateJson, geminiCapability, type GeminiConfig, type Schema } from './gemini.js';
import type { Store } from './store.js';

const schema: Schema = {
  type: 'object',
  properties: {
    onTopic: { type: 'boolean', description: 'False if the answer was not about the stated topic, or no sensible follow-up exists.' },
    clarification: { type: 'string', description: 'The single question to ask, in the requested language.' },
    rationale: { type: 'string', description: 'One short sentence explaining the choice.' },
  },
  required: ['onTopic', 'clarification', 'rationale'],
};

/** The probe is anchored to the question's subject, never to words in the answer. */
const topics: Record<QuestionId, string> = {
  consent: 'consent to continue',
  incision: 'the surgical incision and the skin around it',
  fever: 'fever or raised temperature',
  medications: 'collecting prescriptions and knowing which to take',
  falls: 'falling over since coming home',
  nutrition: 'eating and drinking',
  transport: 'getting to the follow-up appointment',
};

const shared = `The intake server has already recorded this answer and already decided its urgency. You have no role in that decision.
You must not: diagnose, name a condition, suggest a cause, give treatment or medication advice, say anything is normal or reassuring, mention emergency numbers or services, ask about a different topic, ask more than one question, or say the case is handled.
You are told the operation the patient had. When the topic is the wound, the skin, or moving
about, name the body part the operation was on — say "your knee" rather than "the incision" — so
the question sounds like it was written for this person. For topics unrelated to the site, such as
prescriptions or transport, do not force the operation in. Knowing the operation is never licence
to assess, explain, or advise on it or on recovery from it.
Ask about exactly one thing. Never join two questions with "and" or "or".
Never ask what the patient took for a symptom or whether a remedy helped; that is the nurse's assessment, not a question for the patient.
Write one short question in plain, warm language a 70-year-old can answer, in the requested language only.`;

const prompts = {
  // The rules could not read the answer: ask the same thing a different way.
  rephrase: `You rephrase ONE question for a post-discharge check-in with a synthetic demo patient.
Ask the SAME topic again, only for the observable detail the original question wanted.
${shared}`,
  // The answer raised a flag: ask for one more observable detail on that same topic,
  // so the nurse gets a better description. Not a new topic, not an assessment.
  probe: `You ask ONE follow-up question for a post-discharge check-in with a synthetic demo patient.
The patient has just reported something the nurse will need to understand better. Ask for one
concrete, observable detail about the site of their operation — what it looks like, where it is,
when it started, how it has changed, or whether they can describe it more exactly.
Your question MUST be about the stated TOPIC. Never take your subject from a stray word in the
patient's answer, and never assume something happened that the patient did not say happened.
If their answer was not really about that topic, or no useful follow-up exists, set onTopic to
false and do not invent a question.
Ask only what the patient can observe or recall themselves. Never imply what the answer means.
${shared}`,
};

// A schema-valid clarification can still be clinically unsafe, so meaning is checked
// separately. Each rule names itself so a rejection is explainable in the audit trail.
const forbidden: { label: string; pattern: RegExp }[] = [
  { label: 'reassurance', pattern: /\b(is|it's|its|that's|thats|sounds|seems|es|suena)\s+(completely\s+|perfectly\s+|totally\s+|muy\s+)?normal\b|don'?t worry|nothing to worry|no se preocupe|no hay (nada )?de qu[eé] preocupar/i },
  { label: 'diagnosis', pattern: /\b(infection|infected|infecci[oó]n|infectad|sepsis|blood clot|co[aá]gulo|dehiscence|necrosis|abscess|absceso)\b/i },
  { label: 'treatment advice', pattern: /\b(you should take|you can take|take \d|stop taking|deje de tomar|deber[ií]a tomar|puede tomar|dosage|dose of|dosis|\d+\s?mg|antibiotic|antibi[oó]tico|painkiller|analg[eé]sico)\b/i },
  // Asking whether a remedy worked invites the patient to self-assess treatment,
  // and a nurse can read the answer as reassurance. Not ours to ask.
  { label: 'treatment self-assessment', pattern: /\b(take|taken|taking) (anything|something|any medicine|any medication|any pills?)\b|\bdid (it|that) (work|help)\b|\bbring (your|the) (temperature|fever) down\b|\btom[oó] algo\b|\ble ayud[oó]\b|\bfuncion[oó]\b/i },
  { label: 'emergency instruction', pattern: /\b911\b|emergency room|emergency services|urgencias|ambulance|ambulancia/i },
  { label: 'case closure', pattern: /\b(case (is )?(resolved|closed)|no further follow|caso (resuelto|cerrado)|todo est[aá] resuelto)\b/i },
];

export function reviewClarification(text: string, language: Language, question: QuestionId): { ok: true } | { ok: false; reason: string } {
  const value = text.trim();
  if (value.length < 8 || value.length > 300) return { ok: false, reason: 'length outside 8-300 characters' };
  if (!/[?？]/.test(value) && !/¿/.test(value)) return { ok: false, reason: 'not phrased as a question' };
  if ((value.match(/\?/g) || []).length > 1) return { ok: false, reason: 'more than one question' };
  for (const rule of forbidden) if (rule.pattern.test(value)) return { ok: false, reason: `contains ${rule.label}` };
  if (language === 'es' && !/[¿áéíóúñ]/i.test(value)) return { ok: false, reason: 'not written in Spanish' };
  if (language === 'en' && /¿/.test(value)) return { ok: false, reason: 'not written in English' };
  if (value === questions[language][question]) return { ok: false, reason: 'identical to the scripted question' };
  // One '?' can still hide two asks: "...down, and did it work?". A clause joined by
  // "and" that opens with an auxiliary verb is a second question. "or" is left alone:
  // it usually offers alternatives within one ask ("is it red, or is it pink?").
  if (/,\s*(and|y)\s+(did|do|does|is|are|was|were|has|have|had|can|could|will|would|should)\b/i.test(value)) {
    return { ok: false, reason: 'two questions joined into one' };
  }
  return { ok: true };
}

export type Kind = 'rephrase' | 'probe';

export function createResponder(store: Store, config: GeminiConfig, fetcher?: typeof fetch) {
  const pending = new Map<string, Promise<unknown>>();
  const note = (session: Session, text: string) => store.audit(session.patientId, session.id, 'adaptive_skipped', text, session.mode);

  async function work(session: Session, question: QuestionId, answer: string, kind: Kind) {
    const version = session.version;
    // A follow-up about "the incision" should sound like it knows where the incision is.
    const chart = store.patient(session.patientId, session.runId);
    try {
      const { value, meta } = await generateJson<{ onTopic: boolean; clarification: string; rationale: string }>(config, {
        system: prompts[kind],
        user: [
          `Language: ${session.language === 'es' ? 'Spanish' : 'English'}`,
          `Operation: ${chart.procedure}, ${Math.max(0, Math.floor((Date.now() - Date.parse(chart.dischargeDate)) / 86400000))} days ago`,
          `Original question: ${questions[session.language][question]}`,
          `Patient answered: "${answer}"`,
          `Topic: ${topics[question]}`,
          kind === 'rephrase'
            ? 'That answer did not clearly address the question. Rephrase the question once, about the topic above.'
            : 'That answer raised a concern the nurse will review. Ask one follow-up for a concrete observable detail about the topic above.',
        ].join('\n'),
        schema,
      }, fetcher);
      if (kind === 'probe' && value.onTopic === false) {
        note(session, 'No useful follow-up for that answer; the check-in moved on.');
        store.releaseProbe(session.id, version);
        return;
      }
      const review = reviewClarification(value.clarification, session.language, question);
      if (!review.ok) {
        note(session, `Adaptive follow-up rejected (${review.reason}). ${kind === 'probe' ? 'The check-in moved on.' : 'The scripted question was asked instead.'}`);
        if (kind === 'probe') store.releaseProbe(session.id, version);
        return;
      }
      const applied = store.applyClarification(session.id, version, value.clarification.trim(), `${kind}, ${meta.model}, ${meta.latencyMs}ms`);
      if (!applied) note(session, 'Adaptive follow-up discarded: the conversation moved on first. The scripted question was asked instead.');
    } catch (error) {
      // A model failure must never change intake state, and must never strand the
      // questionnaire re-asking a question the patient already answered.
      note(session, `Adaptive follow-up unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
      if (kind === 'probe') store.releaseProbe(session.id, version);
    }
  }

  return {
    enabled: () => geminiCapability(config).enabled,
    /** Fire-and-forget: the scripted question is already in place and remains valid. */
    clarify(session: Session, question: QuestionId, answer: string, kind: Kind = 'rephrase') {
      if (!geminiCapability(config).enabled) return;
      const task = work(session, question, answer, kind).finally(() => { if (pending.get(session.id) === task) pending.delete(session.id); });
      pending.set(session.id, task);
    },
    /** Await in-flight enrichment so a caller never reads a half-updated next step. */
    settle: (id: string) => pending.get(id) ?? Promise.resolve(),
    cancel: (id: string) => { pending.delete(id); },
  };
}
