# Gemini and ElevenLabs setup

The main desk separates the caller, the screening agent, and the doctor receiver. Caller messages are assessed automatically. A successful content screen can offer the doctor a call or message; it does not prove the caller's identity. The doctor receiver is a simulated conversation for this demo, not a clinician providing medical care.

## Configure the providers

Copy `.env.example` to `.env` at the repository root if `.env` does not already exist. Add your own keys without committing them:

```dotenv
GEMINI_API_KEY=your_google_ai_studio_key
GEMINI_MODEL=gemini-3.8-flash
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
```

Create the Gemini key in [Google AI Studio](https://aistudio.google.com/apikey). `gemini-3.8-flash` is a stable model listed in Google's [model catalog](https://ai.google.dev/gemini-api/docs/models), checked on September 19, 2026. Set `GEMINI_MODEL` to another model available to your project when needed. The desk uses Gemini whenever a key is present; `LLM_MODE` controls the older app screens only.

Create an ElevenLabs key with text-to-speech permission following [ElevenLabs authentication instructions](https://elevenlabs.io/docs/api-reference/authentication). The default desk voice is George, the voice in ElevenLabs' [API quickstart](https://elevenlabs.io/docs/eleven-api/quickstart). Use a voice available to your ElevenLabs account. Optional `ELEVENLABS_SCREENER_VOICE_ID` and `ELEVENLABS_DOCTOR_VOICE_ID` provide different voices for the two speakers; each falls back to `ELEVENLABS_VOICE_ID`, then George. The older paired-phone interface retains its own fallback voice when no shared voice is configured.

Restart the existing server after changing `.env`; environment values are loaded at startup. Keep only one development server for this project. Keys stay on the server and are sent only to their provider's HTTPS API. Never add these keys to `VITE_` variables or paste them into chat messages.

## What is live

With a Gemini key, the server requests structured screening output using Google's [Generate Content API](https://ai.google.dev/api/generate-content). The screening layer validates that output and displays evidence from the conversation. Doctor responses also use Gemini after the user accepts the screened call. This text integration is turn based; it is not a Gemini Live audio session.

With an ElevenLabs key, outgoing agent/doctor text can be synthesized through the [text-to-speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert). The server returns MP3 audio to the browser. Microphone recognition, where supported and enabled, is supplied by the browser; ElevenLabs supplies outgoing speech. These in-browser interactions do not place a carrier phone call or send an SMS.

Without provider keys, local screening and scripted doctor responses remain available and must be labeled as local. Provider configuration status means that a key exists, not that credentials, quota, model access, or voice access have been verified. A successful response establishes that the corresponding request worked. HTTP errors, timeouts, invalid model output, or non-audio responses are reported explicitly; the app must show any local fallback as local.

Screening uses what the caller says. It cannot authenticate organizations, independently verify a caller's phone number, or guarantee that an apparently routine caller is legitimate. No certificates or invented external verifications are required for the desk interaction. Use fictional call content when exercising the demo; the configured providers receive the conversation text necessary for their requests.

## Verify the complete interaction

1. Open the app in Chrome. Start a call and introduce a routine administrative reason for reaching the doctor. Observe the screening questions and the assessment before accepting the call in the doctor receiver.
2. Accept the screened call and send a follow-up message. Confirm that a successful configured Gemini request is labeled as Gemini, and that the doctor continues from the conversation context.
3. Enable speech and play a screening-agent or doctor response. Confirm successful ElevenLabs playback, or a visible error if provider access fails. Browser speech must be identified as browser speech if used.
4. Start a new interaction asking for a password, verification code, or unusual payment. Verify that the receiver is protected and that the evidence points to caller text.
5. Repeat with no keys and with an invalid key. Confirm clear local/configuration/error states, no fabricated provider success, and no key value in browser network responses or errors.

Provider helpers use 20-second request timeouts and cap response bytes. Speech input is limited to 2,000 characters per request. Gemini retries HTTP 503 once within its 20-second deadline; speech requests are not automatically retried. Calls may consume provider quota when keys are configured.
