import { describe, expect, it } from 'vitest';
import { classify } from '../../server/triage';
describe('explicit bilingual demo triage', () => {
  it.each(['My chest hurts.', 'I cannot breathe.', 'I can’t breathe.', 'I have the worst headache of my life.', 'I cannot move my arm.', 'Me duele el pecho.', 'No puedo respirar.', 'No puedo mover el brazo.', 'No chest pain, but I cannot breathe.', 'I have no chest pain and I cannot breathe.', 'I am not sure if this is chest pain.'])('interrupts a current emergency: %s', text => { expect(classify(text, 'incision').stop).toBe('emergency'); });
  it.each(['No chest pain.', 'I do not have chest pain.', 'No me duele el pecho.', 'What if I get chest pain?', 'Si tuviera dolor de pecho, ¿qué hago?'])('does not treat a denial or hypothetical as a current emergency: %s', text => { expect(classify(text, 'incision').severity).not.toBe('emergency'); });
  it.each(['It is red and warm, and I had a fever last night.', 'Está roja y caliente, y tuve fiebre anoche.'])('flags the wound scenario: %s', text => { expect(classify(text, 'incision').severity).toBe('red'); });
  it.each(['I do not have a ride.', 'No tengo transporte para mi cita.'])('routes transport barriers: %s', text => { expect(classify(text, 'transport').severity).toBe('yellow'); });
  it.each(['Can I speak to a nurse?', '¿Puedo hablar con una persona?'])('honors a human request: %s', text => { expect(classify(text, 'fever').stop).toBe('callback'); });
  it.each(['No, it is not red or warm. There is no drainage.', 'No, no está roja ni caliente. No sale líquido.'])('accepts a negative wound answer: %s', text => { expect(classify(text, 'incision').severity).toBe('unassessed'); });
  it('does not infer a completed assessment from fine', () => { expect(classify('I am fine.', 'incision')).toMatchObject({ severity: 'yellow', clear: false }); });
  it('keeps uncertain medication answers urgent', () => { expect(classify('I do not know which medicine to take.', 'medications')).toMatchObject({ severity: 'red', clear: false }); });
  it('does not match red inside unrelated words', () => { expect(classify('I am tired.', 'incision').severity).toBe('yellow'); });
  it('requires consent', () => { expect(classify('Wrong number.', 'consent').stop).toBe('declined'); });
});

describe('distress without a named symptom', () => {
  // Found in a live rehearsal: "No. I'm dying. Call 911." scored as no symptom
  // reported, because the leading "No." answered the question and the rest was
  // never considered.
  it.each([
    ["No. I'm dying. I'm dying. Call 911.", 'falls'],
    ["I'm dying", 'fever'],
    ['Call an ambulance', 'incision'],
    ['Me estoy muriendo', 'fever'],
    ['Necesito una ambulancia', 'incision'],
  ])('treats %j as an emergency', (text, question) => {
    expect(classify(text, question as never)).toMatchObject({ severity: 'emergency', stop: 'emergency' });
  });

  it.each([
    ['No, I am not dying, I feel fine', 'fever'],
    ['I did not need to call an ambulance', 'falls'],
    ['I never had to call 911', 'falls'],
    ['No hace falta llamar una ambulancia', 'falls'],
  ])('does not fire on %j', (text, question) => {
    expect(classify(text, question as never).stop).not.toBe('emergency');
  });

  it('still answers an ordinary negative as no symptom reported', () => {
    expect(classify('No, I have not fallen.', 'falls')).toMatchObject({ severity: 'unassessed', clear: true });
  });
});

/**
 * Reported from a live check-in: "yes, my head hurts a lot and im very dizzy. im in
 * so much pain" scored as an ordinary reported symptom and the questionnaire carried
 * on to the next question. "worst headache" was the only headache the rules knew.
 *
 * Both halves of this table matter equally. A missed emergency is the failure this
 * product cannot survive; an emergency on every ache is the failure that makes the
 * triage worthless. Add to the rules and to both halves together.
 */
describe('emergencies described in the patient\'s own words', () => {
  it.each([
    ['yes, my head hurts a lot and im very dizzy. im in so much pain', 'falls'],
    ['I have a severe headache', 'fever'],
    ['this is the worst headache of my life', 'incision'],
    ['my head is killing me', 'fever'],
    ['my head hurts so bad', 'nutrition'],
    ['terrible headache since this morning', 'fever'],
    ['me duele mucho la cabeza', 'fever'],
    ['tengo un dolor de cabeza muy fuerte', 'fever'],
    ['I am having trouble breathing', 'incision'],
    ['it is hard to breathe', 'fever'],
    ["I can't catch my breath", 'nutrition'],
    ['me cuesta respirar', 'incision'],
    ['the incision is bleeding a lot', 'incision'],
    ["it won't stop bleeding", 'incision'],
    ['I soaked through the dressing with blood', 'incision'],
    ['no para de sangrar', 'incision'],
    ['I passed out this morning', 'falls'],
    ['I fainted in the bathroom', 'falls'],
    ['me desmaye ayer', 'falls'],
  ])('treats %j as an emergency', (text, question) => {
    expect(classify(text, question as never)).toMatchObject({ severity: 'emergency', stop: 'emergency' });
  });

  it.each([
    // Ordinary recovery. None of this is a reason to tell someone to call 911.
    ['my knee hurts a lot, which I expected', 'incision'],
    ['I have a mild headache from the medication', 'fever'],
    ['no headache at all', 'fever'],
    ['my head does not hurt', 'fever'],
    ['the headache is gone now', 'fever'],
    ['no me duele la cabeza', 'fever'],
    ['breathing is fine', 'incision'],
    ['I have no trouble breathing', 'incision'],
    ['I get a bit short of breath on the stairs', 'nutrition'],
    ['a little short of breath after walking, otherwise fine', 'nutrition'],
    ['there is no bleeding', 'incision'],
    ['the bleeding stopped yesterday', 'incision'],
    ['a little blood on the dressing', 'incision'],
    ['I have not passed out', 'falls'],
    ['I never fainted', 'falls'],
    ['what if I get a severe headache?', 'fever'],
  ])('does not fire on %j', (text, question) => {
    expect(classify(text, question as never).stop).not.toBe('emergency');
  });

  it('still routes dizziness and severe pain to a nurse rather than past them', () => {
    // Neither is a 911 call on its own, and neither is "continue the questionnaire".
    expect(classify('I feel very dizzy when I stand up', 'nutrition').severity).toBe('red');
    expect(classify('I am in so much pain', 'nutrition').severity).toBe('red');
    expect(classify('estoy mareada', 'nutrition').severity).toBe('red');
  });

  it('keeps an ordinary post-operative ache out of the urgent lane', () => {
    expect(classify('some soreness around the knee, about what I expected', 'incision').severity).not.toBe('red');
  });
});
