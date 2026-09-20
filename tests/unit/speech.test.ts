import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNarrator, pickVoice } from '../../src/speech';

class Utterance {
  lang = ''; voice: unknown = null; rate = 1;
  onend?: () => void; onerror?: () => void;
  constructor(public text: string) {}
}
afterEach(() => vi.unstubAllGlobals());

const stub = (voices: Partial<SpeechSynthesisVoice>[] = [{ lang: 'en-US', name: 'Samantha', localService: true }, { lang: 'es-ES', name: 'Monica', localService: true }]) => {
  const spoken: Utterance[] = [];
  const synth = { getVoices: () => voices, speak: vi.fn((u: Utterance) => spoken.push(u)), cancel: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', { speechSynthesis: synth });
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  return { spoken, synth };
};

describe('reading a written check-in aloud', () => {
  it('speaks an agent question in the conversation language', () => {
    const { spoken } = stub();
    createNarrator().say('Have you fallen since you got home?', 'en');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toContain('fallen');
    expect(spoken[0].lang).toBe('en-US');
  });

  it('never reads Spanish in an English voice', () => {
    const { spoken } = stub();
    createNarrator().say('¿Se ha caído desde que llegó a casa?', 'es');
    expect(spoken[0].lang).toBe('es-ES');
  });

  it('prefers an enhanced voice over a default one', () => {
    const voices = [{ lang: 'en-US', name: 'Basic', default: true, localService: true }, { lang: 'en-GB', name: 'Serena (Enhanced)', localService: true }];
    stub(voices);
    expect(pickVoice(window.speechSynthesis, 'en')?.name).toBe('Serena (Enhanced)');
  });

  it('stays silent when muted, and resumes when unmuted', () => {
    const { spoken } = stub();
    const narrator = createNarrator({ muted: true });
    narrator.say('First question', 'en');
    expect(spoken).toHaveLength(0);
    narrator.setMuted(false);
    narrator.say('Second question', 'en');
    expect(spoken).toHaveLength(1);
  });

  it('replaces a question still playing rather than queueing behind it', () => {
    // Someone who answered quickly should not sit through the previous question.
    const { spoken, synth } = stub();
    const narrator = createNarrator();
    narrator.say('Question one', 'en');
    narrator.say('Question two', 'en');
    expect(synth.cancel).toHaveBeenCalled();
    expect(spoken.at(-1)!.text).toBe('Question two');
  });

  it('warns once, not per question, when no voice is installed', () => {
    stub([]);
    const warning = vi.fn();
    const narrator = createNarrator({ warning });
    narrator.say('One', 'en'); narrator.say('Two', 'en'); narrator.say('Three', 'en');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toContain('not spoken');
  });

  it('degrades to text where the browser has no speech at all', () => {
    vi.stubGlobal('window', {});
    const narrator = createNarrator();
    expect(narrator.available).toBe(false);
    expect(() => narrator.say('Anything', 'en')).not.toThrow();
  });
});
