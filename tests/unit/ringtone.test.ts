import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRingtone } from '../../src/ringtone';

const audioMock = () => {
  const gain = { connect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() } };
  const oscillators: { type: string; frequency: { value: number }; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  class Ctx {
    state = 'running';
    currentTime = 0;
    resume = vi.fn(async () => { this.state = 'running'; });
    close = vi.fn(async () => {});
    destination = {};
    createGain = vi.fn(() => gain);
    createOscillator = vi.fn(() => {
      const osc = { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(osc);
      return osc;
    });
  }
  return { Ctx, gain, oscillators };
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ringtone', () => {
  it('plays a two-tone ring and flashes the title', async () => {
    const { Ctx, oscillators } = audioMock();
    const doc = { title: 'Aftercare' };
    vi.stubGlobal('window', { AudioContext: Ctx });
    vi.stubGlobal('document', doc);
    vi.useFakeTimers();

    const ring = createRingtone('Patient waiting');
    await ring.start();
    expect(oscillators.map(o => o.frequency.value)).toEqual([440, 480]);
    expect(ring.audible()).toBe(true);

    vi.advanceTimersByTime(900);
    expect(doc.title).toContain('Patient waiting');

    ring.stop();
    expect(doc.title).toBe('Aftercare');
    expect(ring.audible()).toBe(false);
  });

  it('repeats on a cycle until stopped', async () => {
    const { Ctx, oscillators } = audioMock();
    vi.stubGlobal('window', { AudioContext: Ctx });
    vi.stubGlobal('document', { title: 'Aftercare' });
    vi.useFakeTimers();

    const ring = createRingtone();
    await ring.start();
    expect(oscillators).toHaveLength(2);
    vi.advanceTimersByTime(3800);
    expect(oscillators.length).toBeGreaterThan(2);
    const after = oscillators.length;
    ring.stop();
    vi.advanceTimersByTime(8000);
    expect(oscillators).toHaveLength(after);
  });

  it('still flashes the title when the browser refuses audio', async () => {
    // A page the person has not interacted with: the context stays suspended.
    const { Ctx } = audioMock();
    class Blocked extends Ctx { state = 'suspended'; resume = vi.fn(async () => {}); }
    const doc = { title: 'Aftercare' };
    vi.stubGlobal('window', { AudioContext: Blocked });
    vi.stubGlobal('document', doc);
    vi.useFakeTimers();

    const ring = createRingtone('Incoming call');
    await ring.start();
    expect(ring.audible()).toBe(false);
    vi.advanceTimersByTime(900);
    expect(doc.title).toContain('Incoming call');
    ring.stop();
    expect(doc.title).toBe('Aftercare');
  });

  it('does not throw where there is no audio support at all', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { title: 'Aftercare' });
    const ring = createRingtone();
    await expect(ring.start()).resolves.toBeUndefined();
    expect(ring.audible()).toBe(false);
    ring.stop();
  });

  it('starting twice does not stack two ringtones', async () => {
    const { Ctx, oscillators } = audioMock();
    vi.stubGlobal('window', { AudioContext: Ctx });
    vi.stubGlobal('document', { title: 'Aftercare' });
    vi.useFakeTimers();
    const ring = createRingtone();
    await ring.start();
    await ring.start();
    expect(oscillators).toHaveLength(2);
    ring.stop();
  });
});
