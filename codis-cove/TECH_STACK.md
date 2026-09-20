# Tech stack and architecture

## Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| 3D engine | Three.js 0.180.0 | WebGL rendering, perspective camera, game geometry, shadows, collision queries |
| Application | JavaScript ES modules | Character controller, interactions, progression, and UI |
| Interface | HTML5 and custom CSS | Compact responsive game HUD, native dialog menus, touch controls |
| Persistence | Browser localStorage | Device-local save, quest stages, inventory, and preferences |
| Audio | Web Audio API | Opt-in synthesized feedback and reward chimes |
| Local server/API | Node.js built-in HTTP/filesystem modules and native fetch | Serve the game, proxy Gemini/Nessie/Notion, and persist deposit events on 127.0.0.1:4173 |
| Nessie | HTTPS REST API | Record new game savings in a configured sandbox account; read balance and recent deposits |
| Notion | REST API, pinned version 2025-09-03 | Query classroom data sources and update assignment Done checkboxes |
| Codi AI | Gemini REST generateContent, default gemini-3.8-flash | General assistance and game-aware conversation via a server-only key |
| Packages | npm and package-lock.json | Pin Three.js and reproduce vendor assets |
| Testing | Node test runner and strict assertions | State/economy, provider adapter, HTTP boundary, and browser outbox regressions |
| Optional agent access | Feature-detected WebMCP | Read progress and track destinations through the same UI state |
| Art | Procedural low-poly 3D models and original Codi PNG | Pastel village, toy-like characters, props, and companion portrait |

No React, UI framework, bundler, analytics, remote font, or external database is needed for local play. The Node backend handles optional service requests; browser assets remain local. Configured Nessie deposits are sent automatically after new savings actions. Notion is fetched and updated when its board is used.

## Source layout

```text
codi-world/
├── dist/
│   ├── index.html              Game shell and HUD markup
│   ├── style.css               Shared menus/forms/base theme
│   ├── game-hud.css            Full-screen third-person HUD
│   ├── world.js                Scene, controller, camera, and world objects
│   ├── game.js                 Pure quest/economy/save rules
│   ├── app.js                  Menus, HUD, state persistence, feedback
│   ├── services.js             Browser savings outbox and same-origin API client
│   ├── codi.js                 Session chat, history, cancellation, and retry state
│   ├── tutorials.js            Banking/Notion practice flows and guarded service reads
│   ├── tutorials.css           Banking dashboard, Notion workspace, responsive coaching UI
│   ├── favicon.svg
│   ├── assets/codi-portrait.png
│   └── vendor/                 Three.js modules and MIT license
├── scripts/build.mjs           Vendor dependency + syntax/asset validation
├── scripts/serve.mjs           Local server entry and configuration
├── scripts/server.mjs          Static routes and validated API boundary
├── scripts/services.mjs        Nessie/Notion adapters and durable deposit ledger
├── scripts/config.mjs          Server-only environment reader
├── scripts/gemini.mjs          Codi prompt, Gemini protocol and bounded request handling
├── scripts/check-gemini.mjs    Optional one-request connection check
├── .env.example                Credential/ID template (no secrets)
├── .data/                      Runtime event journal; ignored and never served
├── tests/game.test.mjs         Base state and economy tests
├── tests/world-actions.test.mjs Embodied quest and save migration tests
├── package.json
├── package-lock.json
└── .openai/hosting.json         Static output declaration; not a deployment
```

`dist/` contains authored, readable source as well as deployable assets. The build copies Three.js vendor modules and checks source syntax/local entry references; it does not regenerate or erase the authored game.

## Third-person controller

The former orthographic overview and click-to-walk behavior have been replaced with a perspective follow camera and direct character control.

- Dragging changes orbit yaw and pitch. Pitch is clamped; wheel zoom has minimum/maximum distances. Q/R provide keyboard camera rotation.
- Movement uses the camera’s current forward/right basis. Diagonal input is normalized.
- Velocity eases into walking/sprinting. Rotation follows movement; limbs and the body animate during walking.
- Space applies a grounded jump impulse. Gravity, platform landing, and terrain-height checks run with a bounded frame delta. Holding Space cannot repeatedly launch the character.
- Building/trunk colliders prevent horizontal penetration. Raised trail platforms have their own tops and sides.
- The camera checks its path against building and tree-canopy bounds, contracts at obstacles, and eases back out. If contraction would put the camera inside the avatar, it finds a clear side view and keeps controls aligned with that view.
- The island and dock are walkable. Falling into the surrounding water returns the explorer to the dock.
- Modal menus, browser blur, and hidden-page changes clear movement input. Pointer capture/release/cancel events clean up camera drag and touch buttons.
- Touch movement and camera drag use separate pointer handling. Jump and interaction have dedicated touch buttons.
- Reduced motion removes ambient/limb/bob animation and camera easing while preserving direct movement and jumping.

The renderer caps device pixel ratio at 1.7, uses flat low-poly geometry/shared materials, and employs a soft directional shadow map. Distance fog, water, clouds, and distant islands establish a horizon at character height.

## World interaction design

Each interactive object has a world position, range, name, and action ID. The nearest object in range supplies the single E prompt. The world controller rechecks proximity before dispatching an interaction; holding E does not repeat it.

Primary quests are played through objects rather than remote modal quizzes:

| Quest | Physical sequence |
| --- | --- |
| Bank | Terminal deposit → second deposit → helmet stand |
| Classroom | Snack station → homework → backpack → play |
| Garden | Plant bed → pick up can → water bed → harvest → share with Bea |

The planner pads, sprouts, carried watering can, carried basket, and trail collectibles reflect saved state. A compact feedback panel keeps the game world visible during quest actions. Journal and map selections set a tracked marker and directional indicator; they do not teleport the character or complete quests.

The earlier dialog lessons are retained only as a fallback if WebGL cannot initialize. They are not the normal in-world journey.

## State and reward rules

`applyWorldAction(state, action)` in `game.js` validates quest order and prerequisites. It returns a message, whether state changed, and an optional earned badge ID. `worldObjective(state, trackedQuest)` derives the next instruction and object marker from the same saved state. `app.js` persists state and renders feedback/HUD after valid changes.

New explorers begin with 120 pocket coins. Depositing coins conserves the pocket-plus-savings total. Each quest awards 20 pocket coins and 50 XP once. Repeated actions cannot issue duplicate rewards. The standard journey with 40 saved ends at 140 pocket coins, 40 savings, 150 XP, and three badges. Each optional trail coin adds 5 pocket coins, once per coin ID.

The browser is the authority for this local prototype. The save is editable by the device owner; this is not a trusted multiplayer economy or anti-cheat system.

## Save schema and compatibility

Storage key: `codis-cove-save-v1`.

Saved fields include name, coins, savings, XP, completed quests, initial saving step, garden stage, planner order, physical planner stage, watering-can ownership, collected trail IDs, audio preference, and reduced-motion preference.

The new fields have defaults so the earlier local prototype’s saves continue to work. Completed classroom saves normalize to a finished planner; malformed incomplete planner stages clamp to a recoverable step. Unknown collectible IDs and duplicate IDs are discarded.

Camera position, avatar position, chat transcript, active menu, currently tracked quest, and reset undo backup are session-only. A new load starts at the dock with progress preserved. Different browsers, ports, devices, and hosted origins have separate storage. Player saves are not synchronized or migrated to hosted accounts. Service records and the deposit outbox use separate persistence described below.

## Accessibility and input

Native buttons, labeled inputs, visible focus styles, live feedback regions, native dialog semantics, and keyboard shortcuts are used. The tracker can collapse to reveal more world space. Sound is off by default. Both the operating system’s reduced-motion setting and an in-game preference are respected.

The first-person camera is not used: the character remains the focus of the third-person view. Close obstacles can shorten the camera distance. Touch and desktop layouts are distinct. Formal assistive-technology and physical-device testing are still needed before public release.

## Services and privacy

Gemini, Nessie, and Notion adapters are implemented and require user-owned credentials to connect. Sign-in, multiplayer, and hosting remain unconnected. Nessie uses pretend sandbox money. Codi uses Gemini when configured and explicitly labeled built-in guidance otherwise. Profile names stay local; chat messages, recent successful chat history, and approved game progress are sent to Google in Gemini mode. External assignment content and provider errors are escaped before rendering. The Notion adapter transmits only the configured assignment completion update, not player names.

Credentials are loaded from the process environment or a project-root .env file. Only dist/ is served. API routes validate exact local Host and Origin, reject cross-site requests, require JSON and a game header for mutations, and cap bodies at 4 KiB for banking/assignment actions or 64 KiB for chat. Request bodies are buffered before UTF-8 decoding. Fixed HTTPS upstreams refuse redirects; errors never echo provider URLs or tokens. This remains a single-user loopback server, not a public authentication boundary.

Nessie uses https://prod-api.nessieisreal.com. Account validation accepts both the current API’s UUIDs and legacy 24-character hexadecimal IDs, including when loading persisted events after restart. Each queued event has a UUID and integer amount. The server serializes deposits, atomically persists a pending journal entry before POST, binds the event to its account, and reconciles unique descriptions after ambiguous failures. No blind write retry occurs. Both current acknowledgement-only and legacy objectCreated responses are handled. The browser merges saved outbox events and preserves malformed storage rather than discarding it.

Notion uses https://api.notion.com/v1 with version 2025-09-03. Queries follow bounded pagination with repeated-cursor detection. Completion retrieves the page, verifies its current data-source parent and non-archived state, and patches only the configured Done checkbox. Linked-quest gating is a local gameplay rule, not tamper-proof authorization.

See [SERVICE_SETUP.md](./SERVICE_SETUP.md) for resource schemas, data flow, limitations, and credential setup. Static-only hosting no longer includes the service layer; public deployment requires a hosted backend, authentication, rate limits, per-player scope, and shared durable storage.

## Codi conversation architecture

The browser’s `createCodiChat` controller owns in-memory messages, successful Gemini history, pending/error state, and an AbortController. Requests are serialized within a conversation. Stop/reset invalidate old generations, so delayed responses cannot repopulate a new chat. A failed retry reuses the question without duplicating it. Local greetings, fallback replies, and failed turns do not enter Gemini history.

The server constructs its own system instruction and sanitizes the game snapshot. Arbitrary client system messages, profile names, and unknown snapshot fields are not forwarded. Codi answers general questions as well as game questions; it has no tools or write authority over progression or external services.

The default Gemini 3.8 Flash request uses LOW thinking, a 2,048-token total output cap, and no temperature/topP/topK settings. Keys use the x-goog-api-key header on a fixed HTTPS host with redirects disabled. The adapter filters thought parts, blocks unsafe/no-answer responses, identifies truncated output, redacts upstream errors, and bounds input/history, time, concurrency, and request frequency. Stopping a browser request also aborts the server’s upstream request when its response connection closes.

There is no streamed token UI or persistent model session. Each request sends bounded recent successful history. The app does not log/store transcripts; provider-side processing is governed by Google’s account settings and terms. Codi’s displayed text is escaped. Credential presence is labeled configured/ready; connected status requires an actual answer in that session.

## Guided app tutorials

`createAppTutorials` renders two four-step practice flows inside the existing native dialog. Codi’s authored lesson copy surrounds interactive recreations of common banking and Notion interface patterns; these screens are identified as recreations and link to official product references. The wide layout places the coach beside the app; narrow screens stack them and adapt the Notion sidebar into a compact page selector.

The banking example covers account selection, choosing 20 pretend coins, reviewing the destination/amount, and inspecting activity. The classroom example covers the workspace, a database row page, a three-item checklist, and the final Done checkbox. Practice state stays in memory. Only seen/completed flags persist under `codis-cove-app-lessons-v1`, separate from the game save; storage failure falls back to session-only behavior. Back/reopening a task clears the current run’s completion while preserving historical completion for replay labels.

The first bank/ledger or classroom/station interaction can introduce its tutorial before any game mutation. Closing it leaves the next explicit world interaction to perform the normal action. Tutorials never call the game deposit/quest functions or external write APIs. Their final step uses existing read-only service methods, labels actual connected data only after a successful response, escapes provider values, and guards response ownership by tutorial session and active screen. An asynchronous service result updates only its live-data panel, preserving the learner’s focus and choices.

## WebMCP

In a supported browser, `document.modelContext` exposes:

- `read_cove_progress({})`: read visible local progress, objective, and player position.
- `track_cove_adventure({place})`: validate bank/classroom/garden and track the selected destination. It does not teleport or award rewards.

Tools share the visible interface’s state and are unregistered on page hide. Unsupported browsers can play normally without these APIs.

## Asset provenance

Three.js is MIT-licensed; its license ships in `dist/vendor/THREE-LICENSE.txt`. The game world, characters, props, and favicon were authored for this project. Codi’s portrait is original generated artwork, bundled locally. System fonts provide the typography, with Trebuchet/Arial fallback.
