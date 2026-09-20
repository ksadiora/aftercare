# Voice setup: make the phone ring

## In-app call (default)

`CALLS_PROVIDER=app` (what `.env.example` ships) rings a browser instead of a phone number. No carrier, no keys, no public URL. The one dependency is that the laptop and the phone share a Wi-Fi network.

**How it works.** The web app serves a second route, `/phone`. A phone that opens it and taps **Pair** registers with the doctor's agent (`POST /api/phone/register`, a device name and nothing else) and holds a WebSocket. When the verified brand agent decides to call, the server flips the call to `ringing` and the phone shows an iOS-style incoming-call screen with a ringtone and vibration. **Accept** (`POST /api/phone/answer`) returns the opening line; the phone speaks it, listens with the browser's speech recognition, and posts each thing the doctor says to `POST /api/phone/turn`. `server/src/call/dialogue.ts` decides the reply: drug questions go to `label_lookup`, "send samples" goes to `request_samples`, and the signed agreement lands on the console mid-call. No answer within 45 s ends the call as no-answer and the update goes to the inbox. If no phone is paired when the brand calls, the simulated (scripted) call runs instead, so the console demo works alone. If the phone's speech recognition is unavailable, the phone app has a type-to-talk field. Code: `server/src/call/app.ts`, `web/src/phone/`.

**Pairing and the QR.** Press backtick on the console; the presenter panel shows a QR code of the LAN URL, for example `https://10.101.6.210:5173/phone`. The server lists every non-loopback IPv4 address on the machine (`GET /api/phone/state` returns them as `urls`). Set `PHONE_URL` to pin a specific one (a travel router's address, or a hostname); `PHONE_PORT` and `PHONE_SCHEME` cover a moved Vite. Scan it, tap **Pair**. The newest registration wins, so re-pairing a different phone just works, and the panel shows the device name and when it was last seen.

**HTTPS on the LAN.** Browsers only allow the microphone (getUserMedia, SpeechRecognition) on secure origins, so Vite serves https with a self-signed certificate (`@vitejs/plugin-basic-ssl`). On the phone, accept the warning once (iOS Safari: *Show Details → visit this website*; Android Chrome: *Advanced → Proceed*). iOS Safari and Android Chrome both allow the microphone on https after that. On the laptop, open `https://localhost:5173` and accept it there too. Set `VITE_NO_SSL=1` to go back to plain http; that is for localhost only, since a phone on http gets no microphone.

**Better voice (optional).** With `ELEVENLABS_API_KEY` set, the phone fetches each agent line as audio from `GET /api/phone/tts` (ElevenLabs text-to-speech, model `eleven_flash_v2_5`, the Rachel voice by default). `ELEVENLABS_VOICE_ID` picks another voice and `ELEVENLABS_TTS_MODEL` another model; both are optional. With no key, or on any error, the endpoint returns 204 and the phone uses the browser's own speechSynthesis. `GET /api/phone/state` reports which engine is active as `voice`.

**Real-time engine (optional).** With `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` both set, `GET /api/phone/session` returns a signed URL for an ElevenLabs real-time agent session (voice in and out over WebRTC/WebSocket, interruptions). The phone then runs the conversation through that agent, whose client tools call `/api/tools/label_lookup` and `/api/tools/request_samples` on this server over the LAN. Build the agent as in section 3 below. Without both keys the endpoint returns `{ "engine": "browser" }` and the turn-by-turn flow above is used.

**Env for the in-app call.**

```
CALLS_MODE=real          # mock forces the simulated call even with a phone paired
CALLS_PROVIDER=app
ELEVENLABS_API_KEY=      # optional, better voice
ELEVENLABS_VOICE_ID=     # optional
ELEVENLABS_AGENT_ID=     # optional, real-time engine
PHONE_URL=               # optional, pin the QR URL
```

`effectiveModes()` reports `calls=real` only while a phone is paired, so the startup banner says `calls=mock` until one pairs. That is expected.

Everything below this line covers the **PSTN alternatives**: a real phone number dialed through Twilio direct or ElevenLabs Agents. The demo does not need any of it.

---

# PSTN alternatives

The PSTN carriers place the doctor's call through **Twilio** directly, or through **ElevenLabs Agents** (Conversational AI) over a **Twilio** number. On the ElevenLabs path, ElevenLabs owns the phone leg, runs the voice agent, and calls two webhook tools on our server mid-call. This is the click-by-click. Budget 25 minutes the first time.

What the code does once this is set up (`server/src/call/provider.ts`, `webhooks.ts`, `elevenlabs.ts`):

1. `placeCall()` → `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call` with the five dynamic variables.
2. Screen goes `queued → dialing → ringing` as soon as ElevenLabs accepts.
3. A poller reads `GET /v1/convai/conversations/{id}` every 2 s: first transcript turn → `in-progress`, lines stream in, `processing/done` → `ended`. **This works with no public URL**, so a plain `npm run dev` on a laptop shows a live transcript.
4. If `PUBLIC_BASE_URL` is reachable from the internet, the ElevenLabs post-call webhook delivers the authoritative transcript (deduped) and the two tools work. **The tools need the public URL; the ring and transcript do not.**

---

## Fast path: Twilio only, no ElevenLabs

`CALLS_PROVIDER=twilio` makes a real phone ring with **nothing but a Twilio account**. Twilio dials, speaks with a neural voice, listens with speech recognition, and posts each thing the doctor says to our server, which answers from the label and runs the sample negotiation. Ten minutes to a ring.

1. Do **section 1** below (buy a number, copy Account SID and Auth Token, verify the judge's phone on a trial account or upgrade and load ~$20).
2. In `.env`:
   ```
   CALLS_MODE=real
   CALLS_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC…
   TWILIO_AUTH_TOKEN=…
   TWILIO_FROM_NUMBER=+1XXXXXXXXXX      # the Twilio number you bought, E.164
   ```
3. Test the ring: `npm run test-call -- +1yourphone`. It prints `queued → ringing → in-progress → completed` as Twilio reports it.
4. Restart the server (`npm run dev`). "Brand calls" now rings the number set in the demo panel.

**Two-way conversation needs a public URL.** With `PUBLIC_BASE_URL=http://localhost:8787` the call is *announce only*: the phone rings, the agent reads the update and hangs up. For the real demo (judge talks back, asks for samples) Twilio must be able to fetch TwiML from us:

- Laptop: `ngrok http 8787` (free account at ngrok.com), then set `PUBLIC_BASE_URL=https://<random>.ngrok-free.app` and restart.
- Vultr: `PUBLIC_BASE_URL=https://<your domain>` once Caddy is up.

Then the flow is: Twilio hits `/api/twilio/voice/start`, our server returns `<Gather input="speech">` with the opening line, each doctor utterance posts to `/api/twilio/voice/turn`, and the server replies from `label/` or runs `negotiate/`. Status callbacks land on `/api/webhooks/twilio/status`; polling covers the localhost case.

Voice: `TWILIO_VOICE` defaults to `Polly.Joanna-Neural`. Other good ones: `Polly.Matthew-Neural`, `Google.en-US-Neural2-F`. List: <https://www.twilio.com/docs/voice/twiml/say/text-speech#available-voices-and-languages>.

Trade-off versus ElevenLabs: the voice is a little less natural and each turn has ~1 s of think time, but there is no second dashboard to configure, no agent minutes to run out of, and the whole conversation logic lives in `server/src/call/twilio.ts` where you can change it in one place. Switch to `CALLS_PROVIDER=elevenlabs` any time; the sections below cover that path.

---

## 0. Accounts and the two caveats

**Twilio trial caveat.** A trial account can only call numbers you have verified under *Phone Numbers → Manage → Verified Caller IDs* (SMS verification only on trial), and it plays a "trial account" message before the agent speaks. Either verify the judge's phone that way, or **Upgrade** the account and load about **$20** (calls are ~1.4¢/min, a US local number ~$1.15/mo) so any US number can be dialed and the trial message goes away. Sources: <https://support.twilio.com/hc/en-us/articles/360036052753-Twilio-Free-Trial-Limitations>, <https://www.twilio.com/docs/api/errors/21608>.

**ElevenLabs plan caveat.** Agents minutes are metered per workspace: Free ≈ 15 min/month, Starter ($5–6) ≈ 75 min, Creator ($22, $11 first month) ≈ 275 min; overage about $0.08/min on paid plans. Twilio outbound calling is available on every plan including Free, but Free burns through its 15 minutes in a handful of test calls, so put the workspace on **Starter or Creator before the demo** and watch *Usage* in the dashboard. Free-tier concurrency is also low (a few simultaneous calls), which is fine for one demo call. Sources: <https://elevenlabs.io/pricing/agents>, <https://elevenlabs.io/docs/help-center/product/eleven-agents/can-i-connect-twilio-to-eleven-agents>. Numbers above were read from the pricing page on 2026-09-18; re-check the page, they change.

You need: an ElevenLabs account (elevenlabs.io), a Twilio account (twilio.com), and a public HTTPS URL for the server (Vultr domain, or `ngrok http 8787` for a laptop).

---

## 1. Twilio: get a number

1. Twilio Console → **Phone Numbers → Manage → Buy a number** → country US, tick *Voice* → **Search** → **Buy** one. (Trial: you get one free number, use that.)
2. Copy from the Console home page: **Account SID** (`AC…`) and **Auth Token** (click *show*).
3. Trial only: **Phone Numbers → Manage → Verified Caller IDs → Add a new Caller ID** → enter the judge's phone → verify by SMS code.

Nothing else to configure on the Twilio side. ElevenLabs drives the call through Twilio's API with these credentials.

---

## 2. ElevenLabs: import the Twilio number

1. elevenlabs.io → left sidebar **Agents** (product is labelled *ElevenAgents* / *Conversational AI* depending on rollout) → **Phone numbers** → **Import number** (or **Add phone number → Twilio**).
2. Fill in: **Label** `Callsign demo`, **Phone number** the Twilio number in E.164 (`+1540…`), **Twilio Account SID**, **Twilio Auth Token** → **Import**.
3. Open the imported number. The URL and the detail panel show the **phone number id** (looks like `phnum_…`). That is `ELEVENLABS_PHONE_NUMBER_ID`. If you can't find it: `npm run test-call -- --numbers` lists every imported number with its id (needs `ELEVENLABS_API_KEY` first).
4. Leave *Assigned agent* empty for now; you'll pick the agent in the next step, and outbound calls name the agent explicitly anyway.

Docs: <https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration>

---

## 3. ElevenLabs: create the agent

**Agents → Agents → Create agent → Blank template**. Name it `Stelazio brand agent`.

### Agent tab

**First message** (paste exactly; the double braces are dynamic variables filled in by our server on every call):

```
{{doctor_name}}, this is the verified {{brand}} agent calling through Callsign. {{update_summary}} It affects {{affected_patients}} of your patients. Do you want the one-line change now, or should I send it to your inbox?
```

**System prompt** (paste exactly):

```
You are the {{brand}} brand agent, a verified AI assistant calling a physician through the Callsign network. You are speaking on the phone with {{doctor_name}}, a {{specialty}} physician. Keep every turn under two sentences. Be warm, brisk and plain-spoken; this is a busy clinician between patients.

Why you are calling: {{update_summary}} This affects {{affected_patients}} of the doctor's patients.

Rules:
- Never give clinical advice or opinions. When asked anything about the drug (dosing, warnings, interactions, contraindications, samples policy), call the label_lookup tool with the doctor's question and read back the answer and its citation verbatim. If label_lookup says it is not covered, say so and offer to send the full prescribing information.
- If the doctor asks for samples, a delivery, or says "send samples", call the request_samples tool with the doctor's exact words. Read the confirmation sentence back verbatim. Do not invent quantities or dates.
- If the doctor asks who you are or whether this is real, say: your identity was verified by the doctor's Callsign agent through the Agent Name Service before the phone rang, and the doctor can see the verification on their screen.
- If the doctor says they are busy or asks you to email instead, say you will send it to their inbox and end the call.
- Do not discuss other products, pricing, or anything outside the label.
- End the call politely once the doctor has what they need. Do not linger.
```

**Dynamic variables** section: add the five names with placeholder test values so the *Test agent* button works: `doctor_name` = `Dr. Priya Patel`, `brand` = `Stelazio`, `update_summary` = `New renal dosing guidance for Stelazio: reduce to 5 mg once daily when eGFR is below 45.`, `affected_patients` = `2`, `specialty` = `Cardiology`. (Our server also sends `callsign_call_id`; you can add it too, value `test`. It is optional.)

**LLM**: any fast model (Gemini 2.5 Flash or GPT-4o mini are fine). Temperature 0.3. **Voice** tab: pick any voice; a lower *stability* sounds more natural on the phone. **Max conversation duration** (Advanced): 300 s.

Docs on variables: <https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables>

### Tools: the two webhooks

Agent → **Tools** → **Add tool → Webhook**. Create both. `PUBLIC_BASE_URL` below is your public server URL with no trailing slash (e.g. `https://abc123.ngrok-free.app` or `https://patel.callsign-hcp.com`).

**Tool 1: `label_lookup`**

| Field | Value |
|---|---|
| Name | `label_lookup` |
| Description | `Look up a question about the drug in its current prescribing information (label). Use for ANY question about dosing, renal adjustment, warnings, interactions, contraindications, adverse reactions, pregnancy or samples policy. Returns a short answer and a citation to read aloud.` |
| Method | `POST` |
| URL | `PUBLIC_BASE_URL/api/tools/label_lookup` |
| Headers | `Content-Type: application/json` |
| Body parameters | content type JSON. Add: `question` — type *String*, value type *LLM prompt*, description `The doctor's question, in their words.` Required. Add: `conversation_id` — type *String*, value type *Dynamic variable*, variable `system__conversation_id`. Not required. |
| Response timeout | 20 s |

Server returns `{"answer": string, "citation"?: string, "found": boolean}` (`shared/src/index.ts` → `LabelLookupResponse`). The whole JSON body is handed to the LLM as the tool result; the prompt tells it to read `answer` and `citation` verbatim.

**Tool 2: `request_samples`**

| Field | Value |
|---|---|
| Name | `request_samples` |
| Description | `Ask the brand to send professional samples to the doctor's practice. Call this whenever the doctor asks for samples, a shipment, or a delivery. Pass the doctor's exact words. Returns a one-sentence confirmation to read back.` |
| Method | `POST` |
| URL | `PUBLIC_BASE_URL/api/tools/request_samples` |
| Headers | `Content-Type: application/json` |
| Body parameters | JSON. `request` — *String*, *LLM prompt*, description `What the doctor asked for, verbatim, e.g. "send samples for Tuesday".` Required. `conversation_id` — *String*, *Dynamic variable* `system__conversation_id`. Not required. |
| Response timeout | 20 s |

Server returns `{"confirmation": string, "negotiationId": string, "status": "agreed"|"failed"}` (`RequestSamplesResponse`). The negotiation takes ~3.5 s server-side and lands on the screen while the call is still going.

Equivalent JSON schema for the two bodies, if the UI offers a raw schema editor instead of the parameter table:

```json
{ "type": "object", "properties": { "question": { "type": "string", "description": "The doctor's question, in their words." } }, "required": ["question"] }
```
```json
{ "type": "object", "properties": { "request": { "type": "string", "description": "What the doctor asked for, verbatim." } }, "required": ["request"] }
```

Test each tool with the **Test** button in the tool editor (or `curl -X POST PUBLIC_BASE_URL/api/tools/label_lookup -H 'content-type: application/json' -d '{"question":"renal dosing"}'`) before a live call.

Docs: <https://elevenlabs.io/docs/agents-platform/customization/tools/server-tools>

### Security tab

- **Enable overrides**: leave off (we do not override the prompt per call; variables are enough).
- **Enable authentication**: off (outbound calls are placed with the API key).

Click **Save**. Copy the **Agent ID** from the agent's *Settings* / the URL (`agent_…`). That is `ELEVENLABS_AGENT_ID`.

Back in **Phone numbers**, open the Twilio number and set **Assigned agent** to this agent (needed only if someone calls the number back; outbound calls pass the agent explicitly).

---

## 4. ElevenLabs: post-call webhook (needs the public URL)

1. **Agents → Settings** (workspace settings for Agents; the page is labelled *ElevenAgents settings* / *Conversational AI settings*) → **Post-call webhook** → **Create webhook**.
2. Name `callsign`, URL `PUBLIC_BASE_URL/api/webhooks/elevenlabs`, auth method **HMAC**. Save.
3. It shows a **webhook secret** once. Copy it into `ELEVENLABS_WEBHOOK_SECRET`.
4. Tick **Send transcription** (we don't need *Send audio*).
5. On the agent's **Analysis** / **Advanced** tab, check that the post-call webhook is enabled for this agent (defaults to the workspace webhook).

Docs: <https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks>

**Signature check.** With the secret set, `webhooks.ts` verifies `ElevenLabs-Signature: t=<unix>,v0=<hex>` where `v0 = HMAC-SHA256(secret, "<t>.<raw body>")`, 30-minute tolerance, any `v0` matching passes (mirrors the SDK's `constructEvent`). The HMAC must run over the exact bytes ElevenLabs sent. `server/src/index.ts` currently runs `express.json()` before our router, which discards the raw bytes; the handler falls back to re-serialising `req.body`, which only matches if ElevenLabs sends compact JSON. **Ask whoever owns `index.ts` to capture the raw body** (one line):

```ts
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
```

Until that lands, either leave `ELEVENLABS_WEBHOOK_SECRET` empty (webhook accepted unverified; fine behind an unguessable tunnel URL, the poller still gives the screen the transcript) or set it and confirm in the server log that deliveries are not being rejected with `signature mismatch`.

---

## 5. Twilio status callback (optional)

`POST /api/webhooks/twilio/status` maps Twilio `CallStatus` (`ringing`, `in-progress`, `completed`, `busy`, `no-answer`, `failed`) onto the screen for a known `CallSid`. ElevenLabs creates the Twilio call itself and the outbound-call API has no field for a StatusCallback URL, so nothing points here by default. Instead, if `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set, the poller also reads `GET /2010-04-01/Accounts/{sid}/Calls/{CallSid}.json` and gets a true *ringing* → *answered* transition a second or two earlier than the first transcript turn. Recommended: set both; harmless if not.

---

## 6. `.env`

```
CALLS_MODE=real
CALLS_PROVIDER=elevenlabs
PUBLIC_BASE_URL=https://<your public host>      # no trailing slash
ELEVENLABS_API_KEY=sk_...                       # elevenlabs.io → profile → API keys; needs Agents (Conversational AI) read+write
ELEVENLABS_AGENT_ID=agent_...
ELEVENLABS_PHONE_NUMBER_ID=phnum_...
ELEVENLABS_WEBHOOK_SECRET=wsec_...              # optional, see §4
TWILIO_ACCOUNT_SID=AC...                        # optional, see §5
TWILIO_AUTH_TOKEN=...                           # optional
```

`effectiveModes()` in `config.ts` only reports `calls=real` when the API key, agent id and phone number id are all present; otherwise the server silently stays on mock. The startup banner prints the modes; check it says `calls=real`.

Optional knobs: `ELEVENLABS_POLL_MS` (default 2000), `ELEVENLABS_API_BASE` (default `https://api.elevenlabs.io`; EU residency workspaces use `https://api.eu.residency.elevenlabs.io`).

---

## 7. Test the ring in 10 seconds

```bash
npm run test-call -- +15405551234
```

Prints `accepted conversation=conv_… callSid=CA…`, then the status and transcript as the call runs. No server needed, no public URL needed. Ctrl+C stops the printout (not the call; hang up the phone).

Then the full flow: `npm run dev`, set the phone in the demo panel, press *Verified brand call*. Expected on screen: `dialing` (API call, ~1 s) → `ringing` → `in-progress` when the doctor answers → transcript lines every 2 s → `ended`. Ask the agent "what's the renal dosing?" (label_lookup fires) and "send samples for Tuesday" (request_samples fires and the negotiation card animates).

Common failures, all surfaced as one line in the call's `error` field and the audit log:

| Error | Cause |
|---|---|
| `-> 401` | wrong API key or key lacks Agents permission |
| `-> 422: body.agent_phone_number_id …` | wrong phone number id; run `--numbers` |
| `-> 402` / `-> 429` | out of Agents minutes or concurrency; upgrade the ElevenLabs plan |
| call `failed`, reason `21608` / *unverified number* in the ElevenLabs call history | Twilio trial calling an unverified number; verify it or upgrade Twilio |
| `ended` immediately with no transcript, phone never rang | Twilio number has no voice capability or the Auth Token changed; re-import the number |

---

## Doc uncertainties (checked 2026-09-18)

- The ElevenLabs docs are mid-rename (`/docs/agents-platform/…` and `/docs/eleven-agents/…` both resolve; the UI says *ElevenAgents* in places and *Conversational AI* in others). Menu names above may differ by a word.
- The post-call webhook docs describe the signature only through the SDK's `constructEvent`; the `t=…,v0=…` / `HMAC-SHA256("<t>.<body>")` / 30-minute scheme is taken from the SDK source (<https://github.com/elevenlabs/elevenlabs-js/blob/main/src/wrapper/webhooks.ts>).
- `call_initiation_failure` webhook payload: docs show `data.failure_reason` plus provider `metadata`; we read `failure_reason` only.
- `data.metadata.phone_call.call_sid` in the post-call payload: the get-conversation reference lists `phone_call` as an opaque provider object; we read `call_sid` from it opportunistically and never depend on it.
- The tool body parameter *value type* "Dynamic variable" with `system__conversation_id` is documented; whether the parameter table lets you mark it optional varies by UI version. If it can't be optional, drop the `conversation_id` parameter entirely: the server falls back to the active call.
- Pricing/minutes figures are from third-party summaries of the pricing page; confirm on <https://elevenlabs.io/pricing/agents> before relying on a number.
