# Aftercare sponsor integration plan

Planning only - September 19, 2026. No infrastructure has been purchased or deployed by this plan.

**Product direction**

Aftercare gives a synthetic post-discharge patient an English/Spanish AI check-in, then helps a teammate acting as the nurse take over an internet call with the relevant context already visible. The patient speaks through their own microphone; only the AI follow-up agent has a generated voice. The handoff connects two real people on two computers without Twilio or a telephone number.

| Sponsor | Concrete role | Evidence for the demo |
| --- | --- | --- |
| GoDaddy | Public domain, DNS, and Agent Name Service (ANS) discovery and verification of the nurse-coordination service | Branded HTTPS URL; actual ANS registration, resolution, and verification before handoff |
| Google Gemini API | Direct server-side conversational intelligence for text chat and voice instructions; source-grounded clinician briefing | Real Gemini API requests and model metadata; contextual follow-up; brief with transcript references |
| ElevenLabs | Existing bilingual speech recognition, agent speech, and live browser voice session | Patient speaks English/Spanish and hears the agent respond in the selected language |
| Vultr | Hosts the app, persistent database, and self-hosted LiveKit media/TURN infrastructure | Two computers exchange live audio through the Vultr deployment |
| Impiricus | Shapes the clinician-facing feature: an interactive, source-grounded handoff briefing that reduces the information a clinician must reconstruct | Nurse reviews what happened, asks questions about the case, then accepts a live patient handoff |

**Prize requirements that change the approach**

The opening slides say teams can enter up to three sponsorship tracks (page 11). Confirm whether the separately advertised MLH prizes count toward that same cap before selecting submissions. Using five services does not establish eligibility for five prize entries.

GoDaddy's on-site challenge is **Best use of ANS**, involving agents that discover, verify, and communicate with other agents/services using domain-anchored identity (pages 37-40). A domain alone is insufficient for that challenge. The MLH email separately advertises **Best Domain Name from GoDaddy Registry** and the event offer. Follow its eligible registrar/TLD/redemption terms; do not assume any GoDaddy purchase qualifies. Check availability and renewal terms before registering a domain.

Impiricus's **Build the next HCP engagement tool** challenge permits a new engagement channel or new value built on its platform/data. SMS and products it already offers are off limits (pages 72-77). The first prize is $3,000, with $2,000 second and $1,000 third. Deliverables are a working demo and a five-minute pitch addressing the problem, HCP, and distinctive value. Judging covers HCP impact, originality, technical execution, and commercial fit.

Impiricus already describes physician-to-representative connections, clinical insights, and direct phone-transfer functionality. A basic transfer or generic chatbot is therefore a weak novelty claim. Our proposed entry is the clinician briefing and context-preserving handoff experience. Ask its mentor whether nurse-first post-discharge coordination fits the HCP challenge, whether this feature overlaps with something already shipped, and whether it offers usable sandbox APIs/data. The slides do not establish an API requirement or promise API access. Until confirmed, describe this as an Impiricus challenge entry, not an integration with an Impiricus API.

Conditional entry recommendation: Impiricus, GoDaddy ANS, and Vultr if all prizes share the three-track cap and the mentors confirm fit/access. Gemini or ElevenLabs is a sensible replacement if ANS access or Impiricus fit cannot be established. If MLH entries are outside the cap, enter the additional eligible categories after organizer confirmation.

**Architecture and what we preserve**

The current implementation already has React, Express, SQLite, SSE dashboard updates, bilingual ElevenLabs browser calls, deterministic routing, transcripts, and audit history. It has no Supabase dependency. Keep those working components.

The ElevenLabs setup currently selects Gemini 2.5 Flash inside its agent configuration. That is different from implementing the direct Gemini API integration proposed here; do not rely on that setting alone as evidence for the Gemini API prize.

```text
Patient browser: text chat or microphone
    |
    +-- text --> Aftercare API on Vultr --> Google Gemini API
    |
    +-- voice <--> ElevenLabs
                     |
                     +-- existing client tool --> Aftercare API --> Gemini
                                                    |
                                               routing rules
                                               SQLite + audit
                                                    |
                                              nurse dashboard
                                                    |
Handoff request --> ANS resolves/verifies approved nurse service
                  --> nurse accepts --> room-scoped join tokens
                                                    |
Patient browser <--> LiveKit + TURN on Vultr <--> Nurse browser
```

Use two small Vultr VMs initially: one for the app and its persistent SQLite volume, one for LiveKit and TURN. This avoids unnecessary Kubernetes, GPU instances, and competing TLS services during the hackathon. Review the actual sizes, available event credits, and billing before provisioning. A single app process is sufficient; keep PostgreSQL/multiple app replicas outside this build.

Use one chosen domain with the following proposed DNS layout. These are roles, not claims of domain availability:

| Host | Destination |
| --- | --- |
| `app.<domain>` | App VM: patient page, nurse dashboard, API |
| `intake.<domain>` | App VM: intake agent identity/API |
| `careteam.<domain>` | App VM: nurse-coordinator agent identity/API |
| `rtc.<domain>` | Media VM: LiveKit |
| `turn.<domain>` | Media VM: TURN |

Deploy trusted HTTPS certificates and the documented LiveKit firewall/TURN configuration. Test on separate networks; a successful same-laptop call does not prove the remote-media path works.

The server currently binds to localhost and rejects external hosts and HTTPS origins. Deployment requires explicit trusted host/origin configuration, proxy handling, and access controls, not just DNS changes. Keep the existing local defaults. Separate a scoped patient invitation page from the protected nurse dashboard; add teammate sign-in, short-lived join credentials, rate limits, and call/credit limits before exposing the app. Do not publish an unrestricted worklist or expensive API endpoints.

**Gemini and ElevenLabs conversation flow**

1. Add a server-side Gemini client with `GEMINI_API_KEY` and configurable `GEMINI_MODEL`. Choose an available Flash model when implementing; keep credentials out of browser bundles.
2. Add a patient text-chat mode alongside simulation and in-app voice. Chat is genuinely conversational: it asks one relevant question at a time, clarifies uncertain answers, and answers only from the approved synthetic discharge instructions.
3. Use one shared response service for chat and live voice. Preserve the current ElevenLabs `get_next_step` client tool; it obtains the backend-approved response after the latest patient transcript has been processed. ElevenLabs retains the voice interaction and reads the returned response in the selected language.
4. Return schema-validated fields such as response text, supported observations with source-turn IDs, unanswered topics, and suggested next question. Validate meaning and references as well as JSON shape. Persist original transcript text and separately labeled translations.
5. Run existing emergency/human-request routing before waiting for Gemini. Server rules retain control over emergency instructions, urgent flags, callback tasks, and allowed state changes. Gemini cannot downgrade an unresolved concern, diagnose, change medications, say symptoms are normal, or close a case. Its assessment is not clinically validated.
6. Serialize and deduplicate events per session. Do not hold a database transaction open while awaiting an external model. Use session versions to reject stale results and preserve nurse decisions. Align model timeout with the voice tool timeout; failed inference must not mark intake complete or erase concerns.
7. Keep simulation free of provider calls. Missing quota or provider failure produces a clear message; never silently switch a live conversation to a scripted one or a different speech engine.

The model gains conversational flexibility inside the existing intake boundaries. Questions such as an ambiguous wound description can receive a clarification instead of a rigid next question. Fixed emergency instructions still interrupt routine questioning after recognition, and only a clinician resolves the case.

**Actual nurse handoff on Vultr**

Vultr supplies compute and networking; LiveKit supplies the WebRTC room and media handling. Self-host LiveKit on Vultr rather than substituting LiveKit Cloud if the intended sponsor evidence is the media infrastructure running on Vultr. Existing ElevenLabs WebSocket sessions cannot simply be reassigned to the nurse's browser.

Proposed sequence:

1. Patient requests a person or the demo's escalation rule requests review. Create an auditable handoff request and notify available nurses through the app.
2. Resolve and verify the approved care-team service through ANS. Verify the expected domain/identity and capabilities; a registry search result alone is not sufficient proof.
3. The nurse sees a ringing request and a short briefing. Acceptance atomically claims the request so two teammates cannot take the same call.
4. Backend issues short-lived, room-scoped tokens to this patient and the accepting nurse. Both clients prepare their media connections.
5. The agent explains the transition. After its final announcement, stop AI audio capture/playback before enabling the patient's human-call microphone. Keep the call screen open while changing the underlying connection. Show connecting until both participants are actually ready.
6. Patient and nurse speak live. Only their real microphones are used. Record handoff state/timestamps and nurse notes; leave human-call recording and transcription off for this build.
7. On decline, timeout, or media failure, show the actual outcome and preserve an urgent callback task. Never display a successful transfer without a connected nurse. Emergency instructions must not wait for nurse acceptance.

Persist states such as `AI_ACTIVE`, `HANDOFF_REQUESTED`, `NURSE_ACCEPTED`, `CONNECTING`, `HUMAN_ACTIVE`, and `ENDED`, with explicit declined, timed-out, and failed outcomes. Track nurse presence with a heartbeat. Make acceptance, token creation, reconnect, and end actions idempotent. Keep the one-patient-call demo limit while allowing a nurse to join that same call; the existing global active-intake lock must not reject the nurse as a second intake.

No telephone numbers or Twilio are involved. A teammate opens the protected nurse page and accepts the call on another computer. Incoming-call notifications are in the open web app; background mobile ringing is outside this scope.

**Meaningful GoDaddy ANS use**

Register two real HTTP-API agents/services: the intake service and nurse-coordination service. Follow GoDaddy's current enrollment, domain-control, certificate, and endpoint requirements. Discover the approved coordination service and verify its identity before sending a handoff request containing patient context.

Show a verified-service indicator only after successful verification, with an audit entry containing the identity, result, and timestamp. Demonstrate that a mismatched or unverified destination is rejected. ANS identity proves service/domain identity; it does not prove a person is a licensed nurse or authorize patient access. Keep teammate permissions and scoped patient access separate.

If registration is delayed, continue the ordinary authenticated two-computer demo with verification marked unavailable. Do not show fabricated ANS success or claim ANS eligibility for a domain-only implementation.

**Impiricus-facing feature: Clinician Briefing**

Before accepting the handoff, the nurse gets:

- Reason for review, discharge context, and the patient's stated request.
- Exact relevant patient quotation, with Spanish preserved and English translation explicitly labeled.
- Answered and unanswered intake questions, uncertainty, and an event timeline.
- Links from each generated statement to the transcript turns supporting it.
- An interactive case-question field: for example, “What did the patient actually say about the incision?” or “What remains unanswered?”
- Clear draft status and clinician controls to acknowledge, add a note, accept a call, escalate, or resolve.

Gemini should respond “not established in this conversation” when the source does not contain an answer. Use only the synthetic chart, transcript, and approved demo instructions. Do not add unsupported treatment recommendations or promotional content to force sponsor alignment.

Proposed pitch: “The clinician receives the patient's words, the unresolved questions, and a trusted route into a live conversation before accepting the interruption.” Measure briefing usability during rehearsal: time to find the reason for escalation and whether the nurse can identify unanswered questions. Report observed demo results, not invented clinical outcomes or proven workload savings.

**Build order and acceptance gates**

| Stage | Work | Done when |
| --- | --- | --- |
| 1. Eligibility and access | Confirm three-track rule, HCP fit, ANS access, domain-offer terms, Gemini quota, Vultr credits | Constraints are recorded and required accounts are usable |
| 2. Public demo foundation | Domain, Vultr app deployment, HTTPS, persistent volume, teammate access and patient invitations | Two computers can reach their authorized pages; unrelated users cannot access a case |
| 3. Human audio handoff | Self-host LiveKit/TURN, nurse availability, request/accept, tokens, audio transition | Patient and teammate speak on different networks; timeout and failure produce honest UI |
| 4. Gemini intelligence | Direct API, text chat, shared voice response service, clinician briefing | Contextual English/Spanish turns work with traceable source facts; existing emergency routing remains intact |
| 5. ANS verification | Register services, resolve, verify, gate handoff destination | Real identity verification succeeds; mismatched destination is blocked |
| 6. Rehearsal and submission | Polish briefing, run failure checks, record evidence, prepare pitches | Working hosted demo, public submission materials, and sponsor-specific claims match implemented behavior |

For four teammates: one can own infrastructure/media, one Gemini/protocol, one patient/nurse UI and briefing, and one ANS plus submission evidence. Coordinate the session/handoff API contract first. This is a proposed team split, not delegation performed by this plan.

**Verification and demo**

Test bilingual clarification, quoted source accuracy, incomplete answers, negation, fixed emergency response and termination, requests for a person, credit exhaustion, microphone denial, duplicate transcript deliveries, repeated acceptance clicks, nurse disconnects, app restart, invalid/expired join tokens, unauthorized case access, failed ANS verification, and forced TURN relay. Verify the AI microphone stops during the human call and that only a person can resolve a case. Inspect logs and the built client for accidental secret exposure.

Main demonstration: a teammate plays Miguel and describes a wound concern in Spanish; the agent asks a relevant follow-up; the nurse dashboard flags the concern and preserves the quotation; the clinician briefing shows source-backed context; ANS verifies the care-team service; a second teammate accepts on another computer; the two humans talk; the nurse documents the outcome. Show a separate short emergency scenario so the pitch does not imply waiting for a handoff is appropriate during an emergency.

Capture evidence: public branded URL and DNS, Gemini request/model metadata without secrets, ElevenLabs voice interaction, Vultr app/media deployment and a real media connection, ANS registration/verification, and the clinician-facing workflow. General Devpost guidance calls for a four-minute presentation; Impiricus slides request five minutes, so prepare both cuts and confirm the judging arrangement. The opening deck and event page give an 8 AM Sunday, September 20 submission deadline.

Existing work must be disclosed in the submission as required by the event rules; clearly identify the sponsor integrations added during the hackathon. Keep simulation available for presentation continuity, but label it and never present it as proof of a live provider integration.

**Inputs needed when implementation is authorized**

Selected domain and event-offer redemption; GoDaddy/ANS developer access and domain-control access; a Google project/API key with usable Gemini quota; Vultr account/project with credits and permission to create the chosen instances; existing ElevenLabs credentials/allowance; a second computer, teammate, and headset. Store credentials privately in server configuration. Use synthetic data only. This plan includes no production clinical deployment, EHR integration, SMS, or paid telephone setup.

**Sources checked**

- Local `VTHacks 14 Opening Ceremony.pdf`: page 11 (track limit/deadline), pages 37-40 (GoDaddy ANS), pages 72-77 (Impiricus).
- Local `Gmail - Everything you'll need to know from MLH at VTHacks 14 💻.pdf`: pages 1-2 (Gemini/ElevenLabs), page 4 (Vultr), page 5 (domain offer).
- [VTHacks 14 submission rules and prizes](https://vthacks-14.devpost.com/).
- [GoDaddy ANS developers](https://www.godaddy.com/ans/developers) and [registration reference](https://developer.godaddy.com/en/docs/references/rest/ans/registration).
- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).
- [LiveKit VM deployment](https://docs.livekit.io/transport/self-hosting/vm/) and [self-hosting requirements](https://docs.livekit.io/transport/self-hosting/deployment/).
- [Vultr Node.js container deployment](https://docs.vultr.com/how-to-containerize-node-js-web-applications).
- [Impiricus existing solutions](https://www.impiricus.com/our-solutions/).

Current-code references: `scripts/setup-voice.ts`, `src/voice.ts`, `server/app.ts`, `server/index.ts`, and `README.md`. Sponsor interpretation and architecture recommendations above are planning judgments; eligibility and awards are not guaranteed.
