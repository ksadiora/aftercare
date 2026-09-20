# Connect Gemini, Nessie, and Notion

The integration code is installed. Live connections need your own credentials and resource IDs. The game reports **Setup needed** until configured; mocked tests are not a live connection.

Original local demo setup (September 19, 2026): Nessie is connected to a dedicated synthetic demo Savings account, and a queued 20-coin deposit has been confirmed by the provider. Gemini is connected with the supplied key and has returned live responses using `gemini-3.8-flash`. Notion remains unconfigured. Credentials are saved only in the private local `.env`, with file permissions 0600, and are excluded from Git and the source archive.

## 1. Add server credentials

For a fresh GitHub clone or source archive, from the project root, copy `.env.example` to `.env`. If `.env` already exists, edit its relevant values without replacing the other configured services. Fill in the values below locally, then restart `npm start`. Existing shell environment variables take precedence over `.env`.

```dotenv
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-3.8-flash
NESSIE_API_KEY=your_nessie_key
NESSIE_ACCOUNT_ID=your_sandbox_account_id
NOTION_TOKEN=your_notion_connection_token
NOTION_DATA_SOURCE_ID=your_classroom_data_source_id
```

Each service can be used independently. Keep unused values blank. The `.env` file is excluded from Git and source archives and is outside the public `dist/` directory. Do not put secrets in browser JavaScript or share them in chat.

Open [the local game](http://127.0.0.1:4173/) → Settings → **Connected services** → **Refresh connections**. “Configured” means values exist; open the ledger or classroom board to verify actual account access.

## Connect Codi to Gemini

1. Create an API key through [Google’s Gemini API key setup](https://ai.google.dev/gemini-api/docs/api-key).
2. Add it to the project-root `.env` as `GEMINI_API_KEY`. The original local demo has a private `.env` with Gemini and Nessie configured; preserve any existing values. Fresh GitHub clones and source archives need their own credentials in a copy of `.env.example`.
3. Keep `GEMINI_MODEL=gemini-3.8-flash`, or select a supported model available to your project. The default is listed in [Google’s model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
4. Restart `npm start`. Run `npm run check:gemini` to make one short test request; without a key this command makes no remote call.
5. Reload the game and press **C**, talk to Codi near the starting path, or use Settings → Connected services → **Chat with Codi**. A successful answer is labeled **Codi · Gemini**, and the status reads **Gemini connected**.

The current demo audience is adults aged 18 and over. Before changing that audience or shipping publicly, revisit provider suitability: [Google’s Gemini API terms](https://ai.google.dev/gemini-api/terms) prohibit use in apps directed toward or likely accessed by under-18s. The original child-oriented concept is not the current demo audience.

Codi can answer general questions, explain concepts, brainstorm, help with code, and offer game hints. It receives the current message, up to four recent successful conversation pairs (bounded to 12,000 characters), and an approved game snapshot: coins, savings, XP, completed quests, planner/garden stage, watering-can ownership, trail count, and current objective. Explorer profile names, Notion assignment content, and Nessie account details are not automatically included. Information you type into a message is included in that message.

The game keeps conversation history in memory only. It does not save or log chats to localStorage or disk. Google’s processing/retention follows your provider account settings and terms; clearing the game’s conversation does not delete provider-side records.

Enter sends a question; Shift+Enter adds a new line. **Stop** cancels a pending request. **New conversation** clears this session’s conversation and cancels an in-progress reply. Failed requests offer an explicit retry or a labeled built-in island hint. Missing credentials use the built-in guide and clearly show **Gemini needs setup**. There is no silent substitution of a canned response for a Gemini answer.

Codi supplies text advice. It has no tool access, live web search, authority to change game state, or ability to operate Nessie/Notion. The game uses a concise, age-appropriate companion instruction; provider safety blocks and empty replies become clear error states. Thought parts are not displayed.

The server calls `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` using the server-only `x-goog-api-key` header. Chat requests are limited to 2,000 characters, the HTTP body to 64 KiB, and local traffic to 12 requests per minute with at most two concurrent requests. Output is capped at 2,048 tokens including reasoning. The default 3.8 model uses LOW thinking and omits unsupported sampling parameters, following [Google’s migration guide](https://ai.google.dev/gemini-api/docs/latest-model) and [REST reference](https://ai.google.dev/api/generate-content).

If you override the model to `gemini-2.5-flash` or `gemini-2.5-flash-lite`, the adapter switches to a zero thinking budget. Other model overrides should be checked against that model’s supported settings. Errors never expose the API key or raw provider error body.

**Gemini troubleshooting:** 401/403 means the key or project access needs checking; 404 means the configured model is unavailable; 429 means the local limit or provider quota has been reached. Codi does not automatically retry billable generation requests. The setup check performs one generation request and can consume your provider quota.

## 2. Nessie sandbox savings

1. Open [Nessie Getting Started](https://nessieisreal.com/getting-started), sign in through GitHub, and copy **Your API Key** from [My Profile](https://nessieisreal.com/profile).
2. Use [Nessie’s interactive documentation](https://nessieisreal.com/docs) to find or create a sandbox customer and Savings account.
3. Put the account’s `_id` in `NESSIE_ACCOUNT_ID`. The adapter supports the live API’s UUIDs and legacy 24-character hexadecimal IDs. Use a dedicated demo account so other experiments do not clutter this game’s ledger.

If you need a new account, the documented sequence is:

| Step | Endpoint |
| --- | --- |
| Create a fictitious customer | `POST /customers?key=KEY` |
| Retrieve the customer ID | `GET /customers?key=KEY` |
| Create their savings account | `POST /customers/{customerId}/accounts?key=KEY` |
| Retrieve the account ID | `GET /customers/{customerId}/accounts?key=KEY` |

Example customer body (fictitious demo details):

```json
{
  "first_name": "Codi",
  "last_name": "Explorer",
  "address": {
    "street_number": "1",
    "street_name": "Cove Lane",
    "city": "Blacksburg",
    "state": "VA",
    "zip": "24060"
  }
}
```

Example account body:

```json
{ "type": "Savings", "nickname": "Codi's Cove Savings", "rewards": 0, "balance": 0 }
```

The server uses the current documented HTTPS base, `https://prod-api.nessieisreal.com`. Nessie is a sandbox, and the game uses pretend money. No real bank account is connected.

### In the game

- Save at the bank terminal. Each **new** savings action adds a local event and automatically attempts to record it in Nessie when configured.
- Walk to the gold ledger stand beside the bank, or open Backpack → **Nessie savings ledger**.
- Check the remote sandbox balance and recent Cove deposits. **Sync pending savings** retries queued events safely.
- Deposits use the current API’s `medium: balance`, `status: completed`, integer amount, date, and unique description. The UI reads the provider’s actual balance and transaction status; it does not assume a returned acknowledgement means the balance is settled.
- Savings from before this integration was added are not imported. Rewards and fallback withdrawals are local game events, not Nessie transactions. The remote ledger tracks deposits, so its balance can differ from the current adventure’s saved coins.

A fresh adventure does not delete past external deposits or the sync outbox. Each event stays bound to its original account. Restore that account to finish pending events before changing the demo setup.

If a deposit response is lost, the server searches for its unique description. If it cannot confirm the result, it leaves the event pending instead of sending a possible duplicate. Refresh later. If an event remains uncertain, inspect the sandbox transaction history and local `.data/nessie-events.json` before repairing it; do not clear the journal to force retries.

Current contract: [Nessie OpenAPI](https://nessieisreal.com/nessie-openapi-spec.yaml). The adapter handles both the current string acknowledgement and the older `objectCreated` response.

### Learn the interface

App guides → Meet your banking app uses a clearly labeled interactive banking recreation. Practice transfers change only that tutorial’s temporary example. The final step reads the configured Nessie account and offers Open my Nessie account to enter the actual service ledger. Replaying it never sends a deposit. Its public reference shows [Capital One’s actual mobile app](https://www.capitalone.com/digital/tools/mobile/).

App guides → Make a plan in Notion teaches a workspace sidebar, a task table with due dates, row pages, checklists, and Done. Sample tasks stay inside the lesson. Only the existing connected board’s explicit Mark done in Notion button changes real assignments. When configured, the final tutorial step can read the classroom and link into that board. The interface and learning steps reference [Notion databases](https://www.notion.com/help/intro-to-databases), [database properties](https://www.notion.com/help/database-properties), and [checklists](https://www.notion.com/use-case/checklist).

## 3. Notion classroom

1. Create a dedicated **internal connection** in the Notion Developer portal and copy its installation access token into `NOTION_TOKEN`.
2. Enable **Read content** and **Update content**. Insert content and user/email access are not needed for this implementation.
3. Create a small classroom database with the columns below. Share that database with the connection using its content-access settings or the database’s Connections menu.
4. In the database’s **Manage data sources** menu, use **Copy data source ID** and paste it into `NOTION_DATA_SOURCE_ID`.

[Notion’s internal connection guide](https://developers.notion.com/guides/get-started/internal-connections) explains tokens and page access. The [data source upgrade guide](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03) explains where to copy the data source ID.

| Column | Notion property type | Purpose |
| --- | --- | --- |
| Name | Title | Assignment name; the title column can have any name |
| Quest | Select | Optional: `bank`, `classroom`, or `garden` links work to an island adventure |
| Instructions | Text | Instructions shown on the board; plain text only |
| Done | Checkbox | Completion written back by the player |

Example rows:

| Name | Quest | Instructions | Done |
| --- | --- | --- | --- |
| Save for something useful | bank | Save 40 coins, then choose the safety helmet. | unchecked |
| Make room for your afternoon | classroom | Visit snack, homework, backpack, then play. | unchecked |
| Grow a little kindness | garden | Plant, water, harvest, then share with Bea. | unchecked |
| Tell someone what you learned | (blank) | Explain one new skill to a friend. | unchecked |

Property names can be changed through `NOTION_DONE_PROPERTY`, `NOTION_QUEST_PROPERTY`, and `NOTION_NOTES_PROPERTY` in `.env`. The Done property must remain a checkbox. Leave Quest blank for a manually completed classroom task.

You may use `NOTION_DATABASE_ID` instead of a data source ID when the database has exactly one data source. Multiple sources require an explicit selection. The server pins API version **2025-09-03**, using `/v1/data_sources/{id}/query` and `/v1/pages/{id}`.

### In the game

Walk to the paper noticeboard to the right of the classroom stations and press E, or open Journal → **Notion classroom board**. Refresh to load teacher changes. Assignment text comes from Notion; no example assignments are substituted when disconnected.

For linked assignments, earn the corresponding skill badge, then choose **Mark done in Notion**. Unlinked tasks have a manual completion button. A successful response updates the board to **Done in Notion**. No additional coins or badges are awarded through Notion. Completion updates only the configured Done checkbox after the server verifies the page belongs to the selected classroom. Repeating completion is idempotent. See [Notion’s page update reference](https://developers.notion.com/reference/patch-page).

This is a **single-explorer demo database**. Done is shared in Notion, not tracked separately per student. Use a separate database per demo explorer. A classroom with many students needs authenticated identities and per-student submission records before deployment.

## Verification and troubleshooting

- **Setup needed:** one or more required values are blank. Restart the server after editing `.env`, then refresh connections.
- **401/403:** check the credential and the connection’s permissions.
- **Notion 404:** check both the ID and whether the database is shared with the connection. A normal page ID is not a database/data source ID.
- **Done button disabled:** finish its island quest, or add the configured checkbox property.
- **429:** allow the provider to recover, then refresh. No tight automatic retry loop runs.
- **Local service server unavailable:** use `npm start` from the project folder; a static-file-only server does not run integrations.
- **Local sync history unreadable:** preserve the original browser value for diagnosis. The app pauses savings sync instead of erasing malformed records.

Use one game tab during the demo. Outbox storage merges records from other tabs and the server deduplicates event IDs, but this is not a multi-user transaction system.

## Hosting later

All three integrations require the Node API layer or an equivalent deployed backend. Uploading only `dist/` preserves the local game but does **not** deploy services. The existing `.openai/hosting.json` still describes only the static frontend and has not published anything. Before public hosting, add backend secrets, durable shared event storage, authentication, authorization, per-player data, and rate limiting; keep the Node local server on loopback for now.
