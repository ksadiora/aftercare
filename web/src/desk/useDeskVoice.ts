import { useCallback, useEffect, useRef, useState } from "react";
import { createListener, speechSupported, speechUnavailableReason, type Listener } from "../phone/speech.ts";

type VoiceRole = "screener" | "doctor";
export function useDeskVoice(elevenlabs: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const blob = useRef<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const recognition = useRef<Listener | null>(null);
  const generation = useRef(0);
  const enabledRef = useRef(false);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const stop = useCallback(() => {
    generation.current++;
    pending.current?.abort();
    pending.current = null;
    player.current?.pause();
    player.current = null;
    if (blob.current) URL.revokeObjectURL(blob.current);
    blob.current = null;
    window.speechSynthesis?.cancel();
    utterance.current = null;
    setSpeaking(false);
  }, []);
  const stopListening = useCallback(() => {
    recognition.current?.abort();
    recognition.current = null;
    setListening(false);
  }, []);
  useEffect(() => () => { stop(); stopListening(); }, [stop, stopListening]);

  const speak = useCallback(async (text: string, role: VoiceRole, force = false) => {
    if (!enabledRef.current && !force) return;
    stop();
    stopListening();
    setNotice("");
    const token = generation.current;
    setSpeaking(true);
    if (elevenlabs) {
      const controller = new AbortController();
      pending.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await fetch("/api/desk/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, role }), signal: controller.signal });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error || `Voice request failed (${response.status}).`);
        }
        const audio = await response.blob();
        if (generation.current !== token) return;
        blob.current = URL.createObjectURL(audio);
        const element = new Audio(blob.current);
        player.current = element;
        element.onended = () => { if (generation.current === token) stop(); };
        element.onerror = () => { if (generation.current === token) { stop(); setNotice("Audio playback failed. The full reply is in the transcript."); } };
        await element.play();
      } catch (error) {
        if (generation.current !== token) return;
        stop();
        setNotice(error instanceof Error && error.name !== "AbortError" ? `${error.message} Use the transcript or replay the reply.` : "Voice timed out. The reply is available in the transcript.");
      } finally { window.clearTimeout(timeout); }
      return;
    }
    if (!("speechSynthesis" in window)) {
      setSpeaking(false);
      setNotice("This browser has no speech playback. Replies remain available as text.");
      return;
    }
    const line = new SpeechSynthesisUtterance(text);
    utterance.current = line;
    line.lang = "en-US";
    line.rate = 1;
    line.onend = () => { if (generation.current === token) setSpeaking(false); };
    line.onerror = (event) => {
      if (generation.current !== token) return;
      setSpeaking(false);
      if (event.error !== "canceled" && event.error !== "interrupted") setNotice("Browser voice could not play. The reply is available as text.");
    };
    window.speechSynthesis.speak(line);
  }, [elevenlabs, stop, stopListening]);

  const dictate = useCallback((onText: (text: string) => void) => {
    if (listening) { recognition.current?.stop(); return; }
    stop();
    setNotice("");
    if (!speechSupported()) { setNotice(speechUnavailableReason()); return; }
    setListening(true);
    recognition.current = createListener({
      onInterim: () => undefined,
      onFinal: (text) => { setListening(false); onText(text); },
      onError: (code) => { setListening(false); setNotice(code === "no-speech" ? "No speech was heard. Try again or type your message." : speechUnavailableReason(code)); },
    });
    recognition.current.start();
  }, [listening, stop]);

  const toggle = () => {
    if (enabled) { enabledRef.current = false; stop(); setEnabled(false); }
    else { enabledRef.current = true; setEnabled(true); setNotice(elevenlabs ? "ElevenLabs voice enabled." : "Browser voice enabled. Add an ElevenLabs key for natural voice."); }
  };
  return { enabled, toggle, speak, stop, stopListening, dictate, notice, speaking, listening };
}
