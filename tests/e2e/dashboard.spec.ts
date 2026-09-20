import { test, expect } from '@playwright/test';
test.beforeEach(async ({ request, page }) => {
  const data = await (await request.get('/api/dashboard')).json();
  if (data.activeSession) await request.post(`/api/sessions/${data.activeSession.id}/end`, { data: { reason: 'interrupted' } });
  await request.post('/api/demo/reset', { data: {} }); await page.goto('/nurse');
  await expect(page.getByRole('heading', { name: 'Follow-up worklist' })).toBeVisible();
});
test('worklist filtering, profile navigation, and nurse audit', async ({ page }) => {
  await expect(page.locator('.patient-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Full cohort' }).click(); await expect(page.locator('.patient-row')).toHaveCount(40);
  await page.getByRole('textbox', { name: 'Search patients' }).fill('Evelyn'); await expect(page.locator('.patient-row')).toHaveCount(1);
  await page.getByTestId('patient-johnson').click(); await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save and resolve' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Nurse note' }).fill('Daughter confirmed a ride for the appointment.');
  await page.getByRole('button', { name: 'Save and resolve' }).click();
  await expect(page.getByTestId('patient-johnson')).toContainText('Resolved by nurse');
  await page.getByRole('tab', { name: 'Audit trail' }).click(); await expect(page.locator('.audit-list')).toContainText('Daughter confirmed a ride');
  await page.reload(); await page.getByTestId('patient-johnson').click(); await expect(page.locator('.detail-status')).toContainText('Resolved by nurse');
});
test('English wound scenario updates live, survives refresh, and preserves history after reset', async ({ page }) => {
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click(); await page.getByLabel('Conversation language').selectOption('en');
  await page.getByRole('button', { name: 'Simulation audio' }).click();
  await page.getByRole('button', { name: 'Start simulation' }).click();
  await expect(page.getByTestId('patient-alvarez')).toContainText('Urgent review', { timeout: 12000 });
  await expect(page.locator('.transcript')).toContainText('red and warm');
  await page.reload(); await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('.transcript')).toContainText('red and warm');
  await expect(page.getByRole('button', { name: 'Start simulation' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'New demo' }).click(); await page.getByRole('button', { name: /With sample records/ }).click();
  await expect(page.getByTestId('patient-alvarez')).toContainText('Not assessed');
  await page.getByRole('button', { name: 'Demo history', exact: true }).click();
  const select = page.getByLabel('Demo session'); await expect(select.locator('option').nth(1)).toBeAttached(); const options = await select.locator('option').all();
  await select.selectOption((await options[1].getAttribute('value'))!);
  await expect(page.locator('.history-events')).toContainText('red and warm');
});
test('Spanish emergency stops the questionnaire and records the original quote', async ({ page }) => {
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click(); await page.getByLabel('Conversation language').selectOption('es');
  await page.getByLabel('Simulation scenario').selectOption('emergency'); await page.getByRole('button', { name: 'Simulation audio' }).click();
  await page.getByRole('button', { name: 'Start simulation' }).click();
  await expect(page.getByTestId('patient-alvarez')).toContainText('Emergency', { timeout: 15000 });
  await expect(page.locator('.transcript')).toContainText('llame al 911');
  await expect(page.locator('.transcript')).not.toContainText('¿Se ha caído');
  await expect(page.locator('.session-result')).toContainText('Emergency flagged', { timeout: 8000 });
});
test('browser voice explains missing configuration instead of simulating', async ({ page }) => {
  await page.route('**/api/capabilities', route => route.fulfill({json:{voice:false, voiceReason:'Add your API key to enable in-app calls.', maxSessionSeconds:300}})); await page.reload();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click(); await page.getByRole('button', { name: 'In-app call', exact: true }).click();
  await expect(page.locator('.mode-description')).toContainText('API key'); await expect(page.getByRole('button', { name: 'Start call' })).toBeDisabled();
  await expect(page.locator('.transcript-empty')).toBeVisible();
});
test('microphone denial is clear and never falls back to simulation', async ({ page }) => {
  await page.route('**/api/capabilities', route => route.fulfill({ json: { voice: true, voiceReason: 'Browser microphone', maxSessionSeconds: 300 } }));
  await page.route('**/api/sessions', route => route.fulfill({ status: 201, json: { id: 'mock-session', patientId: 'alvarez', mode: 'voice', language: 'en', status: 'connecting', startedAt: new Date().toISOString() } }));
  await page.route('**/api/sessions/mock-session/end', route => route.fulfill({ json: { status: 'failed' } }));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) }, configurable: true }); });
  await page.reload(); await page.getByRole('tab', { name: 'Conversation', exact: true }).click(); await page.getByRole('button', { name: 'In-app call', exact: true }).click();
  await page.getByRole('button', { name: 'Start call' }).click();
  await expect(page.getByRole('alert')).toContainText('Microphone permission was denied'); await expect(page.locator('.transcript-empty')).toBeVisible();
});
test('keyboard controls and mobile layout remain usable', async ({ page }) => {
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to patient worklist' })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId('patient-alvarez').click(); await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start simulation' })).toBeVisible();
});

test('simulation plays only the agent and can stop during speech', async ({ page }) => {
  await page.addInitScript(() => {
    const spoken: {text: string; lang: string}[] = [];
    (window as any).__spoken = spoken;
    (window as any).SpeechSynthesisUtterance = class { text: string; constructor(text: string) { this.text = text; } };
    (window as any).__speechCancelCount = 0;
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{lang: 'en-US', localService: true}, {lang: 'es-ES', localService: true}],
      speak: (utterance: SpeechSynthesisUtterance) => {
        if (!utterance.text) return;
        spoken.push({text: utterance.text, lang: utterance.lang});
        (window as any).__finishSpeech = () => utterance.onend?.({} as SpeechSynthesisEvent);
      },
      cancel: () => { (window as any).__speechCancelCount++; },
    }});
  });
  await page.reload();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.getByLabel('Conversation language').selectOption('en');
  await expect(page.getByRole('button', { name: 'Simulation audio' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Start simulation' }).click();
  await expect(page.locator('.session-meta')).toContainText('Playing follow-up agent');
  await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBe(1);
  await page.waitForTimeout(1800);
  await expect(page.locator('.transcript')).not.toContainText('You can continue');
  await page.evaluate(() => (window as any).__finishSpeech());
  await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBe(2);
  const spoken = await page.evaluate(() => (window as any).__spoken);
  expect(spoken.every((u: {lang: string}) => u.lang === 'en-US')).toBe(true);
  expect(spoken[1].text).toContain('incision');
  expect(spoken.some((u: {text: string}) => u.text.includes('You can continue'))).toBe(false);
  await page.getByRole('button', { name: 'End check-in' }).click();
  await expect(page.getByRole('button', { name: 'Start simulation' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__speechCancelCount)).toBeGreaterThan(0);
});

test('in-app call accepts participant speech, exposes controls, and updates nurse urgency', async ({ page }) => {
  await page.route('**/api/capabilities', route => route.fulfill({json:{voice:true, voiceReason:'In-app call', maxSessionSeconds:300}}));
  await page.route('**/api/sessions/*/voice-url', route => route.fulfill({json:{signedUrl:'wss://test.invalid'}}));
  await page.route('**/assets/web-*.js', route => route.fulfill({contentType:'application/javascript', body:`
    export const Conversation = { startSession: async options => {
      window.__callOptions = options;
      window.__callControls = { muted:false, volume:1, ended:false };
      options.onConnect({conversationId:'ui-test'});
      options.onModeChange({mode:'listening'});
      return {
        endSession:async()=>{window.__callControls.ended=true;},
        setMicMuted:value=>{window.__callControls.muted=value;},
        setVolume:({volume})=>{window.__callControls.volume=volume;},
        getInputVolume:()=>0.35
      };
    }};
  `}));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', {configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}}); });
  await page.reload(); await page.getByRole('tab', {name:'Conversation',exact:true}).click();
  await page.getByRole('button', {name:'In-app call',exact:true}).click();
  await page.getByLabel('Conversation language').selectOption('es');
  await expect(page.getByRole('button', {name:'Check microphone'})).toBeVisible();
  await expect(page.getByRole('button', {name:'Test speaker'})).toBeVisible();
  await page.getByRole('button', {name:'Start call',exact:true}).click();
  await expect(page.locator('.call-state')).toHaveText('Listening to you');
  await page.getByRole('button', {name:'Mute microphone',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__callControls.muted)).toBe(true);
  await expect(page.locator('.call-state')).toHaveText('Microphone muted');
  await page.getByRole('button', {name:'Unmute microphone',exact:true}).click();
  await page.getByLabel('Call speaker volume').fill('40');
  expect(await page.evaluate(()=>(window as any).__callControls.volume)).toBe(.4);
  await page.evaluate(async () => {
    const options = (window as any).__callOptions;
    options.onMessage({role:'user',message:'Sí, soy yo. Puede continuar.',event_id:1});
    await options.clientTools.get_next_step();
    options.onMessage({role:'user',message:'Está roja y caliente, y tuve fiebre anoche.',event_id:2});
    await options.clientTools.get_next_step();
  });
  await expect(page.getByTestId('patient-alvarez')).toContainText('Urgent review');
  await expect(page.locator('.transcript')).toContainText('roja y caliente');
  await page.screenshot({path:'/private/tmp/aftercare-in-app-call.png',fullPage:true});
  await page.getByRole('button', {name:'End call',exact:true}).click();
  await expect(page.getByRole('button', {name:'Start call',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__callControls.ended)).toBe(true);
});
