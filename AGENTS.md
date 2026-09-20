# AGENTS.md

Operating manual for anyone — human or agent — writing code in this repository.

**This repository is the host.** It runs the server, owns the database, and owns the
calling system. Other projects are being merged *into* it, not alongside it. If you
are here to bring another codebase in, read [docs/INTEGRATION.md](docs/INTEGRATION.md)
first; it exists to stop the merge breaking what already works.

---

## What this is

Aftercare is a post-discharge follow-up demonstration. A synthetic patient is called
or messaged a few days after surgery, answers a fixed clinical questionnaire, and a
nurse gets a risk-sorted worklist with the patient's own words. The nurse can escalate
to a provider and hold a written conversation with them, or open a live audio call
with the patient.

Every patient is synthetic. Nothing here is a validated clinical instrument.

## Commands

```sh
npm install
npm run dev          # Vite on 4317, API on 4318, watched
npm start            # production: one server on 4317, serves built assets
npm run build        # tsc --noEmit && vite build
npm test             # 311 unit/API tests (vitest)
npm run test:e2e     # 23 browser tests (Playwright, real Chrome)
npm run voice:setup            # create the ElevenLabs agent (once)
npm run voice:setup -- --update  # push turn-taking settings to the existing agent
```

**`npm run test:e2e` serves `dist/`, not your source.** `npm start` runs with
`NODE_ENV=production`, so a front-end change you have not built is invisible to the
browser tests and they will fail against the old bundle. Always `npm run build` first.

## Layout

| Path | What lives there |
| --- | --- |
| `server/` | Express API, SQLite store, triage rules, model adapters. No React. |
| `shared/` | Types and the questionnaire protocol. Imported by **both** sides — keep it dependency-free. |
| `src/` | React client. All four surfaces: nurse, provider, patient, patient picker. |
| `tests/unit/` | Vitest. Server logic, API contracts, and client adapters with the SDK mocked. |
| `tests/e2e/` | Playwright against real Chrome, with a local stand-in for Gemini. |
| `deploy/` | Dockerfile, Compose, Caddy. Two hosts: app and media. |
| `scripts/` | One-off operational scripts. |
| `docs/` | Architecture, the calling system, and the integration playbook. |

Server files import from `../shared/*.js` (note the `.js` extension — Node ESM).
Client files import from `../shared/*` without it. Do not "fix" either.

## Invariants

These are load-bearing. The project's value is that it degrades honestly, and each of
these is the reason a specific failure cannot happen. Changing one is a product
decision, not a refactor — raise it before you touch it.

1. **Rules decide urgency, never a model.** `server/triage.ts` assigns severity. A
   language model may rephrase a question or ask one follow-up on the same topic. It
   cannot advance the questionnaire, change severity, end an intake, or resolve a
   case. This is enforced structurally, not by prompt.
2. **Emergency routing runs before any model is consulted.** A 911 instruction never
   waits on inference.
3. **Severity is monotonic.** A later benign answer cannot walk back a flag.
4. **A handoff is only "active" when both parties have joined.** Never render a
   transfer that has not happened.
5. **Every unhappy ending preserves an urgent callback task** and reopens a resolved
   case.
6. **Only a nurse closes a case.** A provider note, a nurse note, and a generated
   summary all decide nothing.
7. **A generated sentence is never presented as a person's words.** Separate audit
   entries, separate attribution, separate blocks on screen.
8. **Unavailable integrations refuse with a reason.** Nothing silently falls back to
   a script. A rules-written fallback says that is what it is.
9. **The patient's own words are preserved verbatim**, in their own language. A
   translation is always labelled as generated.

## Conventions

Match the surrounding code. Concretely, in this repo that means:

- **Comments explain why, not what.** Nearly every non-obvious line here carries the
  reasoning that put it there, usually the bug it prevents. Keep that up; it is the
  single most useful thing in the codebase.
- **Terse, dense style.** Multiple short statements per line where they belong
  together. Do not reformat existing code to a different taste.
- **No new dependencies without a reason you can state.** The dependency list is
  short on purpose.
- **Every behaviour change gets a test.** Where a bug came from a real failure, the
  test names that failure. Add the phrasing that broke it to the table, not a
  paraphrase.
- **Errors are sentences a user can act on**, not status codes. See
  `serverMessage()` in `src/api.ts` and the `providerError()` helpers in
  `server/voice.ts` and `server/gemini.ts`.
- **`AppError(status, message)`** is how the server reports anything a client should
  see. `src/api.ts` throws `ApiError` with the status so a caller can tell "already
  over" from "broken".

## Adding things

**A new API route.** Put it in `server/app.ts` beside its neighbours. Validate the
body with `zod`. Throw `AppError` for anything the user should read. Call `publish()`
after any change other surfaces need to see — that is the SSE broadcast every client
listens on. Rate-limit anything that spends provider quota with `limit(req, n)`.

**A new persisted fact.** Add it to the relevant type in `shared/types.ts` and to the
store method that owns it. The `audit` table takes arbitrary `kind` and `actor`
strings — prefer an audit entry over a new column when the thing is an event, and
prefer deriving over storing when the derivation is cheap (`store.caseThread()` is
assembled from audit rows rather than kept beside them, so a case cannot hold a
discussion the record does not show).

**A new surface.** `src/main.tsx` does path matching; add a branch. Anything not
under `/c/*`, `/api/outreach/*`, `/assets/*` or `/icon.svg` sits behind HTTP basic
auth in production — see `deploy/Caddyfile`. A patient-facing route must be
token-scoped and must never be able to read the worklist.

**A new model call.** Use `generateJson()` in `server/gemini.ts`. It already handles
timeouts, one retry with a deadline, structured output, and mapping provider statuses
to sentences. Validate the *meaning* of what comes back yourself — a schema-valid
object can still be clinically wrong, which is why briefing statements without
checkable citations are dropped.

## Gotchas that cost hours

Each of these is fixed. They are recorded because the reasoning is not obvious from
the diff, and because the same class of mistake will be available to the next person.

- **`livekit-client` does not play remote audio.** Its `TrackSubscribed` handler only
  attaches playback listeners and re-emits; the application must call
  `track.attach()`. The symptom is a call that connects, publishes both tracks,
  passes ICE, and is silent.
- **`gemini-2.5-*` is refused for API keys issued since mid-2025** with a 404 that
  reads like a model-name error.
- **The Gemini free tier runs out on the briefing.** A 429 surfaces as "Gemini quota
  is exhausted". Set `GEMINI_BRIEFING_MODEL=gemini-flash-lite-latest` or enable
  billing. Briefings are cached per `sessionId:version`; escalating warms that cache.
- **The ElevenLabs SDK's input meter reports zero while muted**, which is exactly
  when the barge-in gate needs a reading. The gate runs on its own `getUserMedia`
  stream — the one the permission prompt already opened.
- **A `:` inside a `${VAR:?message}` default breaks Compose YAML.** Quote every one.
- **`docker compose stop` interpolates the whole file**, so it needs `APP_DOMAIN` and
  the dashboard credentials exactly like `up` does. Without them it fails, and under
  `set -e` it fails silently.
- **`.follow-up-cell` is hidden below a breakpoint.** Anything that must always be
  visible on a worklist row belongs in `.patient-identity`.
- **`response.json()` on a non-JSON body** produced "Unexpected end of JSON input"
  whenever the proxy returned 502 during a redeploy. `src/api.ts` reads text first.

## Before you open a PR

```sh
npm test && npm run build && npm run test:e2e
```

- All three green. `npm run build` **before** `test:e2e`.
- No new secret in a tracked file. `.env` is ignored; keep it that way.
- Any invariant you touched is called out explicitly in the PR description.
- Any behaviour a person reported is covered by a test that names the report.
- If you added an emergency phrasing to `server/triage.ts`, you added rows to **both
  halves** of the table in `tests/unit/triage.test.ts` — the must-fire half and the
  must-not-fire half. An emergency on every ache is as bad as a missed one.

## Where to read next

- [README.md](README.md) — what the product does and how to run it.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data model, request flow, run isolation.
- [docs/CALLING.md](docs/CALLING.md) — the calling system, in depth. Start here if you
  are integrating anything that makes noise.
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — merging another project into this one.
- [HANDOFF.md](HANDOFF.md) — what is verified, what is not, and claims that would be false.
