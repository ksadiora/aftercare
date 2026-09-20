import { ProviderError, providerHttpError, readProviderBody } from "./http.ts";

// George is the public voice used by the official ElevenLabs TTS quickstart.
const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL = "eleven_multilingual_v2";
const MAX_TEXT_CHARACTERS = 2_000;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** A configured key has not necessarily been accepted by ElevenLabs. */
export function getElevenLabsConfiguration() {
  return {
    configured: Boolean(process.env.ELEVENLABS_API_KEY?.trim()),
    voiceConfigured: Boolean(process.env.ELEVENLABS_VOICE_ID?.trim()),
    model: process.env.ELEVENLABS_TTS_MODEL?.trim() || DEFAULT_MODEL,
  };
}

export async function synthesizeElevenLabsSpeech(
  text: string,
  role: "screener" | "doctor" = "screener",
): Promise<{ audio: Buffer; contentType: string }> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("ElevenLabs", "not_configured", "ElevenLabs is not configured. Add ELEVENLABS_API_KEY to the server environment.");
  const spokenText = text.trim();
  if (!spokenText || spokenText.length > MAX_TEXT_CHARACTERS) {
    throw new ProviderError("ElevenLabs", "invalid_input", `Speech must contain between 1 and ${MAX_TEXT_CHARACTERS} characters.`);
  }
  const roleVoice = role === "doctor"
    ? process.env.ELEVENLABS_DOCTOR_VOICE_ID?.trim()
    : process.env.ELEVENLABS_SCREENER_VOICE_ID?.trim();
  const voiceId = roleVoice || process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text: spokenText,
        model_id: getElevenLabsConfiguration().model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw providerHttpError("ElevenLabs", response.status);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType !== "audio/mpeg" && contentType !== "audio/mp3") {
      await response.body?.cancel();
      throw new ProviderError("ElevenLabs", "invalid_response", "ElevenLabs did not return MP3 audio.");
    }
    const audio = await readProviderBody(response, MAX_AUDIO_BYTES, "ElevenLabs");
    if (!audio.length) throw new ProviderError("ElevenLabs", "invalid_response", "ElevenLabs returned empty audio.");
    return { audio, contentType: "audio/mpeg" };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted) throw new ProviderError("ElevenLabs", "timeout", "ElevenLabs timed out. Please retry playback.");
    throw new ProviderError("ElevenLabs", "unavailable", "ElevenLabs could not be reached. Please retry playback.");
  } finally {
    clearTimeout(timeout);
  }
}
