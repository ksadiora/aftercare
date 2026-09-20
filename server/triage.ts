import type { QuestionId, Severity } from '../shared/types.js';
export interface Finding { severity: Severity; category: string; action: string; clear: boolean; stop?: 'emergency' | 'callback' | 'declined' }
const result = (severity: Severity, category: string, action: string, clear = true): Finding => ({ severity, category, action, clear });
export const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’]/g, "'");
/** One alternation built from several named groups, so each can carry its own reasoning. */
const union = (parts: RegExp[]) => new RegExp(parts.map(p => p.source).join('|'));
// Explicit, deliberately conservative demo rules. Not a validated clinical classifier.
export function classify(text: string, question: QuestionId): Finding {
  const t = normalize(text);
  const clauses = t.split(/[.!?;,]|\bbut\b|\bpero\b|\band\b|\by\b/).map(s => s.trim()).filter(Boolean);
  const emergency = union([
    // Grouped so each symptom can be read and argued about on its own. A patient in
    // trouble uses their own words, not one canonical phrase: "worst headache" alone
    // missed "my head hurts a lot and I'm very dizzy" in a live test. Each group has
    // a matching denial in `negatedEmergency`, and both are covered by the table in
    // tests/unit/triage.test.ts — add to both together or not at all.
    /chest (pain|hurts|hurt|pressure)|pain in (my |the )?chest|me duele el pecho|dolor (en el |de )pecho/,
    /can'?t breathe|cannot breathe|can not breathe|unable to breathe|(trouble|difficulty|struggling|hard time) breathing|hard to breathe|can'?t catch my breath|short(ness)? of breath|no puedo respirar|me cuesta respirar|dificultad para respirar|falta de aire/,
    // Sudden severe headache after discharge is a bleed until a clinician says otherwise.
    /worst head ?ache|(severe|terrible|horrible|awful|excruciating|blinding|pounding|splitting|really bad|very bad) head ?ache|head ?ache (is )?(so|really|very) bad|my head (is )?(killing me|pounding|splitting)|my head hurts? (a lot|so much|so bad|so badly|really bad|really badly|badly|terribly)|peor dolor de cabeza|dolor de cabeza (muy )?(fuerte|severo|terrible|horrible|insoportable)|me duele (mucho|muchisimo) la cabeza/,
    /can'?t move (my |the )?arm|cannot move (my |the )?arm|no puedo mover (el |mi )brazo/,
    // Oozing at the incision is expected; these all describe bleeding that is not.
    /(bleeding|blood).{0,25}(a lot|heavily|won'?t stop|will not stop|soaked|soaking|pouring|gushing)|(soaked|soaking|drenched|pouring|gushing).{0,30}(blood|bleeding|dressing|bandage|gauze)|won'?t stop bleeding|bleeding through|sangrando mucho|no para de sangrar|hemorragia/,
    /passed out|passing out|fainted|blacked out|lost consciousness|me desmaye|perdi el conocimiento/,
    /i'?m dying|i am dying|me estoy muriendo|me muero/,
    /call (911|an ambulance|emergency)|llame? (al 911|una ambulancia|a una ambulancia)|necesito una ambulancia/,
  ]);
  const uncertainty = /not sure|don't know|do not know|maybe|might|possibly|unsure|cannot tell|can't tell|no se\b|no estoy segur|quizas|tal vez|creo que|not certain/;
  const hypothetical = /what if|if i (had|develop|get)|hypothetical|for example|si tuviera|por ejemplo|que pasa si/;
  // Denials are enumerated per symptom rather than as one rule about negation words,
  // because "cannot breathe" and "can't move my arm" are themselves negations. A
  // general "a negative word appeared" test would silently swallow the emergency.
  const negatedEmergency = union([
    /\b(no|without|deny|denies)\b.{0,30}(chest|dolor)|don't have.{0,20}(chest|pain)|do not have.{0,20}(chest|pain)|chest (doesn't|does not) hurt|no me duele el pecho/,
    /(not|isn'?t|am not) dying|no me estoy muriendo/,
    /(did ?n'?t|did not|do ?n'?t|do not|no need|never|no hace falta|no necesito)\b.{0,25}(call|ambulance|911|llamar|ambulancia)/,
    /\b(no|not|without)\b.{0,15}head ?ache|(do|does) ?n'?t have.{0,15}head ?ache|head ?ache (is )?(gone|better|mild|slight)|head (doesn'?t|does not) hurt|sin dolor de cabeza/,
    /\bno\b.{0,10}(bleeding|blood)|(is |am |it'?s )?not bleeding|(bleeding|blood) (has )?stopped|no (hay )?sangrado|no estoy sangrando/,
    /(did ?n'?t|did not|have ?n'?t|have not|has ?n'?t|has not|never)\b.{0,15}(pass(ed|ing)? out|faint(ed)?|black(ed)? out)|no me desmaye/,
    // Breathing is the one group where a softener changes the answer: "a bit short of
    // breath on the stairs" is recovery, "I can't catch my breath" is not.
    /breathing (is )?(fine|ok|okay|normal|good)|\b(no|not|without)\b.{0,15}(trouble|difficulty|problem|shortness)\b.{0,6}(breathing|breath)|(a little|a bit|slightly|mildly|only|somewhat)\b.{0,12}short(ness)? of breath|short(ness)? of breath.{0,25}(when i (walk|climb)|after (walking|climbing)|on the stairs|climbing stairs)/,
  ]);
  if (clauses.some(c => emergency.test(c) && !hypothetical.test(c) && !negatedEmergency.test(c))) {
    return { ...result('emergency', 'Emergency symptom', '911 instruction required · alert nurse immediately'), stop: 'emergency' };
  }
  if (/speak (to|with).*(person|human|nurse)|talk (to|with).*(person|human|nurse)|real person|call me back|hablar con.*(persona|enfermer)|llameme|llame de vuelta/.test(t)) {
    return { ...result('red', 'Human requested', 'Urgent nurse callback requested'), stop: 'callback' };
  }
  if (/stop (the |this )?(call|conversation)|don't (want|wish)|do not (want|wish)|wrong (person|number)|not (the|your) patient|no quiero|numero equivocado|persona equivocada|no soy (yo|el paciente)|pare (la |esta )?llamada/.test(t)) {
    return { ...result('yellow', 'Intake declined', 'Manual follow-up · intake incomplete', false), stop: 'declined' };
  }
  if (uncertainty.test(t)) return result(question === 'medications' ? 'red' : 'yellow', 'Unclear response', question === 'medications' ? 'Nurse callback · clarify discharge medications' : 'Nurse review today · clarify this response', false);
  const negative = /^(no\b|not\b)|\b(have not|haven't|has not|hasn't|no he|no me he)\b/;
  const positive = /^(yes\b|yeah\b|yep\b|si\b)|\bcorrect\b|\bof course\b|\bclaro\b/;
  // Not emergencies on their own, but they are never "continue the questionnaire"
  // either. Dizziness and severe pain after discharge belong in front of a nurse
  // today; the knee that hurts after a knee replacement is why pain stops at red.
  const urgent = union([
    /\b(red|redness|warm|warmth|draining|drainage|fever|fell|fallen|confused|confusion|rojo|roja|caliente|liquido|fiebre|caido|cai|confundido|confundida)\b|both.*(blood thinner|medic)/,
    /\b(dizzy|dizziness|lightheaded|light headed|mareado|mareada|mareo)\b/,
    /\b(so much|a lot of|severe|terrible|unbearable|excruciating|worst) pain\b|pain is (unbearable|terrible|severe|awful)|hurts? (so much|so bad|terribly)|mucho dolor|dolor (insoportable|severo|terrible)/,
  ]);
  const affirmUrgent = clauses.some(c => urgent.test(c) && !(/\b(no|not|without|neither|nor|ni|haven't|have not|has not)\b/.test(c)));
  if (question === 'consent') {
    if (positive.test(t)) return result('unassessed', 'Consent confirmed', 'Continue intake');
    return { ...result('yellow', 'Consent not confirmed', 'Manual follow-up · consent not confirmed', false), stop: 'declined' };
  }
  if (affirmUrgent) return result('red', 'Symptom or medication concern', 'Nurse callback · review reported symptoms (15 min demo target)');
  if (question === 'incision' || question === 'fever' || question === 'falls') {
    if (positive.test(t)) return result('red', 'Reported symptom', 'Nurse callback · review reported symptoms (15 min demo target)');
    if (negative.test(t) || /no (redness|warmth|drainage)|no esta|sin fiebre/.test(t)) return result('unassessed', 'No symptom reported', 'Continue intake');
  }
  if (question === 'medications') {
    if (/don't know what|do not know what|taking both|which.*(take|stop)|old.*new|no entiendo|cuales.*tomar/.test(t)) return result('red', 'Medication uncertainty', 'Nurse callback · clarify discharge medications');
    if (/not.*(fill|pick|collect)|haven't.*(fill|pick|collect)|cannot afford|can't afford|cost|expensive|pharmacy.*closed|no.*(recogi|recetas|comprar)|caro|costo/.test(t) || negative.test(t)) return result('yellow', 'Prescription access', 'Nurse review today · help access prescriptions');
    if (positive.test(t) && /understand|clear|know|entiendo|claro/.test(t)) return result('unassessed', 'Medications confirmed', 'Continue intake');
  }
  if (question === 'nutrition') {
    if (negative.test(t) || /not eating|not drinking|can't eat|cannot eat|no puedo comer|no puedo beber/.test(t)) return result('red', 'Eating or drinking concern', 'Nurse callback · review eating and drinking');
    if (positive.test(t) || /eating and drinking normally|comiendo y bebiendo normalmente/.test(t)) return result('unassessed', 'Nutrition confirmed', 'Continue intake');
  }
  if (question === 'transport') {
    if (negative.test(t) || /no (ride|transport)|don't have.*ride|do not have.*ride|can't get|cannot get|no tengo transporte/.test(t)) return result('yellow', 'Transportation barrier', 'Nurse review today · arrange appointment transportation');
    if (positive.test(t) || /taking me|will drive|va a llevar/.test(t)) return result('unassessed', 'Transport confirmed', 'Continue intake');
  }
  return result('yellow', 'Unclear response', 'Nurse review today · clarify this response', false);
}
