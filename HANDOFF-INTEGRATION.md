# Handoff: the Callsign integration (branch `integrate-callsign`)

Written 20 September 2026, 00:10, for whoever moves this to the laptop with the Vultr
deployment. Read this with `HANDOFF.md` (the original Aftercare handoff, still accurate for
everything it covers) and `docs/INTEGRATION-CALLSIGN.md` (how the gate works).

## What this branch is

Three commits on top of the original Aftercare `main` (`7b02300`):

| Commit | What |
| --- | --- |
| `61aefa2`, `cc94bab` | Callsign (Wavighna/callsign `main` @ `592da26`) vendored at `callsign/` with `git subtree --squash`. |
| `33e919a`, `2ef7e8d` | Codi's Cove (sahiths2026S/codis-cove `main` @ `a547e65`) vendored at `codis-cove/`. |
| `aecde2e` | **Callsign becomes Aftercare's escalation gate.** The integration proper. |
| `1013ac0` | Demo attempts (spoof / tamper / replay) never decide delivery; the provider sees the newest genuine escalation. |

Nothing is pushed. From the old laptop: `cd /c/dev/aftercare && git push -u origin integrate-callsign`.
From the new laptop: `git fetch && git switch integrate-callsign`.

## The product change, in one paragraph

Aftercare is the app. A nurse's **Escalate** still records the nurse note and the attributed
automated summary, then the **escalation gate** (`server/callsign/`) signs the escalation as the
care-team service identity (`careteam.aftercare.work`) and verifies it as the provider's agent
identity (`lee.callsign-hcp.com`, Dr. Morgan Lee, Orthopedic Surgery): ANS name resolution,
certificate, transparency-log receipt, signature and replay window, the provider's policy, then a
content screen adapted to clinical escalations. The decision and the evidence of every check are
written to the case record. **Delivered** escalations appear on `/provider` with the evidence
next to the note and summary; **held** (provider policy) and **rejected** (any check) ones stay
on the nurse's case with the reason and a Retry button. Three demo buttons on the nurse's case
push an attacker's copy of the last escalation through the same gate. Nothing about urgency,
disposition, emergency handling, calling, or the provider reply thread changed. No simulated
doctor, no second conversation store.

## Everything that changed (44 files, +3528 / -53)

### New: the gate module `server/callsign/`

| File | Origin | Notes |
| --- | --- | --- |
| `gate.ts` | new | `EscalationGate.deliver()`: build signed request → `verifyReach` → screen → persist → audit → `publish()`. Demo variants. Provider policy get/set. Never throws. |
| `screening.ts` | rewritten | Clinical escalation policy: blocks credential / payment / remote-access / bypass requests; clinical detail and patient-records language are expected; pressure language is a warning, never a hold. Local rules only. |
| `config.ts`, `identities.ts`, `types.ts` | new | Env-driven config (`configureCallsign()` for tests), the two identities as live getters, the contracts extracted from Callsign's shared package. |
| `pipeline.ts`, `ans.ts`, `local-registry.ts`, `replay.ts`, `evidence.ts`, `sign.ts`, `policy.ts` | copied from `callsign/server/src/verify/` and `policy.ts` | Verification core as-is. Edits: imports rewritten to `./x.js`; `KEYS_DIR` → `config.keysDir`; `ansMode()` reads config; `policy.ts` lost its event/audit emitters; a WebCrypto typing cast in `cryptoKeysFor` (Aftercare's tsconfig includes the DOM lib). |

### Modified in Aftercare

| File | Change |
| --- | --- |
| `server/app.ts` | Imports the gate and mounts the registry at `/ans`. Escalate now takes `nurse`, awaits `attachEscalationSummary` **and then `gate.deliver`** before responding. New routes: `GET /api/patients/:id/escalation[?genuine=1]`, `POST .../escalation/retry`, `POST .../escalation/demo`, `GET/POST /api/provider/policy`, `GET /api/proof/:requestId`. Capabilities gain `escalationGate`, `escalationGateReason`, `providerAgentName`, `providerName`, `careTeamAgentName`, `registryMode`. |
| `server/store.ts` | New table `escalations` (one row per attempt, JSON `data`, scoped by run). `saveEscalation`, `latestEscalation(patientId, genuineOnly)`, `escalationByRequest`. `detail()` returns `escalation`. **`providerQueue()` now lists only cases whose newest genuine escalation is `delivered`** and includes the record. |
| `server/index.ts` | Unchanged in effect (an earlier desk-client config line was added and removed). |
| `shared/types.ts` | `EscalationRecord`, `EscalationStep`, `EscalationScreening`, `EscalationView`, `ProviderPolicy`; `Capabilities` and `PatientDetail` extended. |
| `src/EscalationGate.tsx` | New. The panel (nurse: verdict, reason, retry, demo buttons; provider: evidence rows, proof and registry links) and `ProviderPolicyToggle`. |
| `src/App.tsx` | Renders the panel on an escalated case; sends `nurse` with actions. |
| `src/ProviderView.tsx` | Renders the panel (provider mode) and the policy toggle in the header; queue item type gains `escalation`. |
| `src/RoleLanding.tsx` | A note card when the gate is on, and a link card to Codi's Cove (`http://127.0.0.1:4173/`). |
| `src/styles.css` | Appended `.escalation-gate`, `.gate-*`, `.policy-toggle`, `.landing-note`, and an unused `.provider-agent` block from an abandoned approach (harmless; delete if you like). |
| `vite.config.ts` | **Dev proxy now preserves the browser's Host header.** Vite 8 rewrote it to the API port, so every browser POST in `npm run dev` was a 403 from the same-origin guard. Production (`npm start`, one port) was never affected. |
| `vitest.config.ts` | Excludes `callsign/**` and `codis-cove/**`; `testTimeout: 30000` (the pipeline paces its checks, ~3 s per delivery). |
| `tsconfig.json` | `exclude` for `node_modules`, `dist`, `callsign`, `codis-cove`. |
| `package.json` | Deps `@peculiar/x509@2.1.0`, `reflect-metadata@0.2.2` (pure JS). Scripts `agent`, `agent:start`, `agent:test` (the vendored Callsign), `cove` (Codi's Cove), `dev:all`. |
| `.env.example` | `PROVIDER_NAME`, `PROVIDER_SPECIALTY`, `PROVIDER_AGENT_NAME`, `CARE_TEAM_AGENT_NAME`, `CARE_TEAM_DISPLAY_NAME`; optional `CALLSIGN_KEYS_DIR`, `ANS_MODE`, `PUBLIC_BASE_URL`. |
| `.dockerignore` | New: keeps `node_modules`, `callsign`, `codis-cove`, `dist`, `data`, `.git` out of the image (there was none before; `COPY . .` was copying the host `node_modules` too). |
| `README.md` | New section "The escalation gate (Callsign, built in)". |
| `docs/INTEGRATION-CALLSIGN.md` | New. Module map, identities, API, invariants, claims not made. |
| `tests/unit/escalation-gate.test.ts` | New, 13 tests: delivered with all six checks; urgency and disposition untouched; held by policy then retried; spoof rejected at resolve; tamper at signature; replay at signature; demo refused before a genuine escalation; credential request blocked by screening; proof record; `/ans` served; screening rules. |
| `.claude/launch.json` | Dev-server entry for the Claude desktop preview. Not needed for anything else. |

### Modified inside the vendored `callsign/` (still runs standalone, not called by Aftercare)

`config.ts` gained `HCP_DOCTOR_NAME`, `HCP_SPECIALTY`, `HCP_ORGANIZATION`, `BRAND_DISPLAY_NAME`,
`BRAND_ORGANIZATION`; `seed/data.ts`, `desk.ts`, `screening.ts`, `policy.ts`, `call/provider.ts`,
`call/gemini-dialogue.ts` use them instead of the literal "Dr. Patel"; the desk's `/status`
reports the doctor and `DeskApp.tsx` shows it and can open a session from `?session=<id>`;
`screening.ts` treats "escalation / case review / provider review / post-discharge" as ordinary
purposes. Its typecheck, lint and 53 tests pass. These edits are optional to the integration.

### Not changed

`deploy/` (Dockerfile, Caddyfiles, compose files, LiveKit), `server/triage.ts`, `server/gemini.ts`,
`server/briefing.ts`, `server/voice.ts`, `server/handoff.ts`, `server/ans.ts` (the older
GoDaddy-registry client used by the LiveKit handoff; untouched), the patient pages, all e2e tests.

## Running it on the new laptop

Node 24 or newer (`node:sqlite`). Then:

```bash
npm ci
cp .env.example .env        # keep the existing .env if there is one; add the PROVIDER_* / CARE_TEAM_* lines
npm run build && npm start  # http://127.0.0.1:4317
```

- **Open `http://127.0.0.1:4317`, not `localhost`.** The same-origin guard compares Origin with Host.
- **Windows only:** Aftercare's scripts use POSIX env syntax (`PORT=4318 node …`). npm runs scripts
  through cmd.exe, so run from Git Bash with
  `export npm_config_script_shell="C:/Program Files/Git/bin/bash.exe"` or use `npm start` after
  `npm run build` inside Git Bash. On macOS or Linux nothing is needed.
- First run prints `[ans:local] registry ready · CA Callsign Local ANS CA (demo) · 2 agents · log size 2`
  and creates `data/callsign-keys/` (private CA, agent keys, certificates; gitignored under `data/`).
  Deleting that directory re-issues everything on next start; agent ids are deterministic so the
  registry looks the same, but earlier proof records will reference certificates that no longer exist.
- The vendored projects have their own installs: `cd callsign && npm install`, `cd codis-cove && npm ci`.
  Only needed for `npm run agent` / `npm run cove`.

## Vultr: what to change before redeploying

The `deploy/` files were not modified. Three things matter:

1. **Environment.** Compose passes the root `.env` through (`env_file: ../.env`). Add to it on the
   app host: `PROVIDER_NAME`, `PROVIDER_SPECIALTY`, `PROVIDER_AGENT_NAME`, `CARE_TEAM_AGENT_NAME`,
   `CARE_TEAM_DISPLAY_NAME`, and **`PUBLIC_BASE_URL=https://<your app domain>`**. `PUBLIC_BASE_URL`
   is what the registry writes into the `_ans-badge` TXT records and the evidence rows
   ("Badge URL", "Source"); left at the default it prints `http://localhost:4317/ans/...` in the
   provider's evidence panel, which is wrong on a public host.
2. **Keys on the volume.** Set `CALLSIGN_KEYS_DIR=/data/callsign-keys` in the container environment
   so the CA and certificates live on the persistent `aftercare-data` volume and survive
   `docker compose up --build`. Without it they are regenerated on every deploy (works, but proof
   records from before the deploy point at vanished certificates). `deploy/compose.app.yml` gets one
   line under `environment:`.
3. **Caddy.** Everything except `/c/*`, `/api/outreach/*`, `/assets/*`, `/icon.svg` is behind basic
   auth. `/ans/*` (the registry) and `/api/proof/:id` therefore need the dashboard login. That is
   fine for the demo. If you want a judge to `curl` the registry without the password, add `/ans/*`
   to the `@protected not path …` exception list in `deploy/Caddyfile`; it is read-only public data.

The `.dockerignore` is new and shrinks the build context a lot; the image build itself
(`npm ci --include=dev && npm run build`) is unchanged. `npm test && npm run build` before
deploying, as `HANDOFF.md` says.

## What was tested, and how

| Check | Result |
| --- | --- |
| `npm test` (vitest) | 311 original tests + 13 gate tests, all passing, on Windows, Node 24.19. |
| `npx tsc --noEmit`, `npx vite build` | Clean. |
| `cd callsign && npm run typecheck && npm run lint && npm test` | Clean, 53 tests. |
| Browser, dev server, no keys | Nurse escalates Miguel Alvarez → "Delivered to Dr. Morgan Lee through lee.callsign-hcp.com · 6 of 6 checks passed" → provider page shows the case with the full evidence trail → provider replies → nurse sees "Provider replied" and the text. Spoofed-sender demo → "Rejected at resolve agent name: no ANS record for aftercare-careteam.xyz", provider queue unaffected. Landing page shows the gate note and the Codi's Cove link. |

**Not tested, by me:**

- `npm run test:e2e` (Playwright, real Chrome, runs against `dist/`). The escalation e2e specs in
  `tests/e2e/sponsor.spec.ts` (escalation separation, the two-screen nurse ↔ provider conversation)
  exercise `providerQueue()`, which now requires a delivered gate record. They should pass because
  the gate runs inside the same request, but run them: `npm run build && npm run test:e2e`.
- Held → retry, tampered and replayed demos, and the provider policy toggle **in the browser**
  (all covered by unit tests, not clicked through).
- Anything with `GEMINI_API_KEY` set. The gate does not use Gemini; the automated summary does, as
  before, and escalation waits for it (up to the briefing budget) plus ~3 s of gate checks. Warm the
  briefing for the demo patient first, as `HANDOFF.md` recommends.
- The production server (`npm start`) on the new machine, the Docker build, and the Vultr redeploy.
- Mobile widths of the new panel below 800 px (the evidence table is wide; it wraps, not verified).

## Test checklist on the new laptop

1. `npm ci && npm test && npm run build && npm run test:e2e`.
2. `npm start`; open `http://127.0.0.1:4317/nurse`; New demo (clean run); select Miguel Alvarez;
   run the Wound concern simulation; Escalate with a note. Expect the green panel within ~4 s.
3. `/provider?name=Dr%20Morgan%20Lee`: the case is queued; "Show the checks" lists six passed checks
   with evidence; reply; confirm it reaches the nurse's thread.
4. On the nurse's case: **Spoofed sender**, **Tampered message**, **Replayed message**. Each shows a
   rejected demo attempt naming the check (resolve, signature, signature). The provider queue keeps
   the case.
5. On the provider page flip **Accepting escalations** off; escalate another featured patient; the
   nurse sees "Held by the provider's policy: In clinic · held in inbox"; flip it on; **Retry delivery**
   → delivered.
6. Escalate with a note containing "send me the verification code" → rejected by content screening;
   the case stays escalated with the nurse.
7. `curl -s http://127.0.0.1:4317/ans/ | head`, `…/ans/dns/_ans-badge.careteam.aftercare.work`,
   `…/api/proof/<requestId from the panel's proof link>`.
8. Emergency path and simulation, exactly as `HANDOFF.md` lists them: nothing in the gate touches
   them, but they are the highest-stakes paths and should be re-run after any merge.
9. Deployed: repeat 2 to 4 over `https://<domain>` and confirm the evidence rows show the public
   `PUBLIC_BASE_URL`, not localhost.

## Design rules the integration keeps (do not loosen)

- The gate reads severity and never writes it. Only a nurse changes disposition.
- The nurse's escalation is recorded **before** the gate runs; a rejected or held delivery never
  un-escalates the case.
- Generated text stays attributed: the summary (`escalation_summary`), the gate's verdict
  (`escalation_gate`, actor `Aftercare · escalation gate (Callsign)`), and provider notes are
  separate audit entries. The gate never writes a provider note.
- Demo attempts are recorded with `variant: spoof|tamper|replay` and never decide delivery.
- No silent degradation: `ANS_MODE=mock` labels registry checks as simulated in the record.

## Claims to avoid in the pitch

No public GoDaddy ANS registration is made; the registry is the app's own (real X.509 and Merkle
log, local trust anchor). Verifying the care-team signature authenticates the service, not the
nurse. Content screening is deterministic local rules, not a fraud guarantee. No audio goes
through the gate. Everything in `HANDOFF.md` under "Claims that would be false" still applies.
