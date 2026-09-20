# Codi’s Cove

A third-person 3D browser adventure with Roblox-inspired movement and world interactions, using the outline’s low-poly, vibrant pastel art direction.

The current hackathon demo is local-only and intended for participants aged 18 and over. It is not a public release.

## Play locally

**http://127.0.0.1:4173**

Clone the repository, install the pinned dependency, and start the local server:

```sh
git clone https://github.com/sahiths2026S/codis-cove.git
cd codis-cove
npm ci
# Create private configuration without replacing an existing .env.
test -f .env || cp .env.example .env
npm run build
npm start
```

Requires Node.js 20+. The server binds only to this computer. WebGL 2 is needed for the 3D world. Runtime assets are bundled, so the island works offline after installation/build. Configured Gemini, Nessie, and Notion services require internet access. Do not open `index.html` directly through `file://`.

The included `dist/` is already usable: with Node available, `npm start` works without reinstalling dependencies. Dependency installation is needed to rebuild vendor assets.

## Where to put API keys

Edit **`.env` in the project root**. Copy [`.env.example`](./.env.example) first as shown above. The game reads this file on the Node server, so keys never need to appear in browser code.

| Service | Put these values in `.env` |
| --- | --- |
| Gemini / Codi | `GEMINI_API_KEY` and the supplied `GEMINI_MODEL` default |
| Nessie / CapitalTwo Bank | `NESSIE_API_KEY` and `NESSIE_ACCOUNT_ID` for a sandbox Savings account |
| Notion Classroom | `NOTION_TOKEN` and `NOTION_DATA_SOURCE_ID` for the classroom shared with that connection |

`NOTION_TOKEN` is the Notion API access token. The classroom needs a title property, a **Done** checkbox, and optionally **Quest** and **Instructions** properties. See [SERVICE_SETUP.md](./SERVICE_SETUP.md) for obtaining each key and configuring the account/database.

Leave unused services blank. Restart `npm start` after editing `.env`, then choose **Settings → Connected services → Refresh connections** in the game. A fresh clone has no live credentials. Gemini and Nessie have been live-tested in the original local demo; Notion's live workspace still needs setup.

**Commit only the blank `.env.example`.** Git ignores `.env`, its private variants, and `.data/`. Do not paste keys into GitHub files, issues, or the README. If you host the game later, set the same names in the backend host's private environment settings. GitHub Actions secrets do not automatically populate your local `.env` or a deployed server.

## The game

The camera follows behind your explorer. Move through the island, sprint, jump, orbit the camera, and approach objects to interact. The journal and map track destinations; they do not teleport you or complete activities remotely.

- **CapitalTwo Bank:** approach the terminal and press E to save 20 coins at a time. Once you have saved 40, walk to the nearby stands and choose a safety helmet before decorative stickers. Earn Smart Saver.
- **Notion Classroom:** visit the physical snack, homework, backpack, and play stations in a helpful order. Their pads change as you finish. Earn Day Designer.
- **World labels:** short blurbs explain what to practice at each destination. Nearby Nessie and Notion signposts identify their account and assignment boards.
- **Kindness Garden:** plant at the bed, pick up the watering can, return to water and harvest, then bring the basket to Bea. The tool and basket appear on your character, and the plants grow in the scene. Earn Community Grower.
- **Coin trail:** jump along three raised stepping stones and collect one-time gold coins, worth 5 coins each.
- **Codi:** a cream-and-mint robot with a Gemini-powered general assistant, contextual game hints, follow-up history, stop/retry, and an explicit built-in fallback. Press C or choose Codi in the game navigation to chat.
- **Connected services:** a walk-up Nessie savings ledger and Notion classroom board, also available from Backpack and Journal. Service status and setup are in Settings.
- **App guides:** press T or choose App guides for two interactive four-step tutorials. Try a familiar banking dashboard, review a practice transfer, and read a receipt before opening the connected Nessie ledger. In the Notion-style workspace, open a task page, complete a packing checklist, and update its table. Codi explains why these actions help beyond the island. The tutorials also introduce themselves on the first bank/classroom interaction and can be replayed from the related board, Journal, or Backpack.
- **Progress:** coins, XP, badges, quest stages, owned watering can, collected trail coins, and preferences save in this browser.

This is a single-player local prototype. In the original demo, Nessie confirmed a queued 20-coin deposit and Codi returned live Gemini responses. Notion’s practice tutorial works locally; the actual shared classroom still needs Notion credentials and a classroom ID. Every fresh clone needs its own service configuration. Player accounts, multiplayer, and hosting are not connected.

## Controls

| Action | Desktop | Touch |
| --- | --- | --- |
| Move | WASD / arrow keys | Direction buttons |
| Sprint | Hold Shift | — |
| Jump | Space | Jump button |
| Look around | Drag the world; Q/R also orbit | Drag the world; camera arrows also orbit |
| Zoom | Mouse wheel | — |
| Interact | E when a nearby prompt appears | Tap the nearby prompt |
| Journal | 1 / Journal | Journal |
| Backpack | 2 / Backpack | Backpack |
| Map | M / Island map | Map button |
| Codi chat | C / talk to Codi nearby | Talk to Codi / Settings → Connected services |
| Banking and Notion tutorials | T / App guides | App guides / related board tutorial button |
| Close menu | Escape / close button | Close button |

Movement is relative to the camera. A normal click no longer orders the character to walk. Menus pause movement. Falling off the island returns you to the dock without a penalty. Settings also includes Return to the dock.

## Local setup and source

```sh
npm run build # Copy the pinned Three.js release and validate authored assets
npm test      # Game-state, service, chat, HTTP and outbox tests
npm run check:gemini # One live test if a Gemini key is configured
npm start     # Local server on port 4173
```

The authored site is in `dist/`; no bundler or transpiler is required. `world.js` owns rendering, movement, jumping, collision, and proximity interactions. `game.js` owns the pure state rules. `app.js` connects them to the HUD, menus, audio, and local save.

See [TECH_STACK.md](./TECH_STACK.md) for the complete architecture and [VALIDATION.md](./VALIDATION.md) for verified behavior and test limits.

## Hackathon handoff and pitch

[INTEGRATION.md](./INTEGRATION.md) covers linking or embedding the separate game, merging it into another frontend/backend, API contracts, configuration, and save/event migration. [PROJECT_EXPLANATION.md](./PROJECT_EXPLANATION.md) includes the what and why, the team’s Prodigy-inspired personal story, a short pitch, a three-minute script, and a timed demo outline. The accompanying editable nine-slide deck includes speaker notes.

## Quick demo

1. Show WASD movement, drag-to-look, sprint, and jump.
2. Follow the bank marker. Deposit twice, then choose the helmet at its stand.
3. Follow the classroom marker through snack → homework → pack → play.
4. Follow the garden marker through planting → can pickup → watering → harvest → sharing with Bea.
5. Open Backpack to show the three earned badges. Reload to demonstrate saved progress.
6. Open App guides. Show the bank review/receipt workflow and its live Nessie record, then use the Notion-style page/checklist/table to explain why a plan is easier to follow when it is written down.

Tutorial balances and tasks are labeled practice examples. They never change game coins, send deposits, complete quests, or mark a real Notion task done. Related live boards remain the place for explicit service actions. The tutorial’s public reference links show the actual Capital One banking app and Notion interface.

Settings → Start a new adventure clears demo progress. A session-level undo remains available through Settings until reload or closing the page. Existing saves from the initial island prototype are preserved and extended with the new world-quest fields.

## Future hosting

The frontend in `dist/` can be deployed statically, but the Nessie/Notion/Gemini integrations also require the Node API layer or an equivalent hosted backend. `.openai/hosting.json` declares this static output only; no site has been registered or published.

The source archive includes the complete local site, bundled vendor assets, setup scripts, tests, and documentation. The local server now includes this API component. See SERVICE_SETUP.md for configuration and the remaining requirements for public hosting. API keys stay out of browser code.
