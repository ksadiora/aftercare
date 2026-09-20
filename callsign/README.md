# Callsign

A calmer way to connect. Callsign screens an incoming conversation before it reaches a doctor's receiver.

The workspace has three connected panels: **caller → screening agent → doctor**. Type or dictate an original message, see the agent's assessment and quoted evidence, then accept or decline an approved call on the receiver. Every caller turn passes signed-agent verification, current doctor policy, and content screening before delivery. Turning off **Accept calls** holds contacts in the inbox with an explanation and keeps the phone silent. Policy is checked again at pickup and before doctor replies. Suspicious credential/payment requests are blocked; ambiguous requests receive follow-up questions. Allowed text messages are delivered directly. The doctor is clearly labeled as a simulated AI receiver, with contextual Gemini replies and an option to type as the doctor.

Screening assesses conversation content. It does **not** independently verify a caller's identity. Example prompts only populate the composer; they do not predetermine a verdict. Open **Identity checks** in the main navigation (`/#identity`) for the restored demo credential workbench: choose an identity, tamper with or replay a signed message, read the predicted failure, and run the five attack presets. Click any trust-card check to inspect evidence, open the standalone proof page, or scan its QR on a phone. The larger scenario deck remains at `/try`. Server-signed identities are explicitly labeled **demo credentials**; passing checks is not real-world identity proof.

## Run locally

Use Node 24 (or a compatible version listed in `package.json`).

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173. The server listens on 8787. Use only one development stack for this project; identify occupied ports before starting another server.

Set these in the ignored root `.env` file, then restart the server:

```dotenv
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.8-flash
ELEVENLABS_API_KEY=your-key
# Optional voice choices:
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
# ELEVENLABS_SCREENER_VOICE_ID=...
# ELEVENLABS_DOCTOR_VOICE_ID=...
```

The main workspace uses Gemini whenever its key is configured, independently of the legacy `LLM_MODE`. With no key, local screening and local replies remain usable and visibly labeled. Provider failures are disclosed. The Integrations dialog reports key configuration, not proof of a successful request. Enable voice in the header or replay an individual reply. ElevenLabs generates agent and doctor speech; without its key, the browser voice is explicitly labeled. The microphone uses browser speech recognition; typing works without microphone permission.

See [provider setup](docs/provider-setup.md) for configuration details.

## Data and scope

There is **no database**. Up to 30 conversation histories are saved in this browser's local storage; Activity → Clear history removes them. The server holds temporary sessions in memory for up to an hour. Restarting the server ends those sessions; the browser keeps their transcripts for review. API keys stay on the server and are never bundled into the web app.

With Gemini configured, conversation text is sent to Google for processing. With ElevenLabs voice enabled, outgoing speech text is sent to ElevenLabs. Use fictional information. This initial product draft is an in-browser demonstration, not a real phone carrier, clinical service, identity verification service, or production fraud guarantee. It makes no appointment bookings and gives no clinical advice.

## Checks and production build

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run scenarios:ci
npm start
```

The build is served by Express on http://localhost:8787. Run heavy checks sequentially and stop task-owned development servers before building. `npm test` discovers all regression tests and runs one test file at a time. `npm run scenarios:ci` starts its own temporary local-registry server (no provider keys), checks all catalogued outcomes and actual call creation, then stops it. Run it with the normal server stopped. For an existing server, use `npm run scenarios`. CI runs lint, typecheck, tests, build, and scenarios sequentially. Call-gating regressions cover missing/failed proofs, signatures and replays, content blocks, policy changes during asynchronous operations, manual replies, and decline.

## Main implementation

- `web/src/desk/`: three-panel UI, browser history, microphone and voice playback.
- `server/src/desk.ts`: temporary sessions, request-scoped progress streaming and conversation lifecycle.
- `server/src/desk-reach.ts`: fresh signed caller envelopes and registry provenance.
- `server/src/agent.ts`: shared `handleReach()` verification entry point and desk content gate.
- `server/src/screening.ts`: content screening, grounded evidence, and conservative local fallback.
- `server/src/providers/`: server-side Gemini and ElevenLabs adapters.
- `shared/src/desk.ts`: shared caller, screening, and receiver contracts.

The identity workspace reuses the existing workbench, attack picker, trust card, proof drawer, and phone receiver. Its proof and pairing QR codes use the current web protocol/port on a LAN address, or the configured public tunnel. Connect a phone to the same Wi-Fi for LAN links; microphone access requires HTTPS, while typed replies work over HTTP. Proof records are held in server memory and disappear after a reset or restart.
