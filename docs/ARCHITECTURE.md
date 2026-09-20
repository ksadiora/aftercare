# Architecture

One Express server, one SQLite file, one React bundle with four surfaces. No queue,
no cache, no second service. That is deliberate: the demo has to survive a conference
network on a laptop, and every moving part is one that can fail in front of an
audience.

```
                        ┌──────────────── browser ────────────────┐
                        │  /nurse    /provider   /patient   /c/:t │
                        └───────┬─────────────────────────┬───────┘
                                │  fetch /api/*           │  EventSource /api/events
                                ▼                         ▼
                        ┌──────────────── server/app.ts ──────────┐
                        │  zod validation · AppError · publish()  │
                        └──┬──────────┬──────────┬──────────┬─────┘
                           │          │          │          │
                     store.ts    triage.ts   gemini.ts   voice.ts / handoff.ts / ans.ts
                           │                     │              │
                      SQLite file          Google AI    ElevenLabs / LiveKit / ANS
```

## Surfaces

`src/main.tsx` matches on `window.location.pathname`:

| Path | Who | Component |
| --- | --- | --- |
| `/` | role chooser | `RoleLanding` |
| `/nurse?nurse=Name` | care team | `App` |
| `/provider?name=Dr%20X` | provider | `ProviderView` |
| `/patient` | staff | `PatientPicker` |
| `/c/<32-hex token>` | the patient | `PatientCheckIn` |

In production Caddy puts everything behind HTTP basic auth **except** `/c/*`,
`/api/outreach/*`, `/assets/*` and `/icon.svg`. The token in a patient's URL is their
only credential, and it reaches only their own check-in — never the worklist. If you
add a patient-facing route, it must be scoped the same way, and you must add it to the
Caddyfile's exception list or it will 401 for the patient.

Identity is a query parameter (`?nurse=`, `?name=`). There is no login. That is fine
for a demo and is not fine for anything else; see "Claims that would be false" in
[HANDOFF.md](../HANDOFF.md).

## Data model

SQLite via `node:sqlite`, WAL mode, one file. Tables: `runs`, `patients`, `sessions`,
`turns`, `observations`, `audit`, `handoffs`, `outreach`. Most rows store a JSON blob
in a `data` column with the structural columns needed for lookups — the schema is
deliberately loose because the shapes in `shared/types.ts` are the real contract.

**Runs isolate demos.** Everything is scoped by `runId`. "New demo" creates a new run
and re-seeds; earlier runs stay readable in history. Any query you add almost
certainly needs `WHERE runId=?`.

**The `audit` table is the record.** It takes arbitrary `kind` and `actor` strings and
is append-only in practice. Prefer an audit entry over a new column when the thing is
an event. Two things are *derived* from it rather than stored separately:

- `store.caseThread(patientId)` — the nurse ↔ provider conversation, assembled from
  the `escalate`, `nurse_note` and `provider_note` entries. A case cannot hold a
  discussion the permanent record does not show.
- `dashboard().awaitingNurse` — cases whose newest message came from a provider.

Audit `actor` carries attribution, including for generated content:
`Aftercare · gemini-3.6-flash` versus `Aftercare · intake rules (…)`. That is how the
UI can always show what a model wrote separately from what a person wrote.

## The intake state machine

`shared/protocol.ts` holds the questionnaire: `consent → incision → fever →
medications → falls → nutrition → transport`, in English and Spanish.

`store.ingest(sessionId, eventId, role, text)` is the only way a patient answer enters
the system, from every channel — voice transcript, text chat, simulation. It:

1. de-duplicates on `eventId` (transports retry; this must be idempotent)
2. refuses if the session is over or past five minutes
3. classifies with `triage.classify()` — **rules only, no model**
4. records an observation and an audit `flag` for anything non-benign
5. raises severity monotonically, on both the session and the patient
6. reopens a resolved case when new evidence arrives
7. advances `questionIndex`, or holds it for exactly one adaptive follow-up
8. writes `session.next` — the instruction every channel then delivers

Everything downstream reads `session.next`. The voice agent fetches it through
`get_next_step`; the chat path writes it straight into the transcript; simulation
speaks it. One source of truth, three deliveries.

## Adaptive follow-ups

When a model is configured, an answer the rules could not read gets one rephrasing,
and an answer that raised a flag gets one follow-up for observable detail — at most
once per question, on the same topic. `server/respond.ts` applies it optimistically
against a `session.version` and discards a result that arrives stale.

The severity decided in step 3 stands regardless. The model cannot advance the
questionnaire, downgrade a concern, or end the intake, and a content guard rejects
reassurance, diagnosis, treatment advice, emergency instructions and closure claims.

## Live updates

`GET /api/events` is a Server-Sent Events stream. Every mutating route calls
`publish()`, which writes one `update` event to all peers; each client re-fetches
what it needs. No payload, no diffing, no subscription management. At demo scale this
is right, and it means adding a mutation is one line rather than a new channel.

If you add a route that changes state another surface displays, **call `publish()`**.
Forgetting is the most common cause of "it worked when I refreshed".

## Model adapters

`server/gemini.ts` is the only place that talks to Google. `generateJson()` handles
structured output, an 8-second default deadline, one retry that gets whatever time is
left, and mapping provider statuses to sentences a user can act on.

Callers validate meaning, not just shape. `server/briefing.ts` drops any statement
whose cited transcript lines do not exist, and answers "Not established in this
conversation." when a question is not grounded — that guarantee is ours, not the
model's.

Two models by default, chosen from measured latency: `gemini-flash-lite-latest` for
in-turn clarifications (~0.9 s, inside the 10 s ElevenLabs tool timeout) and
`gemini-3.6-flash` for the briefing, which has no turn deadline.

## Deployment

Two Vultr hosts, Docker Compose on both.

- **app** — this server plus Caddy for automatic HTTPS and basic auth. SQLite on a
  named volume at `/data`.
- **media** — LiveKit and TURN behind Caddy for TLS on the signalling port.

Compose refuses to start without `APP_DOMAIN`, `DASHBOARD_USER` and
`DASHBOARD_PASSWORD_HASH`, so the dashboard cannot be published unauthenticated by
accident. `TRUSTED_HOSTS` is what actually allows a non-localhost host — DNS alone is
not enough, and the server 403s a host it was not told about.

See `deploy/README.md` for the infrastructure, and your local production notes file
for the host-specific values (they are not in the repository).
