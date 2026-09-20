import type { Language, Session } from '../shared/types';
import { responses } from '../shared/protocol';
import { api } from './api';
import { pickVoice } from './speech';

export function createSimulationPlayback(callbacks: {
  muted: boolean; status: (text: string) => void; warning: (text: string) => void; stopped: () => void;
}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  let muted = callbacks.muted;
  let cancelled = false;
  let selectedVoice: SpeechSynthesisVoice | undefined;
  let release: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  // Keep the utterance alive until its end event (some browser engines require this).
  let utterance: SpeechSynthesisUtterance | undefined;
  const cancelSpeech = () => { synth?.cancel(); release?.(); };
  const cancel = () => { cancelled = true; clearInterval(heartbeat); clearTimeout(deadline); cancelSpeech(); };
  const setMuted = (value: boolean) => { muted = value; if (value) cancelSpeech(); };
  const wait = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); release = undefined; resolve(); }
    release = done;
  });
  // Called directly by the Start button to unlock speech on browsers that require a gesture.
  if (synth && !muted) {
    try { const unlock = new SpeechSynthesisUtterance(''); synth.speak(unlock); }
    catch { muted = true; callbacks.warning('Browser audio is unavailable. The text simulation will continue.'); }
  }
  if (!synth && !muted) callbacks.warning('This browser does not support simulation audio. Try Chrome or Safari. The text simulation will continue.');
  async function speak(text: string, language: Language) {
    if (cancelled) return;
    if (!synth || muted) { callbacks.status('Simulation running · audio off'); await wait(750); return; }
    const chooseVoice = () => pickVoice(synth, language);
    if (!selectedVoice) {
      selectedVoice = chooseVoice();
      if (!selectedVoice) {
        callbacks.status('Loading browser voice');
        // Voice inventories often arrive asynchronously. Never speak using an
        // unspecified default and then switch voices on the following turn.
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); synth.removeEventListener('voiceschanged', changed); release = undefined; resolve(); };
          const changed = () => { selectedVoice = chooseVoice(); if (selectedVoice) done(); };
          const timer = setTimeout(() => { selectedVoice = chooseVoice(); done(); }, 2500);
          release = done;
          synth.addEventListener('voiceschanged', changed);
          changed();
        });
      }
    }
    if (cancelled) return;
    if (!selectedVoice) {
      muted = true; callbacks.warning(`No ${language === 'es' ? 'Spanish' : 'English'} browser voice is available. Install a system voice or use another browser. Audio is off; the text simulation will continue.`);
      await wait(750); return;
    }
    const voiceForSession = selectedVoice;
    await new Promise<void>(resolve => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); release = undefined; utterance = undefined; resolve(); };
      const fail = () => { if (!cancelled && !muted) { muted = true; callbacks.warning('Simulation audio is unavailable in this browser. Try Chrome or Safari with sound enabled. The text simulation will continue.'); } done(); };
      const timer = setTimeout(() => { fail(); synth.cancel(); }, 45000);
      release = done;
      utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voiceForSession;
      utterance.lang = voiceForSession.lang;
      utterance.rate = 0.98;
      utterance.pitch = 1;
      utterance.onend = done;
      utterance.onerror = fail;
      callbacks.status('Playing follow-up agent');
      try { synth.speak(utterance); } catch { fail(); }
    });
    if (!cancelled) await wait(180);
  }
  async function run(session: Session) {
    const finish = async (reason: 'completed' | 'interrupted' | 'failed') => {
      cancel();
      try { await api(`/sessions/${session.id}/end`, { reason }); }
      catch (e) { callbacks.warning(e instanceof Error ? e.message : 'Could not save simulation end.'); }
    };
    heartbeat = setInterval(() => {
      void api<{status: string}>(`/sessions/${session.id}/heartbeat`, {}).then(s => {
        if (s.status !== 'active') cancel();
      }).catch(() => { callbacks.warning('Local connection lost. Simulation playback stopped.'); cancel(); });
    }, 5000);
    deadline = setTimeout(() => { void finish('interrupted'); }, 300000);
    try {
      await speak(session.next.instruction, session.language);
      const script = responses[session.language][session.scenario!];
      for (let index = 0; index < script.length && !cancelled; index++) {
        const result = await api<{session: Session}>(`/sessions/${session.id}/events`, {
          eventId: `simulation-${index}`, role: 'user', text: script[index],
        });
        if (cancelled) break;
        callbacks.status('Patient response · text placeholder');
        await wait(900);
        if (cancelled) break;
        await speak(result.session.next.instruction, session.language);
        if (result.session.next.done) break;
      }
      if (!cancelled) await finish(session.scenario === 'interrupted' ? 'interrupted' : 'completed');
    } catch (e) {
      callbacks.warning(e instanceof Error ? e.message : 'Simulation could not continue.');
      if (!cancelled) await finish('failed');
    } finally { cancel(); callbacks.stopped(); }
  }
  return { run, cancel, setMuted };
}
