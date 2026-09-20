# Integrating Codi’s Cove

Handoff for the larger hackathon project, September 19, 2026. The receiving project’s stack is not decided, so this guide covers keeping the game as a separate application and merging it into a host frontend/backend. The guide does not perform either integration.

## Start here

Codi’s Cove is a complete vanilla JavaScript page with a Three.js world and a Node API server. For the hackathon, start with a link or dedicated iframe to the separately running game. This preserves the working game, service origin, and current browser save. Merge the code only when the parent project’s routing and state ownership are decided.

**Preserve `dist/`. It contains the authored game source**, not disposable build output. A host framework’s build must not overwrite it. Uploading only `dist/` does not include the Gemini, Nessie, or Notion backend.

Current checkout: Gemini has returned live answers and Nessie has confirmed a synthetic deposit. Notion’s adapter is implemented but its workspace is not configured. A copy of the source archive contains no credentials or runtime event journal, so its integrations need separate setup.

## Run the supplied application

From the `codi-world` directory, with Node.js 20 or newer:

```sh
npm ci
npm run build
npm test
npm start
```

Open [Codi’s Cove locally](http://127.0.0.1:4173/). `npm run build` copies the pinned Three.js vendor modules and validates source/assets. It is not a bundler. The supplied `dist/` can already run with `npm start` without rebuilding.

For a fresh checkout, copy `.env.example` to `.env` and fill it locally. Preserve an existing `.env`. Restart the server after editing credentials. To choose another port, use `PORT=4174 npm start` in the shell. **PORT in `.env` has no effect** because the loader only reads service-prefixed keys.

WebGL 2 enables the 3D world. The earlier dialog lessons provide a fallback if initialization fails. External services require internet access; local exploration and practice tutorials do not. Use an HTTP server, not `file://`.

## Approach A: keep the game as its own application

### A1. Link from the host project

Run both projects locally. Add a launch link in the parent app:

```html
<a href="http://127.0.0.1:4173/" target="_blank" rel="noopener">
  Play Codi’s Cove
</a>
```

This is the least invasive handoff. Keep using `127.0.0.1:4173` to retain the current save. `localhost:4173` and another port are different browser storage origins. On another computer, the same loopback URL means that computer, so the recipient must start their own copy.

### A2. Embed the complete game page

For a local React or Next.js host, a wrapper can render the separate page without importing its bootstrap:

```jsx
export default function CodiGamePage() {
  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <a href="http://127.0.0.1:4173/" target="_blank" rel="noopener">
        Open game in its own tab
      </a>
      <iframe
        title="Codi’s Cove life-skills game"
        src="http://127.0.0.1:4173/"
        style={{ flex: 1, minHeight: 0, width: "100%", border: 0 }}
        allowFullScreen
      />
    </main>
  );
}
```

The equivalent plain HTML iframe works in other stacks. Click inside the frame before using game keys. Keep the direct-open link available if browser embedding/storage policies prevent the frame from working. An HTTPS parent may restrict an HTTP local frame; use the direct link for the local demo rather than bypassing browser protections.

The frame owns its DOM, keyboard handling, dialogs, localStorage, and `/api` calls. **There is no shared login, parent progress feed, or `postMessage` bridge today.** Leaving and remounting the frame resets session-only state, including chat and avatar position. Saved adventure progress remains on the game’s origin, subject to browser storage policy. Do not add an iframe sandbox casually: script, origin, and storage restrictions can break the game.

For future parent/game messaging, define a small versioned contract, validate `event.origin` and `event.source`, and use an exact target origin. Start with a read-only progress event. Do not expose arbitrary commands, credentials, or transaction writes through a bridge. This is proposed work, not a supported API.

## Approach B: merge into the host frontend and backend

### B1. Keep a standalone page under the host

An intermediate option is to copy the contents of `dist/` into a dedicated static directory such as `public/codi/`, retaining its internal layout, and load `/codi/index.html` in a frame. This shares the host origin while keeping the game DOM isolated.

The backend still needs integration. All current service calls use **root-relative `/api/...`** paths. Serving the game below `/codi/` does not change those routes. Either reserve the listed `/api` endpoints in the host or add an explicit API prefix option to `dist/services.js` and route it consistently. There is no existing `API_BASE_URL` or framework base setting to configure.

Keep HTML, CSS, image, vendor, and ES module paths together. For directory URLs, preserve the trailing slash. The current static server has no SPA fallback. Use `/codi/index.html` where the host does not serve directory indexes.

### B2. Turn the game into a mounted frontend module

This requires a refactor. `dist/app.js` runs immediately, captures global DOM IDs, and has no exported `mount()`/`unmount()` interface. Importing it inside a React effect is not sufficient and may create duplicate listeners or render loops during route changes or development Strict Mode.

The migration should:

1. Move bootstrap into an explicit factory that receives a root element, service client, and persistence adapter.
2. Scope document lookups and CSS to that root, or retain an iframe to isolate them. Existing styles and IDs assume one game document.
3. Introduce complete teardown for window/storage listeners, timers, pending chat/service requests, tutorials, AudioContext, and WebMCP registrations.
4. Call the existing `world.destroy()` on unmount. It stops animation, removes world listeners, disconnects ResizeObserver, disposes geometry/materials/renderer, and removes the canvas.
5. Decide whether the game or host owns progress. Preserve `sanitizeState` and `applyWorldAction` rules and route mutations through one owner.
6. Mount only in the browser. Browser globals, WebGL, and localStorage are unavailable during server rendering.

No reusable component package, route cleanup wrapper, or shared authentication integration is included yet.

### B3. Reuse the server adapters

`createAppServer` returns a complete Node HTTP server, not Express middleware or a Next route handler. Either keep it as a separate local service or port the route boundary to the host and reuse the underlying adapters.

The following illustrates **adapter initialization**, not a complete public API server:

```js
import { loadConfig } from "./codi/scripts/config.mjs";
import { createServices } from "./codi/scripts/services.mjs";
import { createGemini } from "./codi/scripts/gemini.mjs";

// Use explicit absolute paths in your host environment.
const config = await loadConfig("/absolute/private/codi.env");
export const services = createServices(config, {
  ledgerFile: "/absolute/private/codi-data/nessie-events.json",
});
export const codi = createGemini(config);
```

Create one adapter instance per process, not one per request. `createServices` owns a cached journal and serialization lock. `createGemini` owns request/concurrency limits. For Next.js use the Node runtime, not Edge, and account for development reloads. The current journal supports one local server process; multiple workers or serverless instances need shared transactional persistence first.

Keep `dist/game.js` with the server code: `scripts/gemini.mjs` imports `sanitizeState` and `worldObjective` from it. If you move that shared module, update both frontend and backend imports.

A host route must retain input validation, JSON/body limits, safe errors, cancellation, and a suitable access policy. The `X-Cove-Client` header is a contract marker, not authentication. A public host needs authenticated per-player scope and authorization before exposing the shared sandbox account or Notion board.

### Reverse proxy caveat

The existing server binds `127.0.0.1`. It accepts only `localhost:<actual port>` and `127.0.0.1:<actual port>` as Host. API requests with an Origin must match `http://<Host>` exactly, and cross-site requests are rejected. A naive proxy from a different host or port can fail both checks.

Do not solve this by accepting every origin or stripping protections indiscriminately. For the local hackathon use the original game origin, or deliberately integrate the adapters into the host’s server boundary. A later proxy deployment needs a narrowly configured trusted-host/origin policy, authorization, and deployment-specific testing. That change is not already implemented.

## Module map

| Module | Responsibility / interface |
| --- | --- |
| `dist/app.js` | Page bootstrap, HUD, dialogs, input orchestration, saving; no exports |
| `dist/game.js` | Pure state rules, `freshState`, `sanitizeState`, `applyWorldAction`, `worldObjective`, quest/economy helpers; some functions mutate passed state |
| `dist/world.js` | `createWorld(...)`; world movement/rendering, objectives, proximity, `destroy()` |
| `dist/services.js` | `createServiceClient({changed})`; `refresh`, `sync`, `recordDeposit`, `snapshot`, `askCodi`, `bank`, `assignments`, `complete` |
| `dist/codi.js` | `createCodiChat(...)`; session chat, stop/reset, retry and response ownership |
| `dist/tutorials.js` | `createAppTutorials(...)`; `open`, `shouldIntroduce`, `completed`; practice screens and guarded service reads |
| `scripts/config.mjs` | `loadConfig(file, env)`; environment overrides file values |
| `scripts/services.mjs` | `createServices(config, options)`; Nessie/Notion adapters and event journal |
| `scripts/gemini.mjs` | `createGemini(config, options)`; prompt, sanitization, provider request and limits |
| `scripts/server.mjs` | `createAppServer({services,codi,root})`; local HTTP and static boundary |

Full stack: Three.js **0.180.0**, vanilla JavaScript ES modules, HTML/custom CSS, Node.js **20+**, native fetch, localStorage, Web Audio, npm, Node’s test runner. The backend uses Gemini REST, Nessie HTTPS REST, and Notion REST version **2025-09-03**. There is no framework, database server, multiplayer system, or build bundler. See [TECH_STACK.md](./TECH_STACK.md).

## API contract

All successful responses use HTTP 200 JSON. Errors use a non-200 status and `{ "error": "safe message", "code": "machine_code" }`. POST requests require `Content-Type: application/json` and `X-Cove-Client: game`. Chat bodies are capped at 64 KiB; other JSON bodies at 4 KiB.

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /api/services` | None | `{nessie:{configured}, notion:{configured}, gemini:{configured,model}}` |
| `POST /api/codi/chat` | `{message, history?, progress?, trackedQuest?}` | `{reply, model, provider:"gemini", truncated}` |
| `GET /api/nessie/account` | None | `{nickname, balance, deposits:[{id,amount,status,date}]}` |
| `POST /api/nessie/deposits` | `{id:UUID, amount:integer}` | `{status:"confirmed", depositId}` |
| `GET /api/notion/assignments` | None | `{assignments:[{id,title,quest,notes,done,canComplete}]}` |
| `POST /api/notion/complete` | `{id:NotionPageId}` | `{assignment:{id,title,quest,notes,done:true,canComplete}}` |

`configured` reports credential presence, not a successful live provider check. `available` and outbox counts belong to the browser client snapshot, not `/api/services`.

Chat messages are at most 2,000 characters. Optional history uses alternating `{role:"user"|"model", text}` messages, beginning with user and ending with model. The server accepts at most 12 messages, 4,000 characters each and 16,000 total. The current client sends at most four successful pairs and 12,000 characters. `trackedQuest` is `bank`, `classroom`, `garden`, or null. The backend sanitizes progress and derives game context itself. Profile names, bank records, and Notion rows are not automatically sent to Gemini. Codi returns text advice and has no action tools.

Nessie accepts integer amounts 1–100000 and binds event UUIDs to the original account and amount. Use `recordDeposit` for genuine new game savings; do not manufacture an event from a balance total or retry an uncertain write with a fresh UUID. The journal persists pending events before an upstream write and reconciles ambiguous outcomes. Provider balance and local savings can differ.

Notion `quest` is one of the three quest IDs or null. The browser gates linked completion on a local badge. The server checks page membership and schema, but the badge is not a trusted authorization boundary. Completion changes only the configured Done checkbox. The practice tutorial does not call either external write route.

## Configuration and resource setup

| Server variable | Purpose / default |
| --- | --- |
| `GEMINI_API_KEY` | Google API credential |
| `GEMINI_MODEL` | Default `gemini-3.8-flash`; verify a replacement model’s supported parameters |
| `NESSIE_API_KEY` | Nessie sandbox credential |
| `NESSIE_ACCOUNT_ID` | Dedicated synthetic Savings account; UUID or legacy 24-hex ID |
| `NOTION_TOKEN` | Internal connection token with read/update content access |
| `NOTION_DATA_SOURCE_ID` | Classroom data source shared with that connection |
| `NOTION_DATABASE_ID` | Alternative discovery path when the database has exactly one source |
| `NOTION_DONE_PROPERTY` | Checkbox name, default `Done` |
| `NOTION_QUEST_PROPERTY` | Select name, default `Quest` |
| `NOTION_NOTES_PROPERTY` | Rich-text name, default `Instructions` |
| `PORT` | Shell environment only; default 4173 |

Keep credentials on the server. Do not use public frontend environment prefixes, embed credentials in iframe URLs, or copy `.env` into a public directory. Default config, static root, and journal paths depend on the process working directory; use explicit paths when moving them into a host.

The Notion classroom needs a title property, optional Quest select (`bank`, `classroom`, `garden`), Instructions text, and Done checkbox. This is a shared single-explorer demo board. It has no per-student submissions. Follow [SERVICE_SETUP.md](./SERVICE_SETUP.md) for exact setup and provider references.

## Save and data migration

| Location | Data | Handoff rule |
| --- | --- | --- |
| `codis-cove-save-v1` in localStorage | Versioned adventure progress, profile display name and preferences | Preserve and validate with `sanitizeState` if deliberately migrating |
| `codis-cove-nessie-outbox-v1` in localStorage | Deposit UUIDs, amounts and confirmation flags | Preserve IDs and original events; do not regenerate |
| `codis-cove-app-lessons-v1` in localStorage | Tutorial seen/completed flags | Optional to retain for the same explorer |
| `.data/nessie-events.json` on the server | Pending/confirmed/rejected events bound to account and amount | Keep privately with the same account when continuing that runtime |
| Memory | Chat, avatar/camera, tracked quest, tutorial practice choices, reset undo | Expected to reset on reload/navigation |

Copying project files does not copy a browser save. Scheme, hostname, and port define the storage origin. Paths on one origin share the same keys, so multiple copies can collide. There is no built-in export/import UI. A host migration needs an explicit, validated export/import and a backup of the originals.

For continuity, stop the old server, back up its journal privately, preserve the account and browser outbox, and run one new service process against the same journal. Do not run two processes against that file or change accounts while unresolved events remain. The journal is not a disposable cache. Malformed browser outbox data deliberately pauses sync instead of being erased.

For a completely separate demo, use a new sandbox account with a separate browser profile/origin and journal. Game reset does not erase provider transactions, the outbox, the journal, or tutorial flags. Earlier savings totals are not automatically backfilled to Nessie.

## What to include in the handoff

Include `dist/`, `scripts/`, `tests/`, package files, `.env.example`, docs and the Three.js license. Keep `.env`, `.data/`, `node_modules/`, and diagnostic scratch files out of a shareable source archive. Transfer any needed runtime continuity data privately and deliberately. The accompanying source ZIP excludes those private files.

The optional `.openai/hosting.json` declares only static output. It has not deployed the app and does not configure an integration backend.

## Verify after integration

1. Run `npm run build` and `npm test` from the game directory. The current baseline has 40 passing automated tests; these do not prove live provider access.
2. Load the actual integrated page. Check movement, jump, orbit, E interaction, dialogs, touch layout, and frame focus or route unmount/remount.
3. Read `/api/services` from the game’s actual origin, then read the ledger. Verify host, origin, and route-prefix handling.
4. Ask Codi one short question and confirm a Gemini answer. `npm run check:gemini` also performs one live generation and uses provider quota.
5. Replay both app tutorials and verify no game balance change or external write occurs.
6. If testing a new Nessie deposit intentionally, verify its UUID reconciles to one provider record after refresh/retry. Preserve existing pending events.
7. Configure a dedicated Notion board before calling it live. Complete one intended test row and verify only its Done field changes.
8. Reload and confirm the expected save persists. Ensure neither credentials nor the private event journal are publicly served or packaged.

For the hackathon keep one explorer and one local server. Hosting, shared identity, per-player records, and learning-outcome evaluation are separate next steps. See [PROJECT_EXPLANATION.md](./PROJECT_EXPLANATION.md) for the pitch and honest demo status.
