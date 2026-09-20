# Callsign — Devpost submission

**Tagline:** An AI agent has to prove who it is before a physician's phone rings.

**Prize categories to tick**

- Impiricus
- GoDaddy: Best use of ANS
- Cloudforce: HokieAI Side Kick
- MLH: Best Use of ElevenLabs
- MLH: Best Use of Gemini API
- MLH: Best Use of Vultr
- MLH: Best Use of GoDaddy Registry (domain)

---

## Inspiration

Impiricus reaches over a million opted-in physicians by SMS. It works, but SMS has a ceiling: a text cannot answer a follow-up question, cannot prove who sent it, and cannot get anything done. Meanwhile pharma-themed phishing against prescribers is growing, and the one thing a doctor cannot do at 2 pm between patients is figure out whether "Stelazio Safety Team" is real.

We asked what the channel after SMS looks like if you take both problems seriously. The answer we landed on: don't message the doctor, message the doctor's agent. Give every physician a personal agent with a verifiable, domain-anchored identity, let brands reach that agent, and let the agent decide, on the doctor's terms, whether a phone call is worth it. Then make the call itself useful: read the update, answer questions from the label only, and close the loop on samples while the doctor is still on the line.

## What it does

Callsign is a personal agent for a physician. Dr. Priya Patel, a cardiologist in Blacksburg, has one at `patel.callsign-hcp.com`.

1. **A brand agent sends a reach request** (an A2A-style signed message) to Dr. Patel's agent: "New renal dosing guidance for Stelazio, section 2.3 updated, 2 of your patients are affected."
2. **Her agent verifies the sender before anything happens.** It resolves the sender's name through GoDaddy's Agent Name Service, checks the certificate chain and that the SAN matches the claimed name, checks the transparency-log receipt, verifies the message signature against the certificate's key, and finally applies Dr. Patel's own policy: relevant to cardiology, inside her call window, sender not muted. Every step animates on the trust card.
3. **An impostor gets nowhere.** `stelazio-updates.xyz`, claiming to be Stelazio, fails at the very first step (no ANS record) and is quarantined. The phone never rings.
4. **The verified brand gets a call.** Her phone is a browser page on her own device that paired itself with her agent over Wi-Fi (in the demo, the judge scans a QR code on the console and taps Pair). It rings and vibrates with an incoming-call screen; she taps Accept and the brand's voice agent reads the one-line update and offers to send the detail to her inbox. The same verification can instead place a real phone call through the Twilio or ElevenLabs Agents carriers we also built.
5. **Questions are answered from the label, and only the label.** She asks "What about kidney function?"; the phone transcribes it in the browser and her agent's `label_lookup` tool asks Gemini to answer strictly from the published prescribing information, in under two sentences, with a section citation. The phone speaks the answer with ElevenLabs text-to-speech (or the browser's own voice when no key is set). If the label doesn't cover it, the agent says so and offers the full document. No clinical advice, ever.
6. **Samples are negotiated agent to agent.** "Send two boxes next Friday" triggers a signed exchange between the two agents: verify peer, check the state license, check PDMA eligibility, propose, agree, sign. Both signatures land on the console in under five seconds, while the doctor is still talking. An expired license fails the negotiation with a readable reason.
7. **Everything is auditable.** Inbox, verification results, call transcripts, negotiations and the audit log are held in memory for the running demo. There is no phone number to persist: the phone paired itself and is known only by a device name.

## How we built it

- **Shared contracts first.** One TypeScript file (`shared/src/index.ts`) defines every type the server and the browser exchange: reach requests, verification steps, calls, phone state, negotiations, the WebSocket event union. Four people worked in parallel without stepping on each other.
- **The doctor's agent** is an Express + WebSocket server. `agent.ts` is deliberately tiny: verify, then exactly one of call, inbox, or quarantine. Every module (verification, calls, label lookup, negotiation, persistence) ships a mock that runs with no keys and a real implementation switched by `ANS_MODE`, `CALLS_MODE`, `LLM_MODE`.
- **Identity** uses GoDaddy ANS: each agent is a domain name with DNS records, a certificate whose SAN is the agent name, and a transparency-log receipt. Messages are signed with ECDSA P-256; the verifier trusts the ANS-anchored certificate, never the PEM a sender attaches.
- **Voice** is an in-app call. The phone is a second route (`/phone`) in the same Vite app, opened on the judge's own device over the venue Wi-Fi; it registers with the doctor's agent (`POST /api/phone/register`, a device name and nothing else) and holds a WebSocket. When the agent decides to call, the phone rings: a Web Audio ringtone, the Vibration API, an incoming-call screen. On Accept the server returns the opening line; the phone speaks it (ElevenLabs text-to-speech through `/api/phone/tts`, or the browser's speechSynthesis with no key), listens with the Web Speech API, and posts each utterance to `/api/phone/turn`. One module, `call/dialogue.ts`, decides what the agent says next and is shared by every carrier: drug questions go to `label_lookup`, anything transactional to `request_samples`. Vite serves https on the LAN with a self-signed certificate because browsers only unlock the microphone on secure origins. Two PSTN carriers sit behind the same interface, Twilio direct (TwiML `<Gather>`, any Twilio account) and ElevenLabs Agents with webhook tools, and an optional real-time ElevenLabs agent session (`/api/phone/session`) gives the in-app phone streaming voice and interruptions when an agent id is configured.
- **Gemini** (`gemini-3.8-flash` over the AI Studio REST API, no SDK) answers label questions with a system prompt that forbids anything not in the label text and asks for JSON `{found, answer, citation}`. Replies are parsed defensively, section numbers are validated against the real label, and any failure falls back to a keyword lookup so the call never stalls. In the negotiation, Gemini only rephrases transcript lines from structured facts; the facts (license status, eligibility, terms, hash, signatures) are always computed deterministically.
- **In-memory state** holds demo inbox items, proofs, and audit events until restart; browser history stores recent desk conversations locally. No database is configured.
- **The console** is Vite + React, a clean light console: a trust card that animates the five checks, the inbox with quarantine reasons, the live call transcript, the negotiation log with both signatures, and a presenter panel that shows the pairing QR code.
- **Hosting** on Vultr behind the agent's real ANS-registered domain, so brand agents reach `patel.callsign-hcp.com` and the PSTN carriers' webhooks have a public URL. The demo itself needs none of that: the console and the phone talk over the venue Wi-Fi, and the whole flow runs on one laptop with no public URL.

## Challenges we ran into

- **Keeping the negotiation under five seconds** so it lands mid-call. We budget 3.4 s of phase timing and cap the Gemini rephrasing at 1.2 s, running it before the first phase so the transcript never stutters.
- **Making an LLM safe on a medical call.** The answer was to give Gemini nothing to invent: the label is the only context, the output is structured, the section number is checked against the actual label, and the fallback is a deterministic keyword match.
- **Not collecting a phone number at all.** Our first cut dialed a number typed into the presenter panel and spent effort masking and scrubbing it. Moving the phone into the browser removed the number entirely: the device pairs itself, the agent rings it over a WebSocket, and the scrubber stays as a guard for the PSTN carriers.
- **A microphone on a phone over LAN.** Browsers only unlock the microphone on secure origins, so Vite serves https with a self-signed certificate the phone accepts once. Speech recognition falls back to type-to-talk, and ElevenLabs text-to-speech falls back to the browser voice, so the call still works with nothing configured.
- **Four lanes, one weekend.** Mock-first design meant the demo worked end to end on day one and each real integration could land without breaking it.

## Accomplishments we're proud of

- The phone in the judge's own hand does not ring for the impostor, and does for the verified agent. That single moment explains the whole product.
- A signed agent-to-agent agreement, with both signatures, appearing on the console while the judge is still on the phone.
- A voice agent that will not give clinical advice, backed by code rather than a prompt promise.
- The entire flow, including a real ring on a real device, runs with zero keys and no public URL, and every real integration degrades gracefully.

## What we learned

- Agent identity is a naming problem. Once an agent is a domain with a certificate and a public log entry, verification becomes the same boring, reliable machinery the web already trusts.
- Physicians don't want more channels; they want fewer, trusted ones. A gate the doctor controls beats another inbox.
- Structured output plus validation makes LLMs usable in places where a hallucination is unacceptable.
- Compliance rules like PDMA sampling are easier to encode as an agent negotiation than as a form.
- The phone does not have to be a phone. Once the ring is a verified event delivered to a paired device, the carrier is a deployment choice, not the product.

## What's next

- Register real ANS names for a pilot set of physicians and a brand, with real key ceremonies.
- Make Impiricus's existing physician app the paired device, so the ring lands where the opt-in already lives.
- Let the doctor's agent learn preferences: which brands, which topics, which hours, which channel (call, inbox, or a rep visit).
- Extend the negotiation to CME invitations, advisory boards and rep scheduling, all signed.
- A brand-side dashboard: delivery receipts that prove who was reached, when, and what was agreed.
- A one-line integration for Impiricus: the same reach request that becomes an SMS today becomes a verified agent call tomorrow.

## Built with

- **TypeScript** (server, web and shared contracts)
- **Node.js 20+**, **Express**, **ws** (WebSocket), **cors**, **tsx**
- **Vite**, **React**, **react-dom**, **@vitejs/plugin-react**, **@vitejs/plugin-basic-ssl** (https on the LAN), **concurrently**
- **GoDaddy Agent Name Service** (DNS, certificates, transparency log) and a **GoDaddy Registry** domain
- **ElevenLabs** (text-to-speech for the phone's voice; optional real-time Agents session; also the alternate `elevenlabs` carrier with webhook tools)
- **Twilio** (alternate PSTN carrier: outbound number, TwiML `<Gather>` speech)
- **Web Speech API** (speech recognition and synthesis on the phone), **Web Audio API** (ringtone), **Vibration API**
- **qrcode** (the pairing code on the console)
- **Google Gemini API** (`gemini-3.8-flash`, AI Studio REST API)
- **In-memory session storage**; state clears when the server restarts
- **Vultr** (cloud host)
- **Cloudforce HokieAI** (the "Second Opinion" Side Kick, see `docs/sidekick.md`)
- Node `crypto` (SHA-256, ECDSA P-256), Mermaid for the architecture diagram
