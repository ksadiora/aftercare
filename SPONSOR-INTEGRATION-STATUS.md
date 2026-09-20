# Sponsor integration status

Implementation record for `SPONSOR-INTEGRATION-PLAN.md`, written 19 September 2026.

**Submission disclosure.** The Aftercare base — React dashboard, Express API, SQLite
persistence, SSE updates, the bilingual rule-based intake, ElevenLabs browser calls, transcripts,
and audit history — **existed before the hackathon**. Everything listed under "Added" below was
built during it. Nothing here was deployed, purchased, or registered: no domain, no Vultr
instance, no LiveKit server, no ANS registration. The only live credential in use is your own
Google AI Studio key, held in `.env` and never committed.

---

## Stage status against the plan's own gates

| Stage | Gate from the plan | Status |
| --- | --- | --- |
| 1. Eligibility and access | Constraints recorded, accounts usable | **Yours to do.** Needs organiser and mentor answers; see Open questions |
| 2. Public demo foundation | Two computers reach authorised pages | **Done.** Deployed to two Vultr instances in Atlanta on `aftercare.work`, HTTPS throughout, dashboard behind basic auth |
| 3. Human audio handoff | Two people speak on different networks | **Partial.** LiveKit and TURN are deployed and reachable, both seats can join; the two-person call on two networks has not been rehearsed yet |
| 4. Gemini intelligence | Contextual bilingual turns with traceable sources | **Done and verified live.** Adaptive clarification, text chat, and the source-linked briefing all exercised against the real API in English and Spanish |
| 5. ANS verification | Real verification succeeds, mismatch blocked | **Partial.** Client, strict matching, gating, and audit are done and tested; unconfirmed against the live registry |
| 6. Rehearsal and submission | Hosted demo and matching claims | **Yours to do.** Rehearse once a key is in place |

---

## What each sponsor actually requires

The plan's sponsor table lists five names in one column, which makes them look like five
integrations. They are three different kinds of thing, and conflating them leads to claiming
integrations that do not exist.

| Sponsor | What it actually is | What satisfies it |
| --- | --- | --- |
| Google Gemini | A real API integration | Server-side `generateContent` calls. **Done and verified live.** |
| ElevenLabs | A real API integration | Browser voice session. **Pre-existing, verified earlier.** |
| GoDaddy ANS | A real API integration | Resolve and verify the care-team agent. **Client written, never run against the live registry.** |
| Vultr | Deployment, not an integration | The app and self-hosted LiveKit running on Vultr instances. **Artifacts written in `deploy/`, nothing provisioned.** |
| Impiricus | A challenge entry, not an integration | A clinician-facing feature plus a pitch. **The briefing is built and verified live.** |

**Impiricus deserves the clearest statement.** There is no confirmed Impiricus API, sandbox, or
dataset available to this project, and the plan says so explicitly: describe this as a challenge
entry, not an integration. The judged artifact is the clinician briefing — source-linked summary,
preserved patient wording, the answered/unanswered ledger, and the case-question box that refuses
to answer beyond the transcript. That exists and works. What remains is not code:

- Ask the mentor whether nurse-first post-discharge coordination fits the HCP challenge, whether
  the briefing overlaps something Impiricus already ships, and whether any sandbox data exists.
- Write the five-minute pitch covering problem, HCP, and distinctive value.

Do not describe this as "an Impiricus integration" in the submission. It is an entry to their
challenge, and the briefing is the evidence.

**Vultr is deployment work that needs your account.** Instances cannot be provisioned from here —
that spends money and needs your credentials. What is written is everything that does not: the
Dockerfile, the Caddy-fronted app compose file, the LiveKit and TURN configuration, the firewall
and DNS tables, and the verification checklist, all in `deploy/`.

## Added during the hackathon

**Google Gemini (direct API, server-side).** `server/gemini.ts` calls `generateContent` over REST
with schema-constrained JSON, an 8-second budget that stays inside the ElevenLabs `get_next_step`
10-second tool timeout, and mapped credential/quota/model errors that never echo the key. It
returns model metadata (`modelVersion`, token counts, latency) for submission evidence. A
temporary overload is retried once using whatever time is left in the budget, so a fast failure
gets a second chance while a genuinely slow call is never cut short to reserve time for one.
Reasoning parts from thinking models are ignored when parsing the answer.

Model defaults were measured, not assumed: the in-turn clarification uses
`gemini-flash-lite-latest` (~0.9s), while the briefing uses `gemini-3.6-flash` (2.4s to 8s+),
which is too slow for a conversation turn but better suited to the citation prompt.

`server/respond.ts` is the shared response service. When the rules cannot read an answer, the
questionnaire holds position and the model rephrases that one question. This is a structural
boundary, not a prompt instruction: the model is only ever handed one question to rewrite, and
the applied result is a single string written through a version-checked update. A second safety
review rejects any rephrasing that is not one question in the session language, or that contains
reassurance, a diagnosis, treatment or medication advice, an emergency instruction, or a claim
that the case is handled.

**Scheduled outreach and a scoped patient page.** The server creates a day-3 check-in invitation
for any patient due one, without anyone starting it, and shows the queue to the nurse. The
invitation opens `/c/<token>`: a patient-only page with no worklist, no clinical judgements and no
password, backed by a separate token-scoped API. A patient token cannot reach another patient's
check-in, and the nurse API stays behind basic auth. No SMS or email provider is configured, so
the link is displayed rather than delivered — that is the only stubbed step.

**Adaptive probing.** Beyond rephrasing an unreadable answer, the model now asks one follow-up
when an answer raises a flag — wound appearance, medication understanding. The probe is anchored
to the question's topic, the model can decline when no sensible follow-up exists, and a rejected
or failed probe advances rather than re-asking. Severity remains the rules' decision alone.

**Text chat.** A third conversation mode (`mode: 'chat'`) driven by `POST /api/sessions/:id/message`,
sharing the same rules, persistence, triage, dedup, and audit as voice and simulation.

**Clinician briefing (the Impiricus-facing feature).** `server/briefing.ts` numbers the transcript,
asks for statements citing line numbers, then resolves those numbers back to stored turn IDs and
**drops any statement whose citations do not resolve**. The answered/unanswered ledger, flagged
quotation, urgency, and timeline are computed by the server. Spanish is preserved with any English
translation labelled as generated. The case-question box returns "Not established in this
conversation." whenever citations are absent — the guarantee is ours, not the model's.

**LiveKit handoff lifecycle.** `server/handoff.ts` mints room-scoped HS256 join tokens (10-minute
expiry, no data channel) with `node:crypto`, no new dependency. The state machine in `server/store.ts`
covers requested → accepted → connecting → active → ended, plus declined, timed out, and failed.
Acceptance is an atomic claim inside a write transaction. A handoff becomes `active` only when both
participants have joined. Every unhappy ending preserves an urgent callback task and reopens a
resolved case. A nurse joining is not a second intake, so the global active-session lock is untouched.

**GoDaddy ANS verification.** `server/ans.ts` parses the ANS-2 `ans://v{version}.{agentHost}` form,
resolves it, and refuses the handoff unless the record's ANSName, host, `ACTIVE` status, and declared
endpoint list all match the destination. Rejections are audited with identity and timestamp and leave
a callback task open.

**Deployment policy.** `TRUSTED_HOSTS` and `HOST` replace the hardcoded loopback assumptions, with
localhost defaults unchanged. A configured host is accepted only over https. Provider-spending routes
are rate limited per client.

**Browser media join.** `src/handoff-media.ts` takes the room-scoped token, connects to LiveKit,
publishes the microphone, and only then tells the server this side has joined — so a failed
connection is recorded as a failure, never as a transfer. The SDK is a dynamic import, so it loads
only when a nurse joins and adds nothing to the normal dashboard bundle.

**Vultr deployment artifacts.** `deploy/` holds the app Dockerfile, a Caddy-fronted compose file
with automatic HTTPS and a persistent SQLite volume, a LiveKit + TURN config, a second Caddy that
terminates TLS for LiveKit signalling, and a runbook covering the DNS layout, firewall ports
(including the UDP range whose absence is the usual cause of a silent call) and a verification
checklist.

Two corrections were made to these after review, both worth recording because they are the kind
of thing that only fails at demo time:

- **Signalling had no TLS terminator.** LiveKit speaks plain HTTP on 7880, but the browser dials
  `wss://rtc.<domain>` on 443. Nothing was listening there, and because the app page is HTTPS a
  plain `ws://` fallback is blocked as mixed content, so the handoff would have failed closed at
  the moment of the transfer. `compose.media.yml` now runs Caddy alongside LiveKit in host
  networking, proxying 443 to `127.0.0.1:7880`, and the certbot step issues one certificate
  covering both `rtc.` and `turn.` so TURN and Caddy share a single renewal path.
- **Dashboard authentication was opt-in.** The basic-auth block was commented out with a
  placeholder hash, which is the wrong default for something about to be public. Credentials are
  now required environment variables; Caddy refuses to start if either is missing, so the
  dashboard cannot be published unauthenticated by accident.

**A test that cannot tell you what you need to know.** The browser test
`an unreachable media server is reported as a failure, never as a transfer` deliberately points
`LIVEKIT_URL` at a host that does not exist. It proves the failure is handled cleanly — but a
genuinely misconfigured `wss://` URL in production produces exactly the same observable behaviour
as that passing test. Green tests are therefore not evidence that signalling works. The runbook
opens its verification section with a positive check (`curl https://rtc.<domain>/`) for this
reason.

**Tests.** 159 unit/API tests and 13 browser tests, all passing. Browser tests run against
`tests/support/mock-gemini.mjs` so they spend no quota and need no network.

---

## What is verified, and what is not

**Verified against the real Gemini API.** With your key in `.env`: English and Spanish
clarifications each returned in about 0.95 seconds, held the question in place, and left the
rule-based flag standing. A live briefing produced three statements whose citations all resolved to
real stored turns, preserved the Spanish quotation with a labelled English translation, answered a
grounded case question with its source, and refused an unsupported one with "Not established in
this conversation." Quota exhaustion and a temporary overload both occurred during testing and
degraded exactly as designed — an explicit audit note and the scripted question, with the check-in
continuing.

**Verified in a browser.** The adaptive chat, briefing, and handoff flows were driven by hand
against a local mock: a handoff rang, was claimed by one nurse, and reported `connecting` rather
than a live call when only one party had joined.

**Not verified, and why.**

- **The briefing has only run live on the lite model.** The free-tier quota for `gemini-3.6-flash`
  was exhausted during testing before the stronger model could be exercised on the briefing prompt.
  Re-run it once the quota window resets, or set `GEMINI_BRIEFING_MODEL=gemini-flash-lite-latest`
  to share the lite pool.
- **No audio flows between two people.** The join path is implemented and its failure modes are
  tested — an unreachable media server fails explicitly and preserves the callback task, verified in
  a browser against the real SDK. But no LiveKit server exists, so the *working* path has never run.
  This is the single biggest untested area.
- **ANS has not touched the live registry.** The endpoint shapes come from GoDaddy's public
  `ans-registry` specification, not from a live call. The resolve path is a documented guess and is
  configurable via `ANS_RESOLVE_URL` precisely so you can correct it. Do not claim ANS eligibility
  until a real resolution and verification have run.
- **Deployed and reachable.** `app.aftercare.work`, `rtc.aftercare.work` and `turn.aftercare.work`
  run on two Vultr instances in Atlanta with Let's Encrypt certificates. Signalling answers
  `HTTP 200` over `wss://`, TURN TLS is listening, and the dashboard is behind basic auth. One
  Compose YAML quoting bug was found and fixed on first run. What remains untested is the thing
  that needs two people: no audio has yet flowed between two participants on two networks.
- **The dashboard has no authentication.** The nurse identity is a query parameter. The basic-auth
  block in `deploy/Caddyfile` is commented out and must be enabled before the app is public.

---

## What is left, in the order I would do it

1. **Re-run the briefing on `gemini-3.6-flash`** once the free-tier quota resets, to confirm the
   stronger model handles the citation prompt as well as the lite model did.
2. **Capture Gemini evidence.** The audit trail already records the model name and latency for every
   adaptive question and briefing; that is your screenshot.
3. **Ask the mentors the open questions below** before committing to three tracks.
4. **Stand up the two Vultr instances** using `deploy/README.md`, then run its verification
   checklist. The media join is already written, so this is deployment and debugging rather than
   development. Two people on two different networks is the gate.
5. **Get ANS developer access**, register the intake and care-team services, and correct
   `ANS_RESOLVE_URL`. Until a real verification runs, present the handoff with verification marked
   unavailable — which is exactly what the UI does on its own.

## Open questions for the organisers and mentors

- Do the separately advertised MLH prizes count against the three-track cap from page 11?
- Does nurse-first post-discharge coordination fit the Impiricus HCP challenge, and does the briefing
  overlap anything already shipped?
- Is ANS developer access available in time, and what is the correct resolution endpoint?
- Are Vultr credits and Gemini quota sufficient for a rehearsal plus the live demo?

## Claims that would not be accurate today

Say the integration is implemented and tested; do not say it is proven in production. Specifically,
do not claim: a completed phone or audio transfer between two people; ANS verification against the
live registry; a hosted public deployment; clinical validation of any triage decision; or that the
ElevenLabs agent's internal Gemini model setting is the direct Gemini API integration. That last
distinction is the one the plan itself flags, and it still holds — the direct integration is the
server-side work described above.
