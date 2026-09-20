import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../server/store';
import { createSimulationPlayback } from '../../src/simulation-audio';
import { responses } from '../../shared/protocol';

class Utterance {
  lang = ''; voice = null; rate = 1; pitch = 1;
  onend?: () => void; onerror?: () => void;
  constructor(public text: string) {}
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(language: 'en' | 'es' = 'en') {
  vi.useFakeTimers();
  const spoken: Utterance[] = [];
  const synth = { getVoices: vi.fn(() => [{ lang: 'en-US', localService: true }, { lang: 'es-ES', localService: true }]), addEventListener: vi.fn(), removeEventListener: vi.fn(),
    speak: vi.fn((u: Utterance) => { if (u.text) spoken.push(u); }), cancel: vi.fn() };
  vi.stubGlobal('window', { speechSynthesis: synth });
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  const store = new Store(':memory:');
  const session = store.start('alvarez', 'simulation', language, 'emergency');
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    if (path.endsWith('/events')) return Response.json(store.ingest(session.id, body.eventId, body.role, body.text));
    if (path.endsWith('/end')) return Response.json(store.finish(session.id, body.reason));
    return Response.json({ status: store.session(session.id).status });
  });
  vi.stubGlobal('fetch', fetch);
  const callbacks = { muted: false, status: vi.fn(), warning: vi.fn(), stopped: vi.fn() };
  const player = createSimulationPlayback(callbacks);
  return { spoken, synth, store, session, fetch, callbacks, player };
}
describe('agent-only simulation audio', () => {
  for (const language of ['en', 'es'] as const) it(`${language}: waits for agent speech, keeps patient silent, finishes emergency instruction before ending`, async () => {
    const f = fixture(language);
    const run = f.player.run(f.session);
    expect(f.spoken).toHaveLength(1);
    expect(f.fetch).not.toHaveBeenCalled();
    f.spoken[0].onend!(); await vi.advanceTimersByTimeAsync(1200);
    expect(f.spoken).toHaveLength(2);
    f.spoken[1].onend!(); await vi.advanceTimersByTimeAsync(1200);
    expect(f.spoken).toHaveLength(3);
    f.spoken[2].onend!(); await vi.advanceTimersByTimeAsync(1200);
    expect(f.spoken).toHaveLength(4);
    expect(f.spoken[3].text).toContain('911');
    expect(f.store.session(f.session.id).status).toBe('active');
    expect(f.store.patient('alvarez').severity).toBe('emergency');
    for (const u of f.spoken) {
      expect(responses[language].emergency).not.toContain(u.text);
      expect(u.lang).toBe(language === 'es' ? 'es-ES' : 'en-US');
    }
    f.spoken[3].onend!(); await vi.advanceTimersByTimeAsync(300); await run;
    expect(f.store.session(f.session.id).status).toBe('emergency');
    expect(f.callbacks.warning).not.toHaveBeenCalled();
    f.store.close();
  });
  it('cancelling stops audio and does not submit any further scripted replies', async () => {
    const f = fixture(); const run = f.player.run(f.session);
    f.player.cancel(); await run;
    expect(f.synth.cancel).toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.spoken).toHaveLength(1); f.store.close();
  });
  it('muting cancels current audio and completes the remaining text scenario', async () => {
    const f = fixture(); const run = f.player.run(f.session);
    f.player.setMuted(true); await vi.advanceTimersByTimeAsync(7000); await run;
    expect(f.spoken).toHaveLength(1); expect(f.store.session(f.session.id).status).toBe('emergency'); f.store.close();
  });
  it('speech errors explain the problem and continue text without provider requests', async () => {
    const f = fixture(); const run = f.player.run(f.session);
    f.spoken[0].onerror!(); await vi.advanceTimersByTimeAsync(7000); await run;
    expect(f.callbacks.warning).toHaveBeenCalledWith(expect.stringContaining('audio is unavailable'));
    expect(f.spoken).toHaveLength(1);
    expect(f.fetch.mock.calls.every(([url]) => url.startsWith('/api/sessions/'))).toBe(true);
    f.store.close();
  });
});

it('locks the same Spanish voice and its locale when the inventory changes between lines', async () => {
  const f = fixture('es');
  const original = {lang: 'es-MX', localService: false};
  f.synth.getVoices.mockReturnValue([original]);
  const run = f.player.run(f.session);
  expect(f.spoken[0].voice).toBe(original);
  f.synth.getVoices.mockReturnValue([{lang: 'es-ES', localService: true}]);
  f.spoken[0].onend!(); await vi.advanceTimersByTimeAsync(1200);
  expect(f.spoken[1].voice).toBe(original);
  expect(f.spoken[1].lang).toBe('es-MX');
  expect(f.synth.getVoices).toHaveBeenCalledTimes(1);
  f.player.cancel(); await run; f.store.close();
});
it('waits for the Spanish inventory before speaking and pins the loaded voice', async () => {
  const f = fixture('es'); f.synth.getVoices.mockReturnValue([]);
  const run = f.player.run(f.session);
  expect(f.spoken).toHaveLength(0);
  const spanish = {lang: 'es-ES', localService: true};
  f.synth.getVoices.mockReturnValue([spanish]);
  const changed = f.synth.addEventListener.mock.calls[0][1] as () => void;
  changed(); await vi.advanceTimersByTimeAsync(0);
  expect(f.spoken).toHaveLength(1); expect(f.spoken[0].voice).toBe(spanish);
  f.player.cancel(); await run;
  expect(f.synth.removeEventListener).toHaveBeenCalled(); f.store.close();
});
it('never pronounces Spanish through an unspecified default when voices are unavailable', async () => {
  const f = fixture('es'); f.synth.getVoices.mockReturnValue([]);
  const run = f.player.run(f.session);
  await vi.advanceTimersByTimeAsync(11000); await run;
  expect(f.spoken).toHaveLength(0);
  expect(f.callbacks.warning).toHaveBeenCalledWith(expect.stringContaining('No Spanish browser voice'));
  f.store.close();
});
