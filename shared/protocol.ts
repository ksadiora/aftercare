import type { Language, QuestionId, ScenarioId } from './types.js';
export const questionIds: QuestionId[] = ['consent', 'incision', 'fever', 'medications', 'falls', 'nutrition', 'transport'];
export const questions: Record<Language, Record<QuestionId, string>> = {
  en: {
    consent: 'Hello, this is Aftercare, an automated follow-up demo. This conversation is transcribed for the demo nurse; audio is not recorded. You can ask for a person at any time. Are you the intended demo participant, and is it okay to continue?',
    incision: 'Is the skin around your incision red or warm, or is anything draining from it?',
    fever: 'Have you had a fever since you got home?',
    medications: 'Did you pick up all your prescriptions, and is it clear which medicines you should take?',
    falls: 'Have you fallen since you got home?',
    nutrition: 'Are you eating and drinking normally?',
    transport: 'Do you have a way to get to your follow-up appointment?',
  },
  es: {
    consent: 'Hola, soy Aftercare, una demostración automatizada de seguimiento. Esta conversación se transcribe para la enfermera de demostración; no se graba el audio. Puede pedir hablar con una persona en cualquier momento. ¿Es usted el participante de la demostración y está de acuerdo en continuar?',
    incision: '¿La piel alrededor de la incisión está roja o caliente, o sale algún líquido?',
    fever: '¿Ha tenido fiebre desde que llegó a casa?',
    medications: '¿Recogió todas sus recetas y tiene claro qué medicamentos debe tomar?',
    falls: '¿Se ha caído desde que llegó a casa?',
    nutrition: '¿Está comiendo y bebiendo normalmente?',
    transport: '¿Tiene transporte para su cita de seguimiento?',
  },
};
export const messages = {
  en: {
    emergency: 'Please hang up and call 911 right now. I am flagging this for the demo nurse.',
    callback: 'I have requested an urgent callback from the demo nurse. This browser demo cannot transfer you to a person. I will end the intake here.',
    handoff: 'I am asking the demo nurse to join this conversation now. Please stay on this page. I will stop here so a person can take over.',
    declined: 'Thank you. I will stop here and record that the intake was not completed.',
    completed: 'Thank you for answering. Your responses are documented for the demo nurse to review. This completes the check-in.',
    review: 'I have flagged your responses for the demo nurse to review. Thank you for taking this check-in.',
    clarify: 'I could not clearly assess that answer. I will flag it for the demo nurse to review.',
  },
  es: {
    emergency: 'Por favor, cuelgue y llame al 911 ahora mismo. Estoy avisando a la enfermera de demostración.',
    callback: 'He solicitado que la enfermera de demostración le devuelva la llamada con urgencia. Esta demostración en el navegador no puede transferirle a una persona. Terminaré las preguntas aquí.',
    handoff: 'Le voy a pedir a la enfermera de demostración que se una a esta conversación ahora. Por favor, permanezca en esta página. Me detengo aquí para que una persona continúe.',
    declined: 'Gracias. Me detendré aquí y registraré que no se completó la entrevista.',
    completed: 'Gracias por responder. Sus respuestas están documentadas para que las revise la enfermera de demostración. Hemos terminado la llamada de seguimiento.',
    review: 'He marcado sus respuestas para que las revise la enfermera de demostración. Gracias por responder.',
    clarify: 'No pude evaluar claramente esa respuesta. La marcaré para que la revise la enfermera de demostración.',
  },
};
export const responses: Record<Language, Record<ScenarioId, string[]>> = {
  en: {
    wound: ['Yes, that is me. You can continue.', 'It is red and warm, and I had a fever last night.', 'Yes, I had a fever last night.', 'Yes, I picked up all my prescriptions and understand them.', 'No, I have not fallen.', 'Yes, I am eating and drinking normally.', 'Yes, my daughter is taking me.'],
    emergency: ['Yes, that is me. You can continue.', 'It is red and warm, and I had a fever last night.', 'Actually, my chest hurts and I cannot breathe.'],
    transport: ['Yes, that is me. You can continue.', 'No, it is not red or warm. There is no drainage.', 'No, I have not had a fever.', 'Yes, all prescriptions are filled and I understand them.', 'No, I have not fallen.', 'Yes, I am eating and drinking normally.', 'I do not have a ride to my appointment.'],
    recovery: ['Yes, that is me. You can continue.', 'No, it is not red or warm. There is no drainage.', 'No, I have not had a fever.', 'Yes, all prescriptions are filled and I understand them.', 'No, I have not fallen.', 'Yes, I am eating and drinking normally.', 'Yes, my daughter is taking me.'],
    interrupted: ['Yes, that is me. You can continue.', 'No, it is not red or warm. There is no drainage.'],
    human: ['Yes, that is me. You can continue.', 'Can I speak to a nurse, please?'],
  },
  es: {
    wound: ['Sí, soy yo. Puede continuar.', 'Está roja y caliente, y tuve fiebre anoche.', 'Sí, tuve fiebre anoche.', 'Sí, recogí todas las recetas y entiendo qué tomar.', 'No, no me he caído.', 'Sí, estoy comiendo y bebiendo normalmente.', 'Sí, mi hija me va a llevar.'],
    emergency: ['Sí, soy yo. Puede continuar.', 'Está roja y caliente, y tuve fiebre anoche.', 'Ahora me duele el pecho y no puedo respirar.'],
    transport: ['Sí, soy yo. Puede continuar.', 'No, no está roja ni caliente. No sale líquido.', 'No, no he tenido fiebre.', 'Sí, recogí todas las recetas y entiendo qué tomar.', 'No, no me he caído.', 'Sí, estoy comiendo y bebiendo normalmente.', 'No tengo transporte para mi cita.'],
    recovery: ['Sí, soy yo. Puede continuar.', 'No, no está roja ni caliente. No sale líquido.', 'No, no he tenido fiebre.', 'Sí, recogí todas las recetas y entiendo qué tomar.', 'No, no me he caído.', 'Sí, estoy comiendo y bebiendo normalmente.', 'Sí, mi hija me va a llevar.'],
    interrupted: ['Sí, soy yo. Puede continuar.', 'No, no está roja ni caliente. No sale líquido.'],
    human: ['Sí, soy yo. Puede continuar.', '¿Puedo hablar con una enfermera, por favor?'],
  },
};
