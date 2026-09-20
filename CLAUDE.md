# Callsign

An AI agent has to prove who it is before a physician's phone rings. VTHacks 14, Sept 18–20 2026.

The wow moment: the judge scans a QR code and their own phone becomes Dr. Patel's phone (a browser page paired over Wi-Fi); an impostor agent tries to reach her and that phone stays silent; the verified brand agent tries and it rings in the judge's hand, they talk to it, ask for samples, and a signed agent-to-agent agreement lands on the console mid-call.

## Layout

- `shared/src/index.ts` — every type both sides speak. Change it only with a note in your report; fix both sides in the same commit.
- `server/` — Express + WebSocket. `src/agent.ts` is the doctor's agent (verify → call | inbox | quarantine). Modules under `verify/`, `call/`, `negotiate/`, `label/`, `agents/`, `seed/`.
- `web/` — Vite + React. `src/useCallsign.ts` owns live state; components build on it.
- `docs/` — setup guides, pitch, Devpost text.

Every module ships a **mock** that works with no keys. `ANS_MODE`, `CALLS_MODE`, `LLM_MODE` in `.env` switch each to real. The demo must always run with everything on mock.

## Commands

Node is installed at `C:\Program Files\nodejs` but not on this session's PATH. In Bash: `export PATH="/c/Program Files/nodejs:$PATH"`.

```bash
npm install                # once
npm run dev                # server :8787 + vite :5173 (proxies /api, /ws to 8787)
npm run typecheck          # must pass before you report done
npm run impostor           # fire an impostor request at the running server
npm run scenarios          # run the whole attack catalog (docs/test-matrix.md) and assert every verdict; -- --no-call skips the ring
PORT=8791 npm run start -w server   # your own server instance on another port
```

A stable mock server may already be running on 8787 for the screen work. Do not kill it. Test server changes on your own port.

## Rules

- Own your files. Do not edit files outside your lane; say what you need in your report.
- Never throw out of a verification step, a tool handler, or a webhook. Fail closed with a reason.
- The phone is a paired browser; no phone numbers are collected. The Twilio/ElevenLabs carriers mask any number they handle.
- The voice agent never gives clinical advice; it reads the label (`server/src/label/stelazio.ts`) and cites the section.
- Real keys never go in git. `.env` is ignored; `server/keys/*.pem` is ignored.
- Typecheck clean, mock flow still runs end to end, then report.
