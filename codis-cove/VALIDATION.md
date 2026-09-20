# Game and service integration validation

Validated locally on September 19, 2026. The opening experience is now a perspective third-person game, replacing the earlier island overview.

## Completed checks

- Build and JavaScript syntax checks pass; the local URL responds with HTTP 200.
- **40 Node test groups pass** after the service additions. The original game tests cover money conservation, invalid deposits, reward idempotence, wrong/ordered station actions, garden tool prerequisites, harvesting/sharing, one-time collectibles, persisted progress, old-save compatibility, malformed planner recovery, and invalid-action atomicity.
- Completed all three quests in the browser by walking the character and pressing E at their world objects. No lesson dialog was opened in this play-through.
- Pressing E from the dock did not launch a remote activity or alter money.
- Deposited 20 coins twice at the bank, chose the helmet, and earned the first badge.
- Walked through snack → homework → pack → play and earned the second badge.
- Planted, picked up the can, watered, harvested, and walked the basket to Bea to earn the third badge.
- Standard journey reached the expected **140 pocket coins, 40 savings, 150 XP, three badges**. Reload preserved progression.
- Dragging changed camera yaw. Forward movement then followed the new camera direction.
- Space made the character airborne; the character landed back on terrain.
- A raised trail platform blocked walking into its side. Jumping onto it succeeded, landed at the raised height, and collected its one-time +5 coin. Returning after reload did not duplicate the reward.
- Fixed a close-tree camera case that put the view inside the avatar. The camera now finds a clear side view; retested beside the same platform/tree in portrait layout with the full character visible.
- Inspected 1440 × 960 desktop, 390 × 844 portrait, and 844 × 390 landscape layouts. No horizontal overflow in the checked desktop/portrait viewports. Landscape movement and jump buttons remain available.
- Browser console checked without application runtime errors during the play-through.
- The tracked marker, progress readout, native menus, journal, and backpack use the shared game state. Destination tracking does not itself move the character or award a reward.

## Service checks

- Checked unconfigured Nessie and Notion screens in the main local game; neither reports a live connection or substitutes mock records.
- Provider tests use injected responses with no real credentials. They cover credentials missing, safe response fields, account verification, concurrent duplicate deposits, restart persistence, lost response reconciliation, ambiguous writes, account/amount conflicts, rate-limit rejections, current acknowledgement-only creation, and malformed journal recovery.
- Notion tests cover token/version headers, assignment normalization and pagination, cursor-loop detection, data-source discovery ambiguity, parent checks, archived pages, schema validation, and idempotent Done updates.
- HTTP tests check exact local Host and Origin, required mutation header, body size, static-file secret boundaries, and missing-config responses.
- Browser outbox tests cover events arriving during an active sync, preservation of malformed history, and merging another tab’s records without downgrading confirmed events.
- Used a separate local **QA fixture server on port 4174** to test connected screens without contacting either provider. Loaded Notion fixture assignments, observed locked quest-linked completion, marked an unlinked fixture task done, and verified HTML-like assignment text remained plain text.
- In that isolated fixture game, walked to the bank and deposited 20 coins. The outbox synced, and the ledger displayed one +20 deposit and the fixture account balance. Opened both new service boards through their actual in-world E prompts.
- Inspected the savings ledger in the desktop panel and the assignment board at 390 × 844. No horizontal page/dialog overflow in the inspected mobile board; browser console had no application errors.
- Returned the browser to the real local server on port 4173 and preserved the user’s existing progress. Fixture accounts and data are not shipped in the game/source archive.

**Nessie live authenticated verification completed.** The supplied key successfully listed an empty sandbox. Created one fictitious Codi Demo customer and one dedicated Savings account, each with one POST and subsequent GET verification. The live API returns UUIDs; adapter and persisted-journal validation now support UUIDs as well as legacy ObjectIds. Regression coverage verifies a UUID account read, acknowledgement-only deposit reconciliation, restart deduplication, and rejection of malformed account paths before network access.

Opened the real game’s Backpack → Nessie savings ledger and confirmed the account response. Synced the user’s single queued 20-coin event through the actual button: the outbox became up to date and the provider returned one completed +20 deposit. Nessie still reported account balance 0 at verification; the UI displays that provider balance separately from the game’s 40 saved coins rather than inventing a settled balance. The user’s 80 pocket coins and 40 savings were preserved. No additional gameplay savings action or reset was performed. Notion live verification remains outstanding.

## Gemini checks

- Added protocol and controller tests for environment loading, missing-key/no-call behavior, invalid history, exact host/headers/model settings, role order, approved context, no automatic profile/Notion data forwarding, thought filtering, blocked/empty/malformed replies, redacted errors, local request limits, retry without duplicate turns, cancellation/reset stale-response guards, local fallback bounds, large chat bodies, origins, and split Unicode request bytes.
- Missing-key behavior was verified before setup and makes no API call without GEMINI_API_KEY. After the supplied key was configured, `npm run check:gemini` returned a live Codi introduction using `gemini-3.8-flash`.
- Browser QA used an isolated simulated Gemini server on port 4174. Verified a general question and contextual follow-up, labeled Gemini replies, escaped HTML-like output, a quota error, retry without a duplicate user message, explicit built-in fallback, and stop/new-conversation controls.
- The C shortcut and Codi navigation button open the assistant. Inspected the chat at 390 × 844 with no horizontal page/dialog overflow. Unconfigured mode shows Gemini needs setup; player progress remains intact.
- The user supplied a working Gemini key after completing Google setup. Authenticated adapter calls returned HTTP 200 and answered a general question. Initial local-server attempts received temporary upstream errors; subsequent in-game calls returned HTTP 200, and the user confirmed Codi works. No credential or prompt logging was added to the application.

## App tutorial checks

- Completed the banking tutorial through Savings → amount → review → receipt. A different practice amount stays on the amount step with useful guidance. Completion opens the existing live Nessie ledger, showing the same single +20 deposit; no new deposit or game reward was created.
- Completed the Notion-style tutorial through workspace → task row/page → three-item checklist → Done. Progression stays disabled until all checklist items are checked. Reopening a completed task works; undoing an item removes current-session completion and disables progression until restored.
- Final banking tutorial read the actual Nessie account, with its returned 0 balance and completed +20 activity displayed distinctly from tutorial examples. Notion practice clearly remains local and offers the actual classroom board separately; no live Notion write was claimed or performed.
- Inspected the desktop banking and Notion layouts at 1440 × 960 and the Notion table at 390 × 844. Mobile page/dialog measurements showed no horizontal overflow. Existing native dialog scrolling keeps all app controls reachable. Step headings receive focus after navigation; live service updates preserve the current screen and focus.
- Tutorial actions preserved the user’s 95 pocket coins and 40 saved coins. Lesson completion flags are separate from the adventure save and do not award XP or badges.

## Limits

This is a small single-player local prototype for an 18+ hackathon demo, not a multiplayer Roblox implementation. Nessie and Gemini are live-connected in the local checkout; the source archive excludes their credentials. Notion’s live classroom still needs setup; its practice tutorial is local. Player accounts and hosting remain unconnected. Browser saves are editable and not synchronized.

Physical-device multitouch, a broad GPU/browser matrix, formal assistive-technology testing, and a learning study with children have not been completed. Proximity and collision are purpose-built for this island rather than a general rigid-body physics engine. Decorative low objects do not all have collision volumes.

The original dialog lessons remain a fallback for browsers where WebGL initialization fails. The normal play-through uses the embodied world interactions.
