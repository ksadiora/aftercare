# Aftercare

A synthetic post-discharge follow-up demonstration. Nurses get a risk-sorted worklist; demo patients get a structured English or Spanish check-in by voice or in writing; a nurse can escalate to a provider and hold a conversation with them, or open a live audio call with the patient. No Twilio account, paid Twilio plan, phone number, public tunnel, or cloud database is required.

**This repository is the host for the wider project.** It runs the server, owns the database, and owns the calling system. Other codebases are being merged *into* it — start at [docs/INTEGRATION.md](docs/INTEGRATION.md) if that is why you are here.

| Read this | For |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Writing code here: commands, layout, invariants, conventions, gotchas |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data model, request flow, live updates, run isolation |
| [docs/CALLING.md](docs/CALLING.md) | **The calling system**, in depth — four audio paths and why they differ |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | Merging another project in without breaking this one |
| [HANDOFF.md](HANDOFF.md) | What is verified, what is not, and claims that would be false |
| [HANDOFF-INTEGRATION.md](HANDOFF-INTEGRATION.md) | The Callsign escalation gate: what changed, how to run and deploy it, what to test |
| [deploy/README.md](deploy/README.md) | Infrastructure |

Everything below is how the product behaves and how to run it.

## Start the demo

Requires **Node.js 24 or newer** and npm.

```sh
npm install
npm run build
npm start
```

Open **http://127.0.0.1:4317**. Simulation works immediately without a `.env` file or API credits. Fonts are bundled locally. The app binds to localhost only.

For development, run `npm run dev` (Vite on 4317, API on 4318). Stop the production server before starting development on the same port.

## Two-minute walkthrough

1. Select **Miguel Alvarez** and open **Conversation**.
2. Keep **Simulation**, choose English or Español, and select **Wound concern**.
3. Click **Start simulation**. The patient’s exact response appears while the worklist changes to urgent review. A full scenario takes roughly 13 seconds.
4. Try **Emergency interrupt**. Routine questions stop; the fixed 911 instruction appears and the session ends. **No emergency number is dialed.**
5. Try **Transportation barrier**, **Uneventful recovery**, **Interrupted contact**, or **Request a person**.
6. Use **Acknowledge**, **Request callback**, **Escalate**, or **Resolve**. Resolving requires a nurse note; escalating does not, because it always carries an automated summary as well. A callback request records a task; it does not place a call.
7. Switch to **Full cohort** for forty patients. The three featured patients are callable; the other 37 are illustrative records. After Miguel’s wound scenario, the full cohort has three urgent cases.
8. **New demo** restores fresh patients and archives the previous run. **Demo history** retains its audit events. Earlier transcripts remain in SQLite; earlier check-ins within the current run are expandable in Conversation.

Printable English/Spanish participant cards: [open scenario cards](http://127.0.0.1:4317/scenario-cards.html). Use the browser’s Print command or the page’s Print button.

## Simulation audio

Simulation speaks **only the follow-up agent**, using your browser’s built-in English or Spanish voice. Patient responses remain text placeholders. Audio is on by default; toggle **Audio on / Audio off** to mute. Each question finishes before the next scripted answer is submitted, including the final emergency instruction. No microphone, ElevenLabs credits, or extra API permissions are needed. Voice availability and pronunciation depend on the browser and installed system voices; missing audio produces a visible message and the text scenario continues. End check-in stops playback immediately. Reloading the page ends a spoken simulation as interrupted and preserves its transcript.

To act as the patient and speak into the microphone, select **In-app call** instead. Nurse escalation currently creates a callback task; telephone transfers will be a later Twilio integration.

## Live in-app calls with ElevenLabs

In-app calling is implemented but needs an API key, a configured agent, microphone permission, and available **ElevenLabs** allowance. Having the ElevenLabs connector installed in Codex does not automatically give this local server an API key. Real voice usage may consume credits; simulation never calls ElevenLabs.

1. Copy `.env.example` to `.env`.
2. Set `ELEVENLABS_API_KEY` to a key with permission to create/read agents and start conversations. Keep it private; `.env` is ignored by Git.
3. Run `npm run voice:setup`. This creates one private demo agent with two client tools, a five-minute limit, and **audio recording disabled**. The voice is Matilda on `eleven_multilingual_v2` — an alto carries better for an older listener, and one multilingual model covers both languages instead of switching engines between English and Spanish. Override with `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL`. To change the voice on an agent that already exists, PATCH `conversation_config.tts` rather than re-running setup, which refuses to create a second agent. It does not buy a subscription or configure Twilio. The script refuses to create another agent if an agent ID is already configured.
4. Copy the printed `ELEVENLABS_AGENT_ID` into `.env` and restart the server.
5. Select **In-app call**, choose the conversation language, and use **Check microphone** and **Test speaker**. Click **Start call**, grant microphone permission, and speak as the synthetic participant. Use mute/unmute, speaker volume, and **End call** during the conversation. The microphone meter shows your input; the expandable transcript preserves original words. No scripted patient responses are sent in this mode.

Use the setup script’s agent rather than an unrelated existing agent: `get_next_step` and `finish_session` client tools drive the server-owned protocol. The backend checks that recording is off and signed-URL authentication is on before issuing a connection URL. API keys stay on the server. Only a short-lived signed WebSocket URL reaches the browser.

### Escalation: the nurse's words and the automated summary

Escalating opens a note box, and the note is optional. Whatever the nurse does or does not write, an automated summary of the check-in is attached alongside it, so a provider never opens a case that says only "please advise".

The two are recorded as **separate audit entries under separate attribution**. The nurse's note opens a conversation; the generated sentence sits outside it under "Automated case summary · DRAFT" with the model that wrote it. They are never merged, because they are different kinds of evidence and the provider decides how to weigh each.

From there it is **a two-way thread**. The provider answers or asks something back, the nurse answers them, and both screens render the same conversation — assembled from the audit trail rather than stored beside it, so a case can never hold a discussion the permanent record does not show. The nurse's copy sits above the tabs on the patient, visible whichever tab is open, and the worklist marks any case whose newest message came from a provider. Neither side's message changes the disposition: only the nurse's resolve closes a case.

If the model cannot answer — no key, exhausted quota, a patient with no check-in yet — the escalation still goes through and the summary is written from the intake rules instead: severity, the patient's own words, and which questions went unanswered. That entry is attributed to `Aftercare · intake rules (<why the model failed>)`, so a fallback is always visible as a fallback. Resolving a case still requires the nurse to write something; only a nurse closes a case.

Escalating also warms the briefing cache, so the provider's first **Prepare briefing** on that case costs no further model quota.

### Interruptions and background noise

A recovering patient shifts in a chair, sets a phone down, coughs. Unfiltered, each of those reaches ElevenLabs as “the participant started talking”, and the agent stops mid-question and loses its place. Two layers keep that from happening, because they catch different things.

**In the browser.** While the agent is speaking the microphone is held closed and `src/barge-in.ts` watches the true input level instead. It opens only once the level has stayed up for about 180 ms — longer than a knock, shorter than a syllable — and closes again after roughly a second of quiet, so gaps between words do not shut it. While the agent is *listening* the gate is not used at all, so an answer is never clipped; only a deliberate interruption is, by about the length of that attack window. The meter keeps reading the real microphone throughout, so the participant can see they are being heard even while the gate is shut. A browser without Web Audio simply leaves the microphone open: worse filtering is a smaller failure than a check-in that will not start.

**On the agent.** `conversation_config.turn` carries a short list of non-lexical fillers (`uh`, `hm`, `ah`, …) that are transcribed but do not take the floor, and the opening consent question cannot be interrupted at all. Every one-word reply the questionnaire actually accepts — yes, no, okay, sí, claro — is deliberately left off that list, and ElevenLabs’ own curated defaults are not merged in, because an ignore term that swallowed a consent answer would be far worse than an interruption.

To apply the agent-side settings to an agent that already exists:

```sh
npm run voice:setup -- --update
```

That PATCHes the configured `ELEVENLABS_AGENT_ID` in place; no `.env` change and no second agent. Setting `ELEVENLABS_TURN_MODEL=turn_v3` before it opts into ElevenLabs’ semantic turn model, which should help further but changes rehearsed pacing — listen to a whole check-in before demoing with it.

Tune the browser side in `BARGE_IN` in `src/barge-in.ts`. Raise `threshold` if the agent is still being cut off; lower it, or shorten `attackMs`, if interrupting the agent on purpose feels unresponsive. The thresholds are on the same RMS scale as the pre-call microphone check, where `0.015` means “some signal is present”.

There is no automatic fallback from a failed live session to simulation. Missing credentials, denied microphone permission, unavailable credits, and connection failures have explicit messages. Browser sessions end at five minutes. A lost browser heartbeat marks the intake incomplete after about 35 seconds; a server restart marks active sessions interrupted.

Once the server closes the questionnaire, the browser stops sending participant speech. Saying “thank you” over the agent’s closing line is a goodbye, not an answer; the server refuses it, correctly, and the browser no longer treats that refusal as a failure. It is not added to the transcript either — nothing may follow the last question. Anything a patient raises at that point belongs in a callback, which is what the nurse’s worklist is for.

Live ElevenLabs connection and English/Spanish audio generation have been verified with credentials. A full human microphone conversation, pronunciation, echo behavior, and interruption quality still need a manual rehearsal on your device. Contract, credential/credit-failure, microphone-denial, and deterministic intake paths are covered by automated tests. Once configured, rehearse both languages and listen to the final emergency message all the way through before presenting.

The first release runs on this laptop at localhost. A separate phone requires an HTTPS deployment; background incoming calls and phone transfers are not included. Ending or leaving a call releases the microphone and marks incomplete intake for review.

## Three roles, three surfaces

`/` is a role chooser for the demo; real deployments would route people by account.

| Route | Who | Sees |
| --- | --- | --- |
| `/nurse` | Care team | Worklist, live check-ins, briefing, live handoff. Behind the care-team password |
| `/provider` | Provider | Only cases a nurse escalated, with the reason and the briefing. Replies land in the nurse's audit trail. Behind the same password |
| `/c/<token>` | Patient | Their own check-in only. No password, no worklist |

**What the nurse action buttons actually do.** Acknowledge, Resolve and Escalate set the case
disposition and write an attributed audit entry. **Escalate** puts the case in the provider queue
with the nurse's reason; a provider reply is recorded against the patient and shows in the nurse's
audit trail, but it does not change the disposition — the nurse still decides. **Request callback**
records a task and places no telephone call, and says so in the audit. **Start live handoff** rings
every open care-team dashboard; there is no routing to a named person, so whoever accepts first
claims it.

Nothing in this app contacts anyone outside it. There is no paging, no SMS, no email.

## The service reaches out; the patient does not have to remember

A post-discharge check-in that waits to be opened selects against the people who need it
most. On day 3 after discharge, for any featured patient with no contact recorded, the server
creates a check-in invitation on its own — nobody has to start it. The nurse dashboard shows a
**Day 3 outreach** queue with each invitation's state and link.

**No delivery channel is configured.** SMS and email are not wired up, so the link is displayed
in the queue rather than sent. That is the only stubbed part: the scheduling, the invitation, the
scoped token, and the patient's page are all real. Say "the delivery channel is the next
integration", not "we text the patient".

The invitation link is `/c/<token>`, and it opens a **patient page, not the dashboard** — one
name, one conversation, no worklist, no other patients, no severity, no nurse controls, and no
password. The token is the only credential and it reaches nothing but that patient's own
check-in, through a separate `/api/outreach/:token/...` surface. Everything else, including the
whole nurse API, stays behind the care-team password.

The one thing a patient link does expose is `/assets/*`, the compiled client bundle, because the
patient's page has to load it. It contains no data; every API call still needs a credential.

## Adaptive follow-up, text chat, and the clinician briefing (Google Gemini)

These need a Google AI Studio key in `GEMINI_API_KEY`. Without one the scripted bilingual
intake works exactly as before, text chat is refused with a reason, and the briefing tab
explains what is missing. Nothing silently degrades.

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY`.
2. Restart the server. **Text chat** appears as a third conversation mode beside Simulation
   and In-app call.

**Model choice matters here, and the defaults were measured rather than assumed.**
A clarification happens inside a conversation turn bounded by the ElevenLabs 10-second tool
timeout, so `GEMINI_MODEL` defaults to `gemini-flash-lite-latest`, which returned in about
0.9 seconds in testing. The reasoning models are far slower for this task — `gemini-3.6-flash`
measured between 2.4 and over 8 seconds, which overran the budget and fell back to the scripted
question. The clinician briefing has no turn deadline and benefits from the stronger model, so
`GEMINI_BRIEFING_MODEL` defaults to `gemini-3.6-flash`. Override either in `.env`.

Two things worth knowing before a live demo:

- **`gemini-2.5-*` is refused for API keys issued since mid-2025**, with a 404 telling you to
  move to a newer model. If you see that error, set `GEMINI_MODEL` rather than assuming the key
  is bad. This is separate from the ElevenLabs agent's own internal model setting.
- **Free-tier quota is per model and is easy to exhaust while testing.** Quota exhaustion and
  temporary `503` overload both surface as an explicit audit note and the scripted question; the
  check-in continues either way. Transient overloads are retried once within the remaining time
  budget.

**What the model may do.** Exactly one thing: when the server's rules cannot read an answer,
the model rephrases *that same question* once. It runs after the rules have already committed
their decision, and it is structurally unable to advance the questionnaire, change urgency,
end the intake, or resolve a case. A clarification is refused and the scripted question is
asked instead if it is not a single question in the session language, or if it contains
reassurance, a diagnosis, treatment or medication advice, an emergency instruction, or a claim
that the case is handled. Every clarification, refusal, and outage is written to the audit
trail with the model name and latency.

**What it may never do.** Emergency and request-for-a-person routing run before the model is
consulted, so a 911 instruction never waits on inference. A failed, slow, blocked, or malformed
response leaves the scripted question in place; it can never mark an intake complete or erase a
concern. A result that arrives after the conversation has moved on is discarded by session
version. Simulation never contacts a provider at all.

**Clinician briefing.** The **Briefing** tab builds a draft summary of the latest check-in for
the nurse. Every sentence cites the transcript lines that support it, and a sentence citing a
line that does not exist is dropped rather than shown. The answered/unanswered question ledger,
the flagged quotation, and the urgency all come from the server, not the model. Spanish is kept
in the patient's own words with any English translation labelled as generated. The case-question
box answers only from the transcript and returns "Not established in this conversation." when
the transcript does not support an answer, including when the model claims otherwise.

The briefing is a draft for review. It is not a clinical assessment, and preparing one resolves
nothing.

## Live nurse handoff (LiveKit on Vultr)

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` to enable it. Without all three,
a patient asking for a person gets the existing callback promise and a callback task, and the
agent does not claim a transfer it cannot perform.

When it is configured, a patient asking for a person rings the care team, and the agent says a
nurse is being asked to join instead. A nurse sees a ringing banner and accepts or declines.
Acceptance atomically claims the request, so a second teammate clicking Accept gets a clear
refusal naming who took it. Join tokens are room-scoped, expire in ten minutes, and are issued
only after acceptance and only to the nurse who accepted. A handoff is reported as a live
conversation **only** once both people have actually joined; one participant shows as
Connecting. Decline, no answer within the ring window, and media failure each show the real
outcome and leave an urgent callback task open on the case.

Open a second browser at `http://127.0.0.1:4317/?nurse=Your%20Name` to act as a second nurse
and see the atomic claim. That query parameter is a demo convenience, not authentication.

**Joining audio.** Selecting **Join audio** takes a room-scoped token, connects to LiveKit, and
publishes the microphone. The server is told this side has joined only after the media session is
actually up, so a failed connection can never present as a completed transfer — it fails explicitly
and leaves the callback task open. The LiveKit SDK loads as a separate chunk, only when a nurse
joins, so it costs nothing on the normal dashboard.

**Not verified:** no audio has flowed between two people, because no LiveKit server exists yet.
The failure paths are tested; the working path is not. See `deploy/README.md` to stand one up.

## Care-team identity verification (GoDaddy ANS)

Set `ANS_API_KEY` and `ANS_CARE_TEAM_NAME` (an ANSName such as
`ans://v1.0.0.careteam.example.com`) to verify the nurse-coordination service before a handoff
carries any patient context. Set `CARE_TEAM_ENDPOINT` to the URL that would receive it.

The check resolves the name against the registry and refuses the handoff unless the returned
record carries the same ANSName, the same `agentHost`, an `ACTIVE` status, and an endpoint list
that actually contains the destination. A mismatched name, host, scheme, or endpoint is rejected,
no patient context is sent, the rejection is written to the audit trail with the identity and
timestamp, and an urgent callback task stays open.

When ANS is not configured the handoff still works and the banner reads *identity verification
unavailable*. It is never shown as verified.

**Scope, stated plainly:** this resolves and matches registry records. It does not perform X.509
identity-certificate chain validation, DANE/TLSA pinning, or SCITT transparency-log verification,
which need the private CA trust anchor and a DNSSEC-validating resolver. ANS identity proves
service and domain identity; it does not prove a person is a licensed nurse and does not
authorise access to a patient record. **The resolve path has not been confirmed against the live
registry** — set `ANS_RESOLVE_URL` from GoDaddy's own documentation once you have developer
access rather than trusting the built-in default.

## The escalation gate (Callsign, built in)

An escalation no longer goes straight from the nurse to the provider. **Callsign**, a
physician's-agent project merged into this codebase as a module, decides whether it may
reach the intended doctor. When a nurse escalates, Aftercare records the nurse note and
the attributed automated summary as before, then the gate signs the escalation as the
care-team service identity (`careteam.aftercare.work`) and verifies it as the provider's
agent (`lee.callsign-hcp.com`, Dr. Morgan Lee): ANS name resolution, certificate,
transparency-log receipt, signature and replay window, the provider's own policy, and a
content screen adapted to clinical escalations. Every check keeps its evidence.

- **Delivered**: the case appears on `/provider` with the verification evidence next to the
  nurse's note and the summary; the provider replies into the same thread as before.
- **Held**: the provider's policy said not now (the toggle on the provider page). The nurse
  sees the reason on the case and can retry delivery later. The case stays open.
- **Rejected**: an identity, signature, replay or content check stopped it. The nurse sees
  which one; the provider was never contacted. Three demo buttons on the nurse's case send an
  attacker's copy of the last escalation (spoofed sender, tampered message, replayed message)
  through the same gate.

The registry is this server's own ANS-shaped registry (a private CA, X.509 identity
certificates, a Merkle transparency log with signed checkpoints), served read-only at
`/ans/*` so a judge can inspect it; `GET /api/proof/<requestId>` returns any decision with
its evidence. No keys or network are needed. Nothing here changes urgency, disposition, or
emergency handling: rules still decide urgency and only a nurse closes a case. See
[docs/INTEGRATION-CALLSIGN.md](docs/INTEGRATION-CALLSIGN.md). The original Callsign project
is vendored unchanged at `callsign/` (`npm run agent` runs it standalone), and
[Codi's Cove](codis-cove/README.md), a separate side project from the same team, is linked
from the landing page (`npm run cove`).

## Deploying beyond this laptop

The server still binds to loopback and answers only for localhost by default. A deployment must
name its hosts explicitly in `TRUSTED_HOSTS` and set `HOST`; DNS alone changes nothing. A
configured host is accepted only over `https`, while localhost stays `http`. Cross-site requests
and non-JSON mutations are refused as before. The routes that spend provider quota are rate
limited per client.

**Letting another app call this API.** Browsers refuse cross-origin API calls unless the API
allows them, and this one allows none by default. A server-to-server caller is unaffected, because
it sends no `Origin`. If a partner app must call in from a browser, name its exact origin in
`ALLOWED_ORIGINS`; anything not named is still refused, and credentials are never shared across
origins, so a partner authenticates itself rather than riding the care-team session.

This is still not multi-user authentication. Teammate sign-in, scoped patient invitations, and a
protected nurse dashboard are required before exposing this to anyone outside the demo. The
`deploy/Caddyfile` carries a commented-out basic-auth block; turn it on before the app is reachable
publicly, or you are publishing a patient worklist and quota-spending endpoints to anyone with the
URL.

`deploy/` holds the Vultr deployment: a Dockerfile and Caddy-fronted compose file for the app
instance, a LiveKit + TURN config and compose file for the media instance, and a runbook with the
DNS layout, firewall ports, and a verification checklist. **None of it has been run against a real
Vultr instance**, so treat it as a starting point and budget time for the media path specifically.

## Data and behavior

- SQLite file: `data/aftercare.sqlite` by default. Override with `DATABASE_PATH`. Data and secrets are ignored by Git.
- Forty synthetic patients are generated per demo run, with three featured participants. Seed records are explicitly labeled; statistics include them.
- Sessions, original transcript turns, observations, and audit events persist. Reset appends a new run instead of deleting old data.
- Urgency and case disposition are separate. Green means no concern detected; it does **not** resolve the case.
- A new concern can reopen a resolved case. Later benign responses never downgrade an unresolved concern.
- Server rules route explicit emergency phrases, wound/medication concerns, practical barriers, and uncertainty. Negations and hypothetical examples are tested, but this limited rule-based classifier is **not clinically validated** and does not understand arbitrary speech reliably.
- Browser transcript callbacks submit original recognized text. Spanish is preserved without inventing English translations. Speech recognition may mishear; the UI shows the recognized transcript, not a claim of perfect transcription.
- Agent prompts prohibit diagnosis, treatment advice, medication changes, reassurance that symptoms are normal, and autonomous case resolution. Emergency handling happens after speech recognition and is not guaranteed clinical monitoring.
- Audio recording is disabled for the configured agent. Synthetic transcripts remain in the local database and may be retained by ElevenLabs according to the configured retention policy. This is not a production PHI system.
- The single local nurse identity is **Demo nurse**; `?nurse=<name>` renames the acting nurse for a two-browser handoff demo and is not authentication. The audit trail is append-only through the application, not a tamper-proof compliance system.
- Sessions carry a version. Any provider result that arrives after the conversation has moved on is discarded rather than applied.
- A language model can rephrase one unclear question. It cannot set urgency, advance the questionnaire, end an intake, or resolve a case; those remain server rules and clinician actions.
- A handoff is never reported as connected until both participants have joined. Declines, timeouts, and media failures preserve an urgent callback task and reopen a resolved case.

## Local API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/dashboard` | Current run, risk-sorted patients, active session, recent activity |
| `GET /api/patients/:id` | Patient, sessions, transcript, observations, audit |
| `GET /api/capabilities` | Voice configuration availability; never returns credentials |
| `POST /api/sessions` | Start simulation or an in-app call; only one active session |
| `GET /api/sessions/:id` | Current protocol state and next instruction |
| `POST /api/sessions/:id/voice-url` | Privacy-checked signed ElevenLabs connection URL |
| `POST /api/sessions/:id/events` | Deduplicated transcript event: `eventId`, `role`, `text` |
| `POST /api/sessions/:id/connected` | Attach provider conversation ID |
| `POST /api/sessions/:id/heartbeat` | Track browser connection |
| `POST /api/sessions/:id/end` | End the session; incomplete intake cannot become complete |
| `POST /api/patients/:id/actions` | Nurse action and optional/required note |
| `POST /api/demo/reset` | New demo run, retaining prior records |
| `GET /api/history?runId=...` | Demo runs and selected run’s audit history |
| `GET /api/events` | SSE change notifications; clients recover through fresh snapshots |
| `POST /api/sessions/:id/message` | Text-chat answer; returns the server-approved next question |
| `GET /api/outreach/:token` | Patient's own invitation, chart summary, and transcript. No worklist |
| `POST /api/outreach/:token/start` | Patient starts their own check-in from the invitation |
| `POST /api/outreach/:token/message` | Patient answer, scoped to that patient's active check-in |
| `POST /api/patients/:id/briefing` | Source-linked clinician briefing draft, cached per session version |
| `POST /api/patients/:id/briefing/ask` | Transcript-grounded answer to a nurse's case question |
| `POST /api/patients/:id/handoff` | Request a live nurse handoff; ANS-verified when configured |
| `POST /api/handoffs/:id/accept` | Atomically claim a ringing handoff |
| `POST /api/handoffs/:id/decline` | Decline and keep an urgent callback task |
| `POST /api/handoffs/:id/token` | Room-scoped, ten-minute LiveKit join token |
| `POST /api/handoffs/:id/joined` | Record a participant joining; both are required for a live call |
| `POST /api/handoffs/:id/end` | End or fail a handoff, with an honest outcome |

Requests that mutate data require JSON. Cross-origin requests and unexpected hosts are rejected. These controls suit a localhost demo; they are not multi-user authentication. Do not expose this server publicly.

## Verify

```sh
npm test
npm run build
npm run test:e2e
```

Unit/API tests cover English/Spanish routing, negation, ambiguity, consent, deduplication, persistence, stale/repeated starts, clinician-controlled resolution, server timeouts, missing credits, and recording protection. They also cover the adaptive clarification boundary (held questions, preserved flags, refused unsafe rephrasings, discarded stale results, emergencies that never wait on a model), briefing citation validation and the ungrounded-answer guarantee, handoff claim atomicity, token scope and signing, ring timeouts, ANS name parsing and destination rejection, deployment host/origin policy, and quota rate limits. Browser tests cover the real worklist, live simulation updates, refresh recovery, history, emergency interruption, denied microphones, keyboard access, and mobile layout. They also cover text-chat clarification, a chat emergency, the briefing's source links and preserved Spanish, the handoff claim and both-parties rule, and a declined handoff's callback task. They use a separate database at `data/e2e.sqlite` and port 4320, with a local stand-in for the Gemini endpoint at `tests/support/mock-gemini.mjs` so browser tests spend no quota and need no network.

Playwright uses installed Google Chrome (`channel: 'chrome'`). If Chrome is unavailable, install it or change the channel to an installed Playwright Chromium browser. Automated tests use dummy credentials and a mocked voice provider; they do not make paid voice calls. Local sound checks use a short tone and microphone meter without sending audio to ElevenLabs. The call SDK enables echo cancellation, noise suppression, and automatic gain control; headphones are recommended for rehearsal.

## Presentation boundaries

Use synthetic patients and consenting demo participants only. The day-3 script and 15-minute callback target are demonstration choices, not signed-off clinical protocols or staffed service promises. No EHR integration, user accounts, scheduling, retries, SMS, or telephone transfers are included.

Outreach documentation is **not TCM capture**. CMS requires interactive contact by clinical staff and additional services: [CMS TCM booklet](https://www.cms.gov/files/document/mln908628-transitional-care-management-services.pdf).

Phone calls were intentionally deferred: current [Twilio Voice trial restrictions](https://www.twilio.com/docs/usage/trials/try-out-voice) block streaming required by the original real-time phone design. This app does not purchase numbers, modify an existing number, or upgrade an account.
