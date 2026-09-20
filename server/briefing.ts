import type { PatientDetail, QuestionId, Turn } from '../shared/types.js';
import { severityLabels } from '../shared/types.js';
import { questionIds, questions } from '../shared/protocol.js';
import { briefingModel, generateJson, geminiCapability, type GeminiConfig, type Schema } from './gemini.js';
import { AppError, modeLabel } from './store.js';

export const NOT_ESTABLISHED = 'Not established in this conversation.';

export interface Citation { turnId: string; role: 'agent' | 'user'; text: string }
export interface Statement { text: string; citations: Citation[] }
export interface Briefing {
  patientId: string; sessionId: string; draft: true; generatedAt: string; model: string;
  reason: string; statements: Statement[];
  quote: { original: string; language: string; englishTranslation: string | null } | null;
  answered: QuestionId[]; unanswered: QuestionId[];
  timeline: { at: string; text: string }[];
}

const statementSchema: Schema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'One factual sentence about what the patient reported.' },
    turns: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the transcript lines that support this sentence.' },
  },
  required: ['text', 'turns'],
};
const briefingSchema: Schema = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'One sentence: why this case is in front of the nurse now.' },
    statements: { type: 'array', items: statementSchema },
    englishTranslation: { type: 'string', nullable: true, description: 'English translation of the quoted line, or an empty string if it is already English.' },
  },
  required: ['reason', 'statements'],
};
const answerSchema: Schema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    turns: { type: 'array', items: { type: 'integer' } },
    grounded: { type: 'boolean', description: 'True only if the transcript directly supports the answer.' },
  },
  required: ['answer', 'turns', 'grounded'],
};

const system = `You brief a nurse on a completed post-discharge check-in with a synthetic demo patient.
Use ONLY the numbered transcript and chart facts given to you. Every sentence you write must cite the transcript line numbers that support it.
If the transcript does not establish something, say so rather than inferring it. Never diagnose, never recommend treatment or medication, never say a symptom is normal or expected, never state or imply that the case is handled or resolved. The nurse decides everything.
Write plainly for a busy clinician. Preserve the patient's own words when quoting; never translate inside a quotation you attribute to them.
Put line numbers only in the turns field. Never write bracketed numbers such as [3] inside your prose.`;

/** Numbered transcript plus deterministic chart facts. Numbers keep citations checkable. */
function context(detail: PatientDetail) {
  const session = detail.sessions[0];
  if (!session) throw new AppError(409, 'This patient has no check-in to brief yet.');
  const turns = detail.turns.filter(t => t.sessionId === session.id);
  if (!turns.length) throw new AppError(409, 'This check-in has no transcript to brief.');
  const answered = session.answers;
  const unanswered = questionIds.filter(q => !answered.includes(q));
  const lines = turns.map((t, i) => `[${i + 1}] ${t.role === 'agent' ? 'Aftercare' : detail.patient.name}: ${t.text}`);
  const facts = [
    `Patient: ${detail.patient.name}, age ${detail.patient.age}, ${detail.patient.language === 'es' ? 'Spanish' : 'English'} preferred.`,
    `Procedure: ${detail.patient.procedure}. Discharged ${detail.patient.dischargeDate.slice(0, 10)}.`,
    `Check-in mode: ${modeLabel(session.mode)}. Outcome recorded by the server: ${session.status}.`,
    `Server-assigned urgency: ${session.severity}. Nurse disposition: ${detail.patient.disposition}.`,
    `Questions the server recorded as answered: ${answered.length ? answered.join(', ') : 'none'}.`,
    `Questions left unanswered: ${unanswered.length ? unanswered.join(', ') : 'none'}.`,
    ...detail.observations.filter(o => o.sessionId === session.id).map(o => `Server flag: ${o.category} (${o.severity}).`),
  ];
  return { session, turns, answered, unanswered, lines, facts };
}

/** Line numbers are an internal device; the UI shows real source lines instead. */
const stripMarkers = (text: string) => text.replace(/\s*\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\]/g, '').replace(/\s+([.,;:!?])/g, '$1').trim();

/** Drops any statement whose citations are missing or invented. */
function cite(numbers: unknown, turns: Turn[]): Citation[] {
  if (!Array.isArray(numbers)) return [];
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const raw of numbers) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 1 || index > turns.length) continue;
    const turn = turns[index - 1];
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    citations.push({ turnId: turn.id, role: turn.role, text: turn.text });
  }
  return citations;
}

export async function generateBriefing(detail: PatientDetail, config: GeminiConfig, fetcher?: typeof fetch): Promise<Briefing> {
  if (!geminiCapability(config).enabled) throw new AppError(503, geminiCapability(config).reason);
  const { session, turns, answered, unanswered, lines, facts } = context(detail);
  const userTurns = turns.filter(t => t.role === 'user');
  const flagged = detail.patient.quote ? userTurns.find(t => t.text === detail.patient.quote) : undefined;
  const lastUser = flagged ?? userTurns.at(-1);
  const { value, meta } = await generateJson<{ reason: string; statements: { text: string; turns: number[] }[]; englishTranslation?: string }>(config, {
    system,
    user: [
      'Chart facts:', ...facts, '',
      'Numbered transcript:', ...lines, '',
      detail.patient.language === 'es' && lastUser ? `Also translate this line into English for the nurse, labelled as a translation: "${lastUser.text}"` : '',
      'Write the reason this case needs review, then 2 to 4 factual statements, each citing its transcript line numbers.',
    ].filter(Boolean).join('\n'),
    schema: briefingSchema,
    timeoutMs: 15000,
    model: briefingModel(config),
  }, fetcher);

  const statements = value.statements
    .map(s => ({ text: stripMarkers(String(s.text || '')), citations: cite(s.turns, turns) }))
    // A statement the transcript cannot support does not reach the nurse.
    .filter(s => s.text.length > 0 && s.citations.length > 0)
    .slice(0, 4);

  const translation = detail.patient.language === 'es' ? String(value.englishTranslation || '').trim() : '';
  return {
    patientId: detail.patient.id, sessionId: session.id, draft: true,
    generatedAt: new Date().toISOString(), model: meta.model,
    reason: stripMarkers(String(value.reason || '')) || NOT_ESTABLISHED,
    statements,
    quote: lastUser ? { original: lastUser.text, language: lastUser.language, englishTranslation: translation || null } : null,
    answered, unanswered,
    timeline: detail.audit.filter(a => a.sessionId === session.id || a.patientId === detail.patient.id)
      .slice(0, 12).reverse().map(a => ({ at: a.createdAt, text: a.text })),
  };
}

export async function answerCaseQuestion(detail: PatientDetail, question: string, config: GeminiConfig, fetcher?: typeof fetch) {
  if (!geminiCapability(config).enabled) throw new AppError(503, geminiCapability(config).reason);
  const { turns, lines, facts } = context(detail);
  const { value, meta } = await generateJson<{ answer: string; turns: number[]; grounded: boolean }>(config, {
    system,
    user: [
      'Chart facts:', ...facts, '',
      'Numbered transcript:', ...lines, '',
      `The nurse asks: ${question}`,
      'Answer only from the transcript above. If it does not establish an answer, set grounded to false.',
    ].join('\n'),
    schema: answerSchema,
    timeoutMs: 15000,
    model: briefingModel(config),
  }, fetcher);
  const citations = cite(value.turns, turns);
  // The guarantee is ours, not the model's: no citations means no claim.
  const grounded = value.grounded === true && citations.length > 0;
  return {
    question,
    answer: grounded ? stripMarkers(String(value.answer || '')) || NOT_ESTABLISHED : NOT_ESTABLISHED,
    citations: grounded ? citations : [],
    grounded, model: meta.model, draft: true as const,
  };
}

/**
 * What the intake rules already know, in a few sentences, with no model involved.
 *
 * Used when an escalation needs a summary and the model cannot give one. It is
 * recorded under its own attribution — never passed off as the model's work —
 * because the rule here is that a failed integration says so rather than quietly
 * substituting a script. A provider opening the case still gets the severity, the
 * patient's own words and what was never asked.
 */
export function ruleSummary(detail: PatientDetail): string {
  const patient = detail.patient;
  const session = detail.sessions[0];
  const parts = [`${severityLabels[patient.severity]} on the intake rules.`];
  if (!session) {
    parts.push('No check-in has been recorded for this patient yet, so there is nothing from a conversation to summarise.');
    return parts.join(' ');
  }
  const unanswered = questionIds.filter(q => !session.answers.includes(q));
  parts.push(`${modeLabel(session.mode)} ended as ${session.status}.`);
  if (patient.quote) parts.push(`The patient said: “${patient.quote}”`);
  parts.push(unanswered.length
    ? `${unanswered.length} of ${questionIds.length} questions went unanswered: ${unanswered.join(', ')}.`
    : 'Every intake question was answered.');
  return parts.join(' ');
}

export const briefingQuestionLabels = (): Record<QuestionId, string> =>
  Object.fromEntries(questionIds.map(q => [q, questions.en[q]])) as Record<QuestionId, string>;
