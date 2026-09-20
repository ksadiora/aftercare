# Handoff

Written 19 September 2026, end of the build session. For whoever picks this up next —
another Claude session, a teammate, or you in six hours. Read this before changing anything.

Related docs: `README.md` (how the app behaves), `deploy/README.md` (infrastructure),
`SPONSOR-INTEGRATION-STATUS.md` (what was built during the hackathon, for the submission),
**`HANDOFF-INTEGRATION.md` (the Callsign escalation gate merged on branch `integrate-callsign`:
every file changed, how to run and deploy it, what was and was not tested).**

---

## It is live

| | |
| --- | --- |
| Nurse | `https://<domain>/nurse?nurse=Rivera` |
| Provider | `https://<domain>/provider?name=Dr%20Okafor` |
| Role chooser | `https://<domain>/` |
| Patient picker | `https://<domain>/patient` (staff-only) |
| Patient check-in | `https://<domain>/c/<token>` (no password) |

Nurse, provider, chooser and picker are behind HTTP basic auth: user `careteam`, password
known to Karan only — the bcrypt hash is in the deploy command below and the plaintext was
never shared with Claude.

**Patient links change on every demo reset.** Get current ones from the nurse dashboard's
"Day 3 outreach" card, or the patient picker.

## Infrastructure

Two Vultr instances in Atlanta, Ubuntu 24.04, Docker + Compose, `ufw` on both: an **app**
host (this server, Caddy for automatic HTTPS and basic auth, SQLite on a named volume) and a
**media** host (LiveKit + TURN behind Caddy for signalling TLS). DNS at Porkbun.

**The IPs, the SSH key name, the domain and the dashboard password hash are in
`PRODUCTION.local.md`, which is gitignored.** They are deliberately not in a tracked file —
this repository is going to GitHub. If you do not have that file, ask Karan.

Redeploying, with those values filled in from that file:

```sh
rsync -az --exclude node_modules --exclude dist --exclude data --exclude .git \
  --exclude test-results --exclude playwright-report --exclude '*.pdf' \
  --exclude 'deploy/certs' --exclude 'deploy/livekit.rendered.yaml' \
  -e "ssh -i $HOME/.ssh/<key>" ./ root@<app-ip>:/opt/aftercare/

ssh -i ~/.ssh/<key> root@<app-ip> 'cd /opt/aftercare && \
  APP_DOMAIN=<domain> DASHBOARD_USER=<user> \
  DASHBOARD_PASSWORD_HASH='"'"'<hash>'"'"' \
  docker compose -f deploy/compose.app.yml up -d --build'
```

The hash must be single-quoted or the shell eats the `$` sequences. Every `docker compose`
subcommand needs those three variables, **including `stop`** — Compose interpolates the whole
file whatever you asked it to do, and under `set -e` the failure is silent. Compose refuses to
start without the credentials, which is deliberate: it cannot publish the dashboard
unauthenticated by accident. **Always `npm test && npm run build` before deploying.**

The media instance rarely needs redeploying; see `deploy/README.md` if it does.

## Verified, and not

**Confirmed by a human, on real hardware:** patient voice check-in with a real microphone,
adaptive probing (procedure-aware), nurse→patient agent call ringing the patient's device,
nurse↔patient two-way audio in both directions, the patient picker, role switching.

**Verified by Claude against the live server, not by a human:** the clinician briefing and its
citation validation, escalation into the provider queue and the reply returning to the nurse's
audit trail, the outreach scheduler, ANS rejection paths, deployment host/origin policy.

**Not verified by anyone:**

- **Emergency detection.** It has now failed two live tests and been fixed twice: "No. I'm
  dying. Call 911." scored as no symptom reported, and "my head hurts a lot and im very
  dizzy. im in so much pain" carried straight on to the next question because `worst
  headache` was the only headache the rules knew. Both are covered by the table in
  `tests/unit/triage.test.ts`. This is the highest-stakes behaviour in the product, the one
  that has broken most often, and the table is where a new phrasing goes. Test it first.
- **The barge-in gate, on a real microphone.** Its thresholds are reasoned, not measured on
  this hardware in this room. Knock the table mid-question: the agent should carry on. Then
  talk over it: it should stop within about a fifth of a second. If it still gets cut off,
  raise `threshold` in `src/barge-in.ts`; if interrupting feels unresponsive, lower it.
- **The agent-side turn settings**, which need `npm run voice:setup -- --update` run against
  the live agent — the code change alone does not touch it.
- The ringtone, on real speakers.
- Anything on the venue network. Conference wifi blocks UDP; TURN exists for that, untried.
- ANS against the live GoDaddy registry — the client is written but has never resolved a real
  name. Do not claim ANS eligibility.

## Things that cost hours to find

Each of these is now fixed and tested. They are recorded because the reasoning is not obvious
from the diff.

- **livekit-client does not play remote audio.** Its `Room` handler on `TrackSubscribed` only
  attaches playback-status listeners and re-emits; the application must call `track.attach()`.
  Symptom was a call that connected, published both tracks, passed ICE, and was silent.
- **`gemini-2.5-*` is refused for API keys issued since mid-2025** with a 404 that reads like a
  model-name error. Defaults are now `gemini-flash-lite-latest` for in-turn clarifications
  (~0.9s measured) and `gemini-3.6-flash` for the briefing. The thinking models measured 2.4s
  to over 8s, which overran the budget the ElevenLabs tool timeout allows.
- **A `:` inside a `${VAR:?message}` default breaks Compose YAML.** Every such message is quoted.
- **The patient page only polled if a call already existed**, so a call rung while they sat
  there could never be discovered. It always polls now.
- **`response.json()` on a non-JSON body** surfaced "Unexpected end of JSON input" whenever Caddy
  returned 502 during a redeploy. `src/api.ts` now reads text first and maps statuses to plain
  sentences; polls fail quietly.
- **An edit that printed no confirmation did not get written.** A python edit helper built the
  new string and never called `write_text`; the browser test caught it. Every edit helper now
  asserts the write took effect.
- **Any small noise stopped the agent mid-question.** ElevenLabs decides interruptions from the
  audio we send it, so nothing in the agent config filters a wordless transient — a chair
  creak, a phone set down. The browser now holds the microphone closed while the agent speaks
  and opens it only for sustained speech (`src/barge-in.ts`); the agent config adds an
  ignore list of non-lexical fillers for what still gets through. Note the SDK's own meter
  reports zero while muted, which is exactly when the gate needs a reading, so the gate runs
  on its own `getUserMedia` stream — the one the permission prompt already opened, previously
  thrown away. Tune `BARGE_IN` in `src/barge-in.ts`; `npm run voice:setup -- --update` pushes
  the agent-side settings to the existing agent without creating a second one.
- **A "thank you" at the end showed "Intake recording failed".** The last question closes the
  questionnaire; a participant speaking over the agent's closing line was posted as an answer,
  the server refused it (correctly — nothing may follow the last question), and the browser
  turned that refusal into a red alert and a `stop('failed')` that cut the closing instruction
  short. On the emergency path that instruction is "hang up and call 911", so this was not
  only cosmetic. The browser now stops sending participant speech as soon as the server
  reports the questionnaire closed, and treats a 409 from `/events` as "already over" rather
  than "broken". `src/api.ts` throws `ApiError` with the status so that distinction exists.

- **The Gemini key is on the free tier, and the briefing is what runs out.** A 429 comes back
  as "Gemini quota is exhausted"; the body from Google names the model and the limit. Measured
  19 September: `gemini-3.6-flash` refused repeated briefing requests while
  `gemini-flash-lite-latest` served them. Set `GEMINI_BRIEFING_MODEL=gemini-flash-lite-latest`
  if the briefing fails on the day, or enable billing on the key. Briefings are cached per
  `sessionId:version`, so preparing each featured patient's briefing once before a demo makes
  it instant and spends nothing during the pitch — "Ask about this case" is not cached and
  spends a request per question.
- **`npm run test:e2e` serves `dist`, not your source.** `npm start` runs with
  `NODE_ENV=production`, so a front-end change you have not built is invisible to the browser
  tests and they fail against the old bundle. Run `npm run build` first, always.

- **"worst headache" was the only headache the rules knew.** A patient in trouble uses their
  own words. `server/triage.ts` now groups the emergency phrasings by symptom — cardiac,
  breathing, headache, stroke, bleeding, collapse — each with its own enumerated denials,
  because a general "a negative word appeared" rule would swallow "cannot breathe" and
  "can't move my arm", which are themselves negations. Dizziness and severe pain are red,
  not emergency: the knee that hurts after a knee replacement is why pain stops short.
  `tests/unit/triage.test.ts` has a two-sided table — must-fire and must-not-fire — and both
  halves matter, since an emergency on every ache makes the triage worthless.
- **A provider's reply was invisible to the nurse, and one-way besides.** It was in the audit
  trail all along, three clicks from where they work, so a reply could sit unread while the
  case waited on it — and the nurse had no way to answer. It is now a thread either side adds
  to (`store.caseThread`), assembled from the audit trail rather than stored beside it, so a
  case cannot hold a discussion the record does not show. It sits above the tabs on the
  patient, on every tab, and the worklist chips any case in `dashboard().awaitingNurse`.
  The generated summary deliberately stays outside the thread: it is context, not something
  a person said.
- **`.follow-up-cell` is hidden below a breakpoint.** A marker put there vanished at 1180px,
  which is an ordinary laptop. Anything that must always be visible on a worklist row belongs
  in `.patient-identity`.
- **A written check-in is read aloud.** `src/speech.ts` speaks the agent's side only, using
  browser voices, so it costs nothing and needs no credentials. Someone who chose to type has
  not chosen to read in silence. Off by a toggle on both the nurse studio and the patient page.

## Design boundaries — do not casually change these

The project's value is that it degrades honestly. These are load-bearing:

- **Rules decide urgency, never the model.** Gemini may rephrase or ask one follow-up on the
  same topic. It cannot advance the questionnaire, change severity, end an intake, or resolve a
  case. Enforced structurally, not by prompt, plus a content guard that rejects reassurance,
  diagnosis, treatment advice, emergency instructions and closure claims.
- **Emergency routing runs before the model is consulted.** A 911 instruction never waits on
  inference.
- **Severity is monotonic.** A later benign answer cannot walk back a flag.
- **A handoff is only "active" when both parties have joined.** Never announce a transfer that
  has not happened.
- **Every unhappy ending preserves an urgent callback task** and reopens a resolved case.
- **A provider note does not change disposition.** Only a nurse closes a case.
- **A generated summary is never presented as the nurse's words.** An escalation carries
  both; they are separate audit entries with separate actors, and the provider page shows
  them in separate blocks. A rules-written fallback names itself as one.
- **An escalation never fails because the model did.** The nurse's action commits first; the
  summary is attached after and falls back to the intake rules.
- **Unavailable integrations refuse with a reason.** Nothing silently falls back to a script.

## Suites

`npm test` — 311 unit/API tests. `npm run test:e2e` — 23 browser tests, Playwright against real
Chrome, using `tests/support/mock-gemini.mjs` so they spend no quota and need no network.

Both were green at handoff. If either fails, fix that before adding anything.

## Claims that would be false

Do not say: HIPAA compliant (no BAA with Google or ElevenLabs, one shared password, synthetic
data only); a completed telephone transfer (there is no telephony, Twilio was deferred); ANS
verification against the live registry; clinical validation of any triage decision; that the
ElevenLabs agent's internal Gemini setting is the direct Gemini API integration.

Do say: synthetic patients only, consenting demo participants, and that the delivery channel for
outreach (SMS or email) is the next integration rather than something already built.

## If you have thirty minutes

1. Test the emergency path. Say "I'm dying, call 911" mid-check-in and confirm the questions
   stop and the nurse sees Emergency.
2. Run the escalation loop across three machines: nurse escalates, provider replies, nurse sees
   the reply in the audit trail.
3. Confirm simulation mode still runs — it is the fallback if the venue is too loud for voice.
4. Check the ElevenLabs character balance in their dashboard. The API key is scoped to
   conversational/TTS and cannot read it.
5. Run `npm run voice:setup -- --update` so the live agent gets the turn-taking settings, then
   knock the table while it is mid-question and confirm it keeps going.
