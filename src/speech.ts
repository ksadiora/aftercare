import type { Language } from '../shared/types';

/**
 * Reading the agent's questions aloud during a written check-in.
 *
 * A patient who chose to type has not chosen to read in silence: they may be
 * older, tired, or holding a phone at arm's length, and a question they mishear
 * is a question they answer wrongly. This speaks the agent's side only — the
 * typed reply is theirs and is never read back at them.
 *
 * Browser speech, so it costs nothing and needs no credentials. Where it is
 * unavailable the check-in carries on in text; audio is an aid here, never the
 * channel.
 */

/**
 * Voice inventories arrive asynchronously in most browsers, and picking a
 * language is not enough: an engine will happily read Spanish in an English
 * voice. Resolve once, then keep the same voice for the whole conversation
 * rather than switching between turns.
 */
export function pickVoice(synth: SpeechSynthesis, language: Language) {
  return synth.getVoices()
    .filter(v => v.lang.toLowerCase().replace('_', '-').split('-')[0] === language)
    .sort((a, b) => {
      const score = (v: SpeechSynthesisVoice) => /premium|enhanced|natural/i.test(v.name || '') ? 3 : v.default ? 2 : !v.localService ? 1 : 0;
      return score(b) - score(a);
    })[0];
}

export interface Narrator {
  /** Speak one agent line, replacing anything still playing. */
  say: (text: string, language: Language) => void;
  setMuted: (value: boolean) => void;
  readonly available: boolean;
  cancel: () => void;
}

export function createNarrator(options: { muted?: boolean; warning?: (text: string) => void } = {}): Narrator {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  let muted = options.muted ?? false;
  let voice: SpeechSynthesisVoice | undefined;
  let warned = false;
  // Held so a garbage collector cannot take the utterance mid-sentence, which
  // some engines treat as a reason to stop speaking.
  let current: SpeechSynthesisUtterance | undefined;

  const warn = (text: string) => { if (!warned) { warned = true; options.warning?.(text); } };
  const cancel = () => { try { synth?.cancel(); } catch { /* already torn down */ } current = undefined; };

  const say = (text: string, language: Language) => {
    if (!synth || muted || !text.trim()) return;
    voice ??= pickVoice(synth, language);
    if (!voice) {
      // A missing voice is worth saying once, not on every question.
      warn(`No ${language === 'es' ? 'Spanish' : 'English'} voice is installed in this browser, so the questions are shown but not spoken.`);
      return;
    }
    // The newest question replaces whatever is still playing; a patient who
    // answered quickly should not have to sit through the previous one.
    cancel();
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = 0.98;
      utterance.onend = () => { current = undefined; };
      utterance.onerror = () => { current = undefined; warn('Spoken questions are unavailable in this browser. The check-in continues in text.'); };
      current = utterance;
      synth.speak(utterance);
    } catch { warn('Spoken questions are unavailable in this browser. The check-in continues in text.'); }
  };

  return {
    say,
    setMuted: (value: boolean) => { muted = value; if (value) cancel(); },
    get available() { return Boolean(synth); },
    cancel,
  };
}
