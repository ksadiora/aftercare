import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request, page }) => {
  const data = await (await request.get('/api/dashboard')).json();
  if (data.activeSession) await request.post(`/api/sessions/${data.activeSession.id}/end`, { data: { reason: 'interrupted' } });
  if (data.handoff) await request.post(`/api/handoffs/${data.handoff.id}/end`, { data: { state: 'ended' } });
  await request.post('/api/demo/reset', { data: {} });
  await page.goto('/nurse');
  await expect(page.getByRole('heading', { name: 'Follow-up worklist' })).toBeVisible();
});

const startChat = async (page: import('@playwright/test').Page, language: 'en' | 'es') => {
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Text chat' }).click();
  await page.getByLabel('Conversation language').selectOption(language);
  await page.getByRole('button', { name: 'Start text check-in' }).click();
  await expect(page.getByRole('textbox', { name: 'Your reply' })).toBeVisible();
};
const say = async (page: import('@playwright/test').Page, text: string) => {
  await page.getByRole('textbox', { name: 'Your reply' }).fill(text);
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.locator('.transcript')).toContainText(text);
};

test('text chat asks a model clarification, holds the question, and keeps the rule-based flag', async ({ page }) => {
  await startChat(page, 'en');
  await say(page, 'Yes, that is me. You can continue.');
  await expect(page.locator('.transcript')).toContainText('incision');
  await say(page, 'I am not sure, I cannot really tell.');
  // The model rephrased the same question rather than moving to the fever question.
  await expect(page.locator('.transcript')).toContainText('is the skin red or warm to the touch');
  await expect(page.locator('.transcript')).not.toContainText('fever since you got home');
  // The rules already flagged the unclear answer, and that stands.
  await expect(page.getByTestId('patient-alvarez')).toContainText('Review today');
  await page.getByRole('tab', { name: 'Audit trail' }).click();
  await expect(page.locator('.audit-list')).toContainText('gemini-2.5-flash-e2e');
});

test('an emergency in text chat stops the questionnaire without waiting for the model', async ({ page }) => {
  await startChat(page, 'es');
  await say(page, 'Sí, soy yo. Puede continuar.');
  await say(page, 'Ahora me duele el pecho y no puedo respirar.');
  await expect(page.locator('.transcript')).toContainText('llame al 911');
  await expect(page.getByTestId('patient-alvarez')).toContainText('Emergency');
  await expect(page.locator('.session-result')).toContainText('Emergency flagged');
});

test('the clinician briefing links every statement to the transcript and preserves Spanish', async ({ page, request }) => {
  const started = await request.post('/api/sessions', { data: { patientId: 'alvarez', mode: 'chat', language: 'es' } });
  const session = await started.json();
  const script = ['Sí, soy yo. Puede continuar.', 'Está roja y caliente, y tuve fiebre anoche.', 'Sí, tuve fiebre anoche.', 'Sí, recogí todas las recetas y entiendo qué tomar.', 'No, no me he caído.', 'Sí, estoy comiendo y bebiendo normalmente.', 'Sí, mi hija me va a llevar.'];
  for (const [index, text] of script.entries()) {
    await request.post(`/api/sessions/${session.id}/message`, { data: { eventId: `e2e-${index}`, text } });
  }
  await page.reload();
  await page.getByRole('tab', { name: 'Briefing' }).click();
  await page.getByRole('button', { name: 'Prepare briefing' }).click();

  await expect(page.locator('.briefing-reason')).toContainText('red, warm incision');
  // The patient's own words stay in Spanish; the translation is labelled as generated.
  await expect(page.locator('.briefing-quote blockquote')).toContainText('Está roja y caliente');
  await expect(page.locator('.briefing-translation')).toContainText('English translation (generated');
  await expect(page.locator('.briefing-statement')).toHaveCount(1);
  await page.locator('.briefing-sources summary').first().click();
  await expect(page.locator('.briefing-sources blockquote').first()).toBeVisible();

  // The timeline comes from the audit trail, not the model, so it is here whatever Gemini says.
  await expect(page.locator('.briefing-timeline')).toContainText('check-in started');

  await page.getByRole('textbox', { name: 'Ask about this case' }).fill('What did the patient say about the incision?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('.briefing-answer')).toContainText('red and warm');
  await expect(page.locator('.briefing-footer')).toContainText('resolves nothing');
});

/**
 * Only the microphone is stubbed. The real livekit-client runs and fails against the
 * unreachable test media server, which is the failure the demo actually has to survive.
 * The adapter's success path is covered by unit tests, which mock the SDK directly —
 * the built chunk hides its exports behind a per-build alias, so stubbing it here would
 * break on the next build.
 */
const stubMicrophone = (page: import('@playwright/test').Page) => page.addInitScript(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    configurable: true,
  });
});

test('a handoff rings, is claimed once, and never shows as live before both sides join', async ({ page, request }) => {
  await request.post('/api/patients/alvarez/handoff', { data: { reason: 'The patient asked to speak with a person.' } });
  await page.goto('/nurse?nurse=Nurse%20Rivera');

  const banner = page.locator('.handoff-ringing');
  await expect(banner).toContainText('Miguel Alvarez is waiting for a person');
  // ANS is not configured in tests, so verification must read as unavailable, never verified.
  await expect(banner.locator('.handoff-verify')).toContainText('verification unavailable');
  await banner.getByRole('button', { name: /Accept as Nurse Rivera/ }).click();

  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  const status = page.locator('.handoff-status');
  await expect(status).toContainText('Nurse accepted');
  // Accepting is not connecting: nothing may claim the two are talking.
  await expect(status).not.toContainText('Nurse and patient talking');

  const handoff = (await (await request.get('/api/dashboard')).json()).handoff;
  expect(handoff.state).toBe('accepted');
  expect(handoff.joined).toEqual([]);
  const second = await request.post(`/api/handoffs/${handoff.id}/accept`, { data: { nurse: 'Nurse Okafor' } });
  expect(second.status()).toBe(409);
  expect((await second.json()).error).toContain('Nurse Rivera');
});

test('an unreachable media server is reported as a failure, never as a transfer', async ({ page, request }) => {
  await stubMicrophone(page);
  await request.post('/api/patients/alvarez/handoff', { data: { reason: 'The patient asked to speak with a person.' } });
  await page.goto('/nurse?nurse=Nurse%20Rivera');
  await page.locator('.handoff-ringing').getByRole('button', { name: /Accept as Nurse Rivera/ }).click();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.locator('.handoff-status').getByRole('button', { name: 'Join audio' }).click();

  // LIVEKIT_URL points at a host that does not exist in tests.
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.handoff-status')).toContainText('Handoff failed', { timeout: 30000 });
  await expect(page.locator('.handoff-status')).toContainText('callback task');
  const patient = await (await request.get('/api/patients/alvarez')).json();
  expect(patient.patient.action).toBe('Nurse callback requested');
  // Nothing was ever recorded as joined.
  const handoff = (await (await request.get('/api/dashboard')).json()).handoff;
  expect(handoff.joined).toEqual([]);
  expect(handoff.state).toBe('failed');
});

test('a clean run starts with nothing assessed, so a live check-in is visible', async ({ page }) => {
  await page.getByRole('button', { name: 'New demo' }).click();
  await page.getByRole('button', { name: /Clean run/ }).click();

  // Every patient is unassessed, so anything that appears came from this demo.
  await expect(page.getByTestId('patient-alvarez')).toContainText('Not assessed');
  await expect(page.getByTestId('patient-johnson')).toContainText('Not assessed');
  await expect(page.getByTestId('patient-chen')).toContainText('Not assessed');
  await expect(page.locator('.patient-row', { hasText: 'Urgent review' })).toHaveCount(0);
  await expect(page.locator('.patient-row', { hasText: 'Review today' })).toHaveCount(0);

  // The service still reaches out on its own, for all three now.
  await expect(page.locator('.outreach-row')).toHaveCount(3, { timeout: 8000 });

  // And a check-in is then unmistakable against the empty board.
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.getByLabel('Simulation scenario').selectOption('wound');
  await page.getByRole('button', { name: 'Simulation audio' }).click();
  await page.getByRole('button', { name: 'Start simulation' }).click();
  await expect(page.getByTestId('patient-alvarez')).toContainText('Urgent review', { timeout: 15000 });
  await expect(page.locator('.patient-row', { hasText: 'Urgent review' })).toHaveCount(1);
});

test('the patient page discovers a call that starts after they opened it', async ({ page, request }) => {
  // The patient page has no event stream of its own, so this is the regression
  // test for it only polling when a call already existed — which meant a call
  // rung from the nurse page could never appear.
  const token = await expect.poll(async () => {
    const data = await (await request.get('/api/dashboard')).json();
    return data.outreach[0]?.token ?? null;
  }, { timeout: 8000 }).not.toBe(null).then(async () => {
    const data = await (await request.get('/api/dashboard')).json();
    return data.outreach[0].token as string;
  });

  await page.goto(`/c/${token}`);
  await expect(page.getByRole('heading', { name: /Hello|Hola/ })).toBeVisible();
  await expect(page.locator('.patient-ring')).toHaveCount(0);

  // Nurse presses Request callback while the patient is already sitting on the page.
  const patientId = (await (await request.get('/api/dashboard')).json()).outreach[0].patientId;
  await request.post(`/api/patients/${patientId}/actions`, { data: { action: 'callback' } });

  // No reload: the page must notice on its own.
  await expect(page.locator('.patient-ring')).toContainText(/calling|llamando/, { timeout: 15000 });
  await expect(page.getByRole('button', { name: /Answer|Contestar/ })).toBeDisabled();

  // Once a nurse accepts, the patient can answer.
  const handoff = (await (await request.get('/api/dashboard')).json()).handoff;
  await request.post(`/api/handoffs/${handoff.id}/accept`, { data: { nurse: 'Rivera' } });
  await expect(page.getByRole('button', { name: /Answer|Contestar/ })).toBeEnabled({ timeout: 15000 });
});

test('the nurse can always see a call they accepted, whatever tab they are on', async ({ page, request }) => {
  // Regression: the call controls used to live inside one patient's Conversation
  // tab, so after accepting, a nurse on any other tab saw nothing at all.
  await request.post('/api/patients/johnson/actions', { data: { action: 'callback' } });
  await page.goto('/nurse?nurse=Rivera');

  const ringing = page.locator('.handoff-ringing');
  await expect(ringing).toContainText('Evelyn Johnson', { timeout: 10000 });
  await ringing.getByRole('button', { name: /Accept as Rivera/ }).click();

  // The ringing banner is replaced in place by the call, not hidden away.
  await expect(page.locator('.handoff-ringing')).toHaveCount(0);
  const live = page.locator('main > .handoff-status');
  await expect(live).toContainText('Nurse accepted');
  await expect(live.getByRole('button', { name: 'Join audio' })).toBeVisible();

  // Still visible after moving to an unrelated patient and an unrelated tab.
  await page.getByTestId('patient-chen').click();
  await page.getByRole('tab', { name: 'Audit trail' }).click();
  await expect(live).toContainText('Nurse accepted');
  await expect(live.getByRole('button', { name: 'Join audio' })).toBeVisible();
});

test('the patient picker lists everyone and opens their own check-in', async ({ page }) => {
  await page.goto('/patient');
  await expect(page.getByRole('heading', { name: 'Which patient are you?' })).toBeVisible();

  // All three callable patients, with enough detail to tell them apart.
  await expect(page.getByText('Miguel Alvarez')).toBeVisible();
  await expect(page.getByText('Evelyn Johnson')).toBeVisible();
  await expect(page.getByText('Robert Chen')).toBeVisible();
  await expect(page.getByText(/71 years · Spanish/)).toBeVisible();

  // Miguel is due, so the service already made his link. Evelyn has a prior
  // contact, so hers has to be created — both paths are on this page.
  const evelyn = page.locator('.picker-row', { hasText: 'Evelyn Johnson' });
  await expect(evelyn.getByRole('button', { name: 'Create link' })).toBeVisible();
  await evelyn.getByRole('button', { name: 'Create link' }).click();
  await expect(evelyn.getByRole('link', { name: /Open as Evelyn/ })).toBeVisible({ timeout: 10000 });

  // Opening one lands on that patient's own check-in, not a dashboard.
  await page.getByRole('link', { name: /Open as Miguel/ }).click();
  await expect(page.getByRole('heading', { name: /Hola, Miguel/ })).toBeVisible();
  await expect(page).toHaveURL(/\/c\/[a-f0-9]{32}$/);
  await expect(page.getByText('Total knee replacement')).toBeVisible();
  // Still no worklist leaking into the patient view.
  await expect(page.getByText('Robert Chen')).toHaveCount(0);
});

test('the role landing offers all three doors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Who are you today?' })).toBeVisible();
  for (const [name, href] of [['Care team', '/nurse'], ['Provider', '/provider'], ['Patient', '/patient']] as const) {
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveAttribute('href', href);
  }
});

test('the nurse rings the patient and the agent runs the check-in on their device', async ({ page, context }) => {
  // Nurse triggers it from the Conversation tab.
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Call patient' }).click();
  await expect(page.getByText(/Their page is ringing/)).toBeVisible();

  // The patient's own device shows an incoming check-in, not a nurse call.
  const patient = await context.newPage();
  await patient.goto('/patient');
  await patient.getByRole('link', { name: /Open as Miguel/ }).click();
  const ring = patient.locator('.patient-ring');
  await expect(ring).toContainText(/Es hora de su consulta|Time for your check-in/, { timeout: 12000 });
  await expect(ring).toContainText(/asistente autom|automated follow-up assistant/);

  // Answering starts the automated check-in there, and the nurse sees the transcript.
  await patient.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => { throw new DOMException('no mic', 'NotAllowedError'); } }, configurable: true });
  });
  await patient.reload();
  await patient.locator('.patient-mode', { hasText: /Escribir|Type instead/ }).click();
  await patient.getByRole('button', { name: /Escribir|Type instead/ }).last().click();
  await expect(patient.getByRole('textbox', { name: /Su respuesta|Your reply/ })).toBeVisible({ timeout: 12000 });

  // Ringing stops once they are in the check-in.
  await expect(patient.locator('.patient-ring')).toHaveCount(0);
  await expect(page.getByText(/Their page is ringing/)).toHaveCount(0);
  await patient.close();
});

test('a callback the nurse places puts them straight on the line', async ({ page, request }) => {
  // The nurse should not have to accept their own request and then join it.
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Request callback' }).click();

  // No ringing banner for the nurse: it was claimed on their behalf.
  await expect(page.locator('.handoff-ringing')).toHaveCount(0);
  await expect.poll(async () => {
    const data = await (await request.get('/api/dashboard')).json();
    return data.handoff?.nurse ?? null;
  }, { timeout: 10000 }).toBe('Demo nurse');

  // And the case still carries the callback task, whatever the audio does next.
  const patient = await (await request.get('/api/patients/alvarez')).json();
  expect(patient.patient.action).toBe('Nurse callback requested');
});

test('the logo returns to the role chooser from every surface', async ({ page, request }) => {
  const token = await expect.poll(async () => {
    const data = await (await request.get('/api/dashboard')).json();
    return data.outreach[0]?.token ?? null;
  }, { timeout: 8000 }).not.toBe(null).then(async () => {
    const data = await (await request.get('/api/dashboard')).json();
    return data.outreach[0].token as string;
  });

  for (const from of ['/nurse', '/provider', '/patient', `/c/${token}`]) {
    await page.goto(from);
    await page.getByRole('link', { name: 'Aftercare home' }).first().click();
    await expect(page.getByRole('heading', { name: 'Who are you today?' })).toBeVisible();
  }
});

/**
 * The nurse's own words are optional on an escalation; the automated summary is not.
 * A provider must always be able to tell which is which, so the two never merge into
 * one paragraph.
 */
test('an escalation reaches the provider with the nurse note and the summary kept apart', async ({ page, request }) => {
  const started = await request.post('/api/sessions', { data: { patientId: 'alvarez', mode: 'chat', language: 'en' } });
  const session = await started.json();
  for (const [index, text] of ['Yes, that is me.', 'It is red and warm, and I had a fever last night.'].entries()) {
    await request.post(`/api/sessions/${session.id}/message`, { data: { eventId: `esc-${index}`, text } });
  }
  await request.post(`/api/sessions/${session.id}/end`, { data: { reason: 'interrupted' } });
  await page.reload();

  // Escalate with nothing written: the modal must accept it.
  await page.getByRole('button', { name: 'Escalate' }).click();
  await expect(page.getByRole('heading', { name: 'Escalate this case' })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save escalation' });
  await expect(save).toBeEnabled();
  await save.click();

  await page.goto('/provider?name=Dr%20Okafor');
  await page.getByRole('button', { name: /Miguel Alvarez/ }).click();
  // No nurse note means no opening message, and nothing invented to stand in for one.
  await expect(page.locator('.case-message')).toHaveCount(0);
  await expect(page.locator('.case-thread')).toContainText('escalated without a note');
  await expect(page.locator('.provider-summary')).toContainText('red, warm incision');
  await expect(page.locator('.provider-summary')).toContainText('DRAFT');

  // Now with the nurse's own words: both appear, in their own blocks.
  await page.goto('/nurse');
  await page.getByRole('button', { name: /Miguel Alvarez/ }).first().click();
  await page.getByRole('button', { name: 'Escalate' }).click();
  await page.getByRole('textbox', { name: /Nurse note/ }).fill('Please decide on antibiotics today.');
  await page.getByRole('button', { name: 'Save escalation' }).click();

  await page.goto('/provider?name=Dr%20Okafor');
  await page.getByRole('button', { name: /Miguel Alvarez/ }).click();
  // The nurse's words open the conversation; the generated summary stays outside it.
  await expect(page.locator('.case-message.nurse')).toContainText('antibiotics today');
  await expect(page.locator('.provider-summary')).toContainText('red, warm incision');
  await expect(page.locator('.provider-summary')).not.toContainText('antibiotics today');
});

/**
 * Reported after two live tests: the provider wrote to the nurse and the nurse could
 * not find it, and there was no way to answer. This walks the whole exchange through
 * both screens the way a demo does.
 */
test('the nurse and the provider hold a conversation on the case', async ({ page, request }) => {
  await request.post('/api/patients/alvarez/actions', { data: { action: 'escalate', note: 'Please advise on antibiotics.' } });

  // The provider answers, and asks something back.
  await page.goto('/provider?name=Dr%20Okafor');
  await page.getByRole('button', { name: /Miguel Alvarez/ }).click();
  await expect(page.locator('.case-thread')).toContainText('Please advise on antibiotics');
  await expect(page.locator('.case-thread .small-kicker')).toContainText('AWAITING YOU');
  await page.getByRole('textbox', { name: 'Reply to the nurse' }).fill('Start oral cephalexin. Any fever today?');
  await page.getByRole('button', { name: 'Send to nurse' }).click();
  await expect(page.locator('.case-message.provider')).toContainText('cephalexin');

  // The nurse sees it without hunting, and answers.
  await page.goto('/nurse?nurse=Nurse%20Rivera');
  await expect(page.getByTestId('patient-alvarez')).toContainText('Provider replied');
  await page.getByTestId('patient-alvarez').click();
  const thread = page.locator('.case-thread');
  await expect(thread).toContainText('cephalexin');
  await expect(thread).toContainText('Dr Okafor');
  await expect(thread.locator('.small-kicker')).toContainText('AWAITING YOU');
  // Above the tabs, so it does not depend on the nurse picking the right one.
  for (const tab of ['Conversation', 'Briefing', 'Audit trail']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(thread).toContainText('cephalexin');
  }
  await page.getByRole('textbox', { name: 'Message the provider' }).fill('No fever recorded today.');
  await thread.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.case-message.nurse').last()).toContainText('No fever recorded today');
  await expect(thread.locator('.small-kicker')).toContainText('AWAITING THE PROVIDER');
  await expect(page.getByTestId('patient-alvarez')).not.toContainText('Provider replied');

  // And back on the provider's screen, the nurse's answer is waiting.
  await page.goto('/provider?name=Dr%20Okafor');
  await page.getByRole('button', { name: /Miguel Alvarez/ }).click();
  await expect(page.locator('.case-message.nurse').last()).toContainText('No fever recorded today');
  await expect(page.locator('.case-thread .small-kicker')).toContainText('AWAITING YOU');
  // Talking is not deciding: the case is still escalated and open.
  await expect(page.locator('.provider-detail')).toContainText('the nurse still decides');
});
