import { useEffect, useRef, useState } from 'react';
import { Mic, Volume2 } from 'lucide-react';

export function AudioCheck({ disabled }: { disabled: boolean }) {
  const [checking, setChecking] = useState(false);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState('Check your sound before calling. These checks stay on your device.');
  const cleanup = useRef<() => void>(() => undefined);
  const generation = useRef(0);
  const contexts = useRef(new Set<AudioContext>());
  const stop = () => { generation.current++; cleanup.current(); cleanup.current = () => undefined; setChecking(false); setLevel(0); };
  useEffect(() => { if (disabled) { stop(); for (const context of contexts.current) void context.close(); contexts.current.clear(); } }, [disabled]);
  useEffect(() => () => { generation.current++; cleanup.current(); for (const context of contexts.current) void context.close(); }, []);
  async function checkMic() {
    if (checking) { stop(); setMessage('Microphone check stopped.'); return; }
    stop(); const ticket = generation.current; setChecking(true); setMessage('Allow microphone access, then say a few words.');
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone checks require localhost or HTTPS in a supported browser.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (ticket !== generation.current) { stream.getTracks().forEach(t => t.stop()); return; }
      context = new AudioContext(); contexts.current.add(context); await context.resume();
      if (ticket !== generation.current) { stream.getTracks().forEach(t => t.stop()); contexts.current.delete(context); await context.close(); return; }
      const analyser = context.createAnalyser(); analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const bytes = new Uint8Array(analyser.fftSize); let heard = false;
      setMessage('Speak now. The microphone meter should move.');
      const meter = setInterval(() => { analyser.getByteTimeDomainData(bytes); const rms = Math.sqrt(bytes.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / bytes.length); setLevel(Math.min(1, rms * 5)); if (rms > .015) { heard = true; setMessage('Microphone signal detected. You are ready to speak.'); } }, 100);
      const timer = setTimeout(() => { stop(); setMessage(heard ? 'Microphone check complete. Signal detected.' : 'No microphone signal detected. Check your input device and try again.'); }, 10000);
      cleanup.current = () => { clearInterval(meter); clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); if (context) { contexts.current.delete(context); void context.close(); } };
    } catch (error) {
      stream?.getTracks().forEach(t => t.stop()); if (context) { contexts.current.delete(context); void context.close(); }
      if (ticket !== generation.current) return;
      stop(); setMessage(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone permission denied. Allow access in your browser settings.' : error instanceof Error ? error.message : 'Microphone check failed.');
    }
  }
  async function speakerTest() {
    let context: AudioContext | undefined;
    try {
      context = new AudioContext(); contexts.current.add(context); await context.resume();
      const oscillator = context.createOscillator(); const gain = context.createGain();
      oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0, context.currentTime); gain.gain.linearRampToValueAtTime(.1, context.currentTime + .05); gain.gain.linearRampToValueAtTime(0, context.currentTime + .65);
      oscillator.start(); oscillator.stop(context.currentTime + .7);
      oscillator.onended = () => { if (context) { contexts.current.delete(context); void context.close(); } };
      setMessage('Playing a short tone. If you cannot hear it, check your speaker volume or headphones.');
    } catch { if (context) { contexts.current.delete(context); void context.close(); } setMessage('Speaker test could not play. Check browser sound permissions.'); }
  }
  return <div className="audio-check"><div className="small-kicker">BEFORE YOU CALL</div><div className="audio-check-buttons"><button className="button secondary" disabled={disabled} onClick={() => void checkMic()}><Mic size={15}/>{checking ? 'Stop mic check' : 'Check microphone'}</button><button className="button secondary" disabled={disabled} onClick={() => void speakerTest()}><Volume2 size={15}/>Test speaker</button></div><meter aria-label="Microphone test level" min={0} max={1} value={level}/><p role="status">{message}</p></div>;
}
