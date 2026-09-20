# Merging another project into this one

This repository is the **host**. It runs the server, owns the database, owns the
calling system, and is deployed. Other projects are being merged into it. They do not
run alongside it and they do not bring their own server.

Read this before moving any code. The failures below are the ones that actually
happen when two working codebases become one, and most of them are silent.

---

## Decide what the incoming project *is*

Almost everything you might merge is one of four things. Pick one before you start;
the work is different for each.

**1. A new surface** — another page for another role (a caregiver view, an admin
console, a different clinician's queue).

Add a branch in `src/main.tsx`, a component in `src/`, and read-only API routes in
`server/app.ts`. Decide its auth: anything not in the Caddyfile's exception list sits
behind basic auth. If it is patient-facing it must be token-scoped and must not be
able to read the worklist.

**2. A new data source or integration** — another provider, registry, EHR stub,
delivery channel.

Give it its own `server/<thing>.ts` with a `capability()` function returning
`{ enabled, reason }`, exactly like `voice.ts`, `gemini.ts`, `handoff.ts` and
`ans.ts`. Surface it through `/api/capabilities`. **When it is not configured it must
refuse with a reason** — never quietly do something else instead.

**3. A new conversation channel** — SMS, WhatsApp, email, a different voice provider,
a phone bridge.

This is the one with real risk. Go to [docs/CALLING.md](CALLING.md) and read "The
server owns the questionnaire" first. Your channel delivers `session.next.instruction`
and feeds answers back through `store.ingest()`. It does not hold a script, does not
decide urgency, and does not decide when the intake is finished. A channel that keeps
its own copy of the questionnaire will silently diverge from the record the nurse
reads, and the nurse is the person making the decision.

**4. Analytics, dashboards, reporting.**

Read from the store; do not write. Everything you need is already in `audit`,
`turns`, `observations` and `sessions`, scoped by `runId`.

## Order of operations

Do it in this order. Each step is verifiable before the next one can break it.

1. **Get this repository green first.** `npm test && npm run build && npm run test:e2e`.
   You need a known-good baseline or you will not know what the merge broke.
2. **Bring the incoming code in unwired**, in its own files. No imports from it yet.
   Commit. The test suite must still be green — if it is not, the problem is a
   collision (below), not your integration.
3. **Reconcile dependencies.** One `package.json`. See "Dependency collisions".
4. **Reconcile types.** Move shared shapes into `shared/types.ts`; do not keep two
   definitions of the same concept.
5. **Wire one path end to end**, with a test, before wiring the second.
6. **Port the incoming project's tests.** If it has none, write them for the
   behaviour you just wired. Do not merge untested behaviour into a codebase whose
   suite is the reason anyone trusts it.
7. **Run all three suites again**, then deploy to a scratch database before the live one.

## Collisions to expect

**Dependencies.** This project pins exact versions and keeps the list short. If the
incoming project wants a different major of React, Vite, Express or Zod, the host
version wins and the incoming code is adapted — not the reverse. Adding a large
dependency for one helper is not worth it; look for it in what is already here.

**Ports.** 4317 (app / Vite), 4318 (dev API), 4320 (e2e server), 4399 (e2e mock
Gemini). An incoming project that hardcodes one of these will fight the test suite in
ways that look like flakiness.

**Module system.** Server code is Node ESM and imports `../shared/thing.js` **with**
the `.js` extension. Client code imports `../shared/thing` **without** it. Incoming
CommonJS needs converting. Do not add a bundler step to the server to avoid this.

**The database.** One SQLite file, one `Store` class. Do not open a second connection
to the same file from another module — go through `Store`, and add a method if you
need one. Every table is scoped by `runId`; a query without it will leak rows across
demo runs and look like data corruption.

**Route namespace.** All API routes live under `/api/*` in one `server/app.ts`. A
second router mounted elsewhere bypasses the host/origin checks, the JSON content-type
guard and the rate limiter in that file's middleware — all of which are security
controls, not conveniences.

**CSS.** One global `src/styles.css`, no modules, no Tailwind. Class names are
unprefixed and generic (`.patient-row`, `.case-thread`). Incoming CSS will collide.
Prefix incoming classes, and check the result at 1000px, 1180px and 1440px — there
are breakpoints that hide whole columns.

**Environment variables.** Add new ones to `.env.example` with a comment saying what
breaks without them. Compose passes `../.env` through; anything required at boot must
fail loudly rather than default to something insecure.

## What you must not break

The invariants in [AGENTS.md](../AGENTS.md#invariants) are the product. Three of them
are the ones an integration usually breaks by accident:

- **Rules decide urgency, never a model.** If the incoming project has its own
  classifier or an LLM that assigns severity, it does not get to write
  `session.severity` or `patient.severity`. Feed it in as an additional observation
  for a human to read, or leave it out.
- **Unavailable integrations refuse with a reason.** A merged integration that
  silently no-ops, or falls back to a script without saying so, breaks the one thing
  this project claims about itself.
- **A generated sentence is never presented as a person's words.** If incoming code
  produces summaries, they get their own attribution and their own block.

Additionally: **only a nurse closes a case.** Whatever you merge, it does not change
`patient.disposition`.

## Verification checklist

Not "it compiles". Run these:

```sh
npm test            # 311 unit/API tests
npm run build       # tsc --noEmit && vite build
npm run test:e2e    # 23 browser tests — run AFTER build, it serves dist/
```

Then, by hand, because these are the things tests do not catch:

- [ ] **Emergency path.** Say "I'm dying, call 911" and "my head hurts a lot and I'm
      very dizzy" mid-check-in. Questions stop; the 911 instruction plays in full;
      the nurse sees Emergency. This has broken twice; it is the highest-stakes
      behaviour in the product.
- [ ] **An ordinary ache is still ordinary.** "My knee hurts a lot, which I expected"
      must not trigger 911. A triage that cries wolf is worthless.
- [ ] **A full voice check-in on real hardware**, with someone knocking the table
      mid-question. The agent should carry on.
- [ ] **The escalation loop across two machines**: nurse escalates, provider replies,
      nurse answers, both see the same thread.
- [ ] **Simulation still runs** with no credentials at all. It is the fallback when
      the venue is too loud or the network is hostile.
- [ ] **Every capability reports honestly** with its key removed — no silent
      fallbacks.
- [ ] **A patient token still reaches only that patient.** Open `/c/<token>` in a
      private window and confirm the worklist is unreachable.

## Before the first push to GitHub

- `.env` is gitignored. Confirm it stayed that way: `git check-ignore -v .env`.
- No live host, key path or password hash in a tracked file. Infrastructure values
  belong in a local, ignored notes file.
- If the repository is public, remember the built client bundle is publicly
  downloadable by design (the patient's page has to load it). It contains no data —
  every API call still needs a credential — but do not put anything in client code
  you would not publish.
