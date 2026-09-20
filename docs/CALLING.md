# The calling system

This is the part of the repository other projects are being merged around, so it is
documented in more detail than anything else. Read it before you touch audio, and
before you assume a new feature can "just start a call".

There is **no telephony here.** No Twilio, no phone numbers, no PSTN. Every call is
browser-to-browser or browser-to-agent over the internet. Saying otherwise in a demo
would be false.

---

## Four audio paths, and how to tell them apart

They are genuinely different systems. Confusing them is the most common mistake.

| # | Path | Transport | Who talks | Code |
| --- | --- | --- | --- | --- |
| 1 | **Patient ↔ AI agent** | ElevenLabs Agents, WebSocket | Patient speaks, agent answers | `src/voice.ts`, `server/voice.ts` |
| 2 | **Nurse ↔ patient** | LiveKit (self-hosted) WebRTC | Two humans | `src/handoff-media.ts`, `server/handoff.ts` |
| 3 | **Simulation** | Browser `speechSynthesis` | Agent only; patient lines are text | `src/simulation-audio.ts` |
| 4 | **Spoken questions in a written check-in** | Browser `speechSynthesis` | Agent only | `src/speech.ts` |

Paths 3 and 4 cost nothing and need no credentials — they are the fallback when the
venue is too loud, the network is hostile, or there is no API key. Paths 1 and 2 need
real services and real credentials, and both refuse with a reason when they are not
configured.

---

## Path 1 — the patient's call with the AI agent

### The server owns the questionnaire

This is the single most important thing to understand, and the thing an integration
is most likely to break.

The ElevenLabs agent **does not know the questionnaire.** It has two client tools:

- `get_next_step` — called after every participant answer, before speaking. Returns
  the server's next instruction, which the agent reads verbatim.
- `finish_session` — called only after speaking a final instruction. Ends the call.

The agent's prompt forbids it from inventing questions, skipping them, classifying
urgency, or deciding the intake is over. That is not merely a prompt instruction: the
server would reject the attempt anyway, because `store.ingest()` owns
`session.questionIndex`, `session.next` and `session.severity`. The model cannot
advance state it does not hold.

**If you integrate a different agent, a different provider, or a second questionnaire,
it must go through the same two tools.** An agent that holds its own script will
silently diverge from the record the nurse reads, and the nurse is the person making
the decision.

### The call, start to finish

```
patient clicks Start
  → getUserMedia (permission; the stream is KEPT, see "barge-in" below)
  → POST /api/{sessions/:id|outreach/:token}/voice-url
      server checks the agent has recording disabled and signed-URL auth enabled,
      then returns a short-lived wss:// URL. The API key never reaches the browser.
  → Conversation.startSession(...)   [@elevenlabs/client]
  → onConnect      → POST .../connected   (stores the provider's conversation id)
  → onMessage      → POST .../events      (every transcript line, both roles)
  → get_next_step  → GET  .../next        (the server's next instruction)
  → finish_session → agent speaks the last line, then the client stops
  → POST .../end
```

Two clients drive this identically: the nurse studio (`src/App.tsx`) and the
patient's own page (`src/PatientCheckIn.tsx`). They differ only in the `base` path —
`/sessions/:id` versus `/outreach/:token` — which is why `createInAppCall()` takes it
as a parameter. **Keep that symmetry.** A feature added to one path and not the other
is a bug waiting for the demo.

### Barge-in: why the microphone is deliberately muted

ElevenLabs decides interruptions on its own side, from the audio we send it. A chair
scraping, a phone set on a table, a cough — each arrives as "the participant started
talking", and the agent stops mid-question and loses its place. Nothing in the agent
configuration filters a transient that carries no words.

So `src/barge-in.ts` does not send it. While the agent is speaking the microphone is
held closed, and a gate watches the real input level instead:

- opens only after the level has stayed above `threshold` for `attackMs` (180 ms) —
  longer than a knock, shorter than a syllable
- closes again after `releaseMs` (900 ms) of quiet, so gaps between words do not shut it
- **is not used at all while the agent is listening**, so an answer is never clipped

The cost is roughly the attack window at the front of a deliberate interruption. The
alternative, which is what this replaced, is the agent losing its place every time the
patient shifts in their chair.

The gate needs a level reading at exactly the moments the SDK's own meter reports zero
(while muted), so it runs on its own `getUserMedia` stream — the one the permission
prompt already opened, which used to be thrown away. A browser without Web Audio
leaves the microphone open: worse filtering is a smaller failure than a check-in that
will not start.

Tune `BARGE_IN` in `src/barge-in.ts`. The thresholds are on the same RMS scale as the
pre-call microphone check, where `0.015` means "some signal is present".

### The agent's own turn-taking

A second, complementary layer lives in the ElevenLabs agent config
(`scripts/setup-voice.ts`): a short list of non-lexical fillers that are transcribed
but do not take the floor, and an uninterruptible opening consent question.

Every one-word reply the questionnaire actually accepts — yes, no, okay, sí, claro —
is deliberately **off** that list, and ElevenLabs' curated defaults are not merged in,
because an ignore term that swallowed a consent answer would be far worse than an
interruption.

```sh
npm run voice:setup -- --update   # PATCHes the existing agent; no new agent, no .env change
```

Changing the agent config in code does nothing until you run that.

### End of intake

Once the server reports the questionnaire closed (`next.done`), the browser stops
sending participant speech. A "thank you" spoken over the agent's closing line is a
goodbye, not an answer; the server refuses it — correctly, nothing may follow the last
question — and the browser treats that refusal as "already over" rather than a
failure. It used to surface a red alert and abort the call, which on the emergency
path truncated "hang up and call 911".

That utterance is **not** added to the transcript. If an integration needs trailing
speech recorded, that is a deliberate product change, not a bug fix.

### Failure modes

Every one of these has an explicit message. None falls back to a script.

| What happens | What the patient sees |
| --- | --- |
| No API key or agent id | "Add your ElevenLabs API key…" — simulation offered instead |
| Agent has recording on, or auth off | 409 with the reason; no call is started |
| Credits exhausted (402/429) | "ElevenLabs credits or usage limits are unavailable" |
| Connection not up in 25 s | "The call could not connect within 25 seconds" |
| Microphone denied | "Microphone permission was denied… or continue in writing" |
| Browser goes offline | "Internet connection lost. The incomplete call is saved for nurse review." |
| Five-minute limit | Session ends; transcript preserved |
| Lost heartbeat (~35 s) | Server marks the intake incomplete |

---

## Path 2 — the live nurse ↔ patient handoff

Self-hosted LiveKit on a second host, with TURN for networks that block UDP
(conference wifi, reliably). `server/handoff.ts` mints per-participant join tokens;
`src/handoff-media.ts` joins the room.

State machine: `requested → accepted → connecting → active → ended`, plus explicit
`declined`, `timed_out` and `failed`. **`active` requires both parties in `joined`.**
Accepting is not connecting, and the UI must never say two people are talking when
one of them is not there.

A handoff that declines, times out or fails leaves an urgent callback task and reopens
a resolved case. That is the point: the unhappy path is the one that has to be honest.

`livekit-client` does not play remote audio for you — the application must call
`track.attach()` on `TrackSubscribed`. This cost hours once already.

Without `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, the handoff
capability reports itself unavailable and a callback is recorded instead. Nothing
pretends a transfer happened.

## Path 3 — simulation

Browser `speechSynthesis` speaks the agent only; patient responses are scripted text
placeholders. No microphone, no credits, no network. This is the fallback when
everything else is unavailable, and it is why the demo can run on a plane.

## Path 4 — spoken questions in a written check-in

`src/speech.ts`. Someone who chose to type has not chosen to read in silence — they
may be older, tired, or holding a phone at arm's length, and a question misread is a
question answered wrongly. The agent's side is spoken; the typed reply is theirs and
is never read back at them. A new question replaces one still playing.

Toggleable on both the nurse studio and the patient page. Degrades to text where the
browser has no matching voice, warning once rather than per question.

---

## Ringing

`src/ringtone.ts` synthesises a ring with Web Audio (no asset to ship) and is used
for both an incoming check-in and an incoming nurse call. It rings **until the patient
is actually on the call**, not merely until a nurse accepts — see the `waiting`
computation in `src/PatientCheckIn.tsx`.

The patient page polls unconditionally. It used to poll only if a call already
existed, which meant a call rung while the patient sat on the page could never be
discovered.

---

## Configuration

| Variable | Needed for | Without it |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | Path 1 | In-app calls unavailable, with a reason |
| `ELEVENLABS_AGENT_ID` | Path 1 | Same; run `npm run voice:setup` |
| `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL` | Path 1, optional | Matilda on `eleven_multilingual_v2` |
| `ELEVENLABS_TURN_MODEL` | Path 1, optional | Provider default; `turn_v3` is opt-in |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Path 2 | Handoff records a callback task instead |
| `GEMINI_API_KEY` | Adaptive follow-ups, chat, briefing | Scripted intake still works |

Paths 3 and 4 need nothing.

## What is deliberately absent

Do not add these without deciding they are wanted:

- **Telephony.** No Twilio, no phone numbers. A nurse escalation creates a callback
  task; it does not dial.
- **Recording.** The ElevenLabs agent is created with `record_voice: false`, and the
  server refuses to issue a connection URL if that has been turned back on. The local
  transcript is text only.
- **Background/mobile ringing.** Notifications are in the open web app only.
- **More than one active conversation at a time.** `store.activeSession()` enforces a
  single live intake per run. A nurse joining a handoff is not a second intake; do
  not let that lock reject them.
