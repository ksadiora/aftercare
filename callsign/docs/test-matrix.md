# Test matrix: five checks, eighteen ways to hit them

Every request to Dr. Patel's agent passes five checks in order and stops at the first one that fails. This is the catalogue of ways to make each check fail (and the one way to pass), with the exact bytes each scenario puts on the wire and every way to fire it. Judges: pick any row, fire it any way you like, and read the trust card on the console and the proof page. The catalogue itself is code, `SCENARIOS` in `shared/src/index.ts`, so the page, the server and the checker never disagree.

## Four ways to fire a scenario

| Way | How | Good for |
| --- | --- | --- |
| **The deck** | Open `/try`. One card per scenario, grouped by check. `Run` fires one; `Run all N` walks a check; `Run the whole deck` walks everything and ends with the genuine call. | A judge with a browser. Each card shows the verdict, whether it matched the catalogue, and a link to the proof. |
| **The checker** | `npm run scenarios` (add `-- resolve signature` for checks, `-- tampered replay` for ids, `--no-call` to skip ringing the phone, `TARGET=http://host:port` for another server). | Proof that every verdict is what the catalogue says: one line per scenario, non-zero exit on any mismatch. Run it in front of the judges. |
| **The presenter sheet** | Press `` ` `` on the console. `1` fires the selected attack (five of the scenarios), `2` the brand, `3` the network. | Driving the pitch without leaving the console. |
| **Raw HTTP** | `POST /reach` with a `ReachRequest` JSON body (format below), or `POST /api/workbench/scenario {"id": "..."}` to have the server build one for you. `npm run impostor -- <variant>` sends one from outside the process. | Anyone who wants to bring their own bytes. |

The docked phone (or a scanned one) rings only for the last row of this document. Everything else is either quarantined or held, and the phone stays silent: that silence is the demo.

## The matrix

`expected` is what the trust card should show. `on the wire` is what the sender actually posts. All names are as configured in `.env` (`BRAND_AGENT_NAME=stelazio.brand-demo.com`, `HCP_AGENT_NAME=patel.callsign-hcp.com`, `IMPOSTOR_AGENT_NAME=stelazio-updates.xyz`).

### 1 · Resolve agent name — does the claimed name exist in ANS at all?

| id | scenario | on the wire | expected |
| --- | --- | --- | --- |
| `lookalike` | Look-alike domain (also presenter key `1` → "Look-alike domain") | `from: stelazio-updates.xyz`, signed with its own key, no certificate | quarantined at **resolve**: `no ANS record for stelazio-updates.xyz` |
| `typosquat` | Typo-squat | `from: stelazi0.brand-demo.com` (zero for o), own key | quarantined at **resolve** |
| `subdomain-trick` | Real name as a prefix | `from: stelazio.brand-demo.com.update-portal.xyz`, own key | quarantined at **resolve** |
| `borrowed-cert` | Stolen certificate, wrong domain | `from: stelazio-updates.xyz` with the brand's genuine certificate in `certificatePem`, signed with the look-alike's key | quarantined at **resolve** (the certificate is never looked at: a name that does not exist cannot be vouched for) |

What a judge learns: the first check is about the *name*, not the message and not the certificate. The workbench's "My own domain" does the same for any domain typed in.

### 2 · Verify certificate — did the registry's CA issue a certificate binding that exact name?

| id | scenario | on the wire | expected |
| --- | --- | --- | --- |
| `forged-cert` | Forged certificate (presenter: "Forged certificate") | `from: stelazio.brand-demo.com`, `certificatePem` for that exact ANS name issued by "Stelazio Updates Root CA" over the attacker's key, signed with that key | quarantined at **certificate**: `issuer not trusted (Stelazio Updates Root CA, not Callsign Local ANS CA)` |
| `wrong-cert` | Someone else's certificate | `from: patel.callsign-hcp.com` (a registered name) with the *brand's* certificate attached | quarantined at **certificate**: `SAN does not bind ans://v1.0.0.patel.callsign-hcp.com` |
| `garbage-cert` | Unparseable certificate | brand's name, `certificatePem` is a PEM block that is not a certificate | quarantined at **certificate**: `certificate unparseable` |
| `expired-cert` | Expired certificate | brand's name, a certificate the real CA issued over the brand's key with `notAfter` 30 days ago | quarantined at **certificate**: `certificate expired …` |

What a judge learns: subject and SAN are checked against the claimed name, the chain against the registry's CA, and validity dates. A certificate that *says* the brand's name is not enough.

### 3 · Check transparency log — is that certificate sealed in a public, append-only log?

| id | scenario | on the wire | expected |
| --- | --- | --- | --- |
| `unsealed-cert` | Mis-issued, never logged | brand's name, a certificate the real CA signed for the brand's ANS name over the *attacker's* key, that was never appended to the log; signed with the attacker's key | quarantined at **transparency**: `certificate fingerprint is not sealed in the transparency log` |
| `log-tampered` | Transparency log altered (server rewrites one chain hash for the duration of the send, then restores it) | the genuine brand message, unchanged | quarantined at **transparency**: `local log hash chain is broken` |

What a judge learns: a valid chain is not the end of the story. The certificate's fingerprint must be in the log, and the log itself must audit clean; when it does not, *nobody* gets through, not even the genuine brand. The chain restores itself after the scenario; run `brand` next to show recovery.

In `ANS_MODE=local` the log is the self-hosted one at `/ans/v1/log/audit` (real Merkle proofs, real hash chain, real ES256 checkpoint). In `ANS_MODE=real` it is GoDaddy's public log and the two scenarios above degrade: `unsealed-cert` presents the forged certificate instead (fails at certificate), and `log-tampered` is a plain brand send.

### 4 · Verify message signature — was this message signed by that key, unaltered, recently, once?

| id | scenario | on the wire | expected |
| --- | --- | --- | --- |
| `tampered` | Tampered in flight (presenter: "Tampered message") | genuine brand message, real signature, `payload.summary` edited after signing: `5 mg` → `50 mg` | quarantined at **signature**: `signature does not match message body` |
| `replay` | Replayed message (presenter: "Replayed message") | the last verified brand message, same `id`, `ts` 11 minutes in the past, re-signed by the brand's key | quarantined at **signature**: `signature valid, but message is 11 min old · replay window is 5 min` (and `id already verified at …` when the original went through this process) |
| `wrong-key` | Right name, wrong key | brand's name, no certificate, signed with a key the registry never saw | quarantined at **signature**: `signature does not match message body · key in the identity certificate for …` |
| `unsigned` | Unsigned | brand's name, real certificate attached, `signature` missing | quarantined at **signature**: `message is unsigned` |
| `future-dated` | Dated in the future | genuine brand key, `ts = now + 10 min` | quarantined at **signature**: `message is dated 10 min in the future · allowed skew is 2 min` |

What a judge learns: the signature is checked against the key inside the *registry's* certificate for that name, then freshness (5-minute window, 2-minute forward skew), then uniqueness of `(from, id)`. A real signature on the wrong bytes, or on old bytes, is worth nothing.

### 5 · Doctor's policy — does Dr. Patel want this call right now?

| id | scenario | on the wire | expected |
| --- | --- | --- | --- |
| `wrong-specialty` | Off-topic brand (presenter: "Off-topic brand") | genuine brand, `payload.specialty: "Nephrology"` | **verified**, held in the inbox: `not relevant to Cardiology · held in inbox`. Phone silent. |
| `in-clinic` | Doctor in clinic (server sets `acceptCalls=false` for the send, then restores it; the presenter sheet's "Accepting calls" switch does the same by hand) | the genuine brand message | **verified**, held in the inbox: `In clinic … · held in inbox`. Phone silent. |

What a judge learns: identity and permission are different questions. All five checks green on the identity side can still end in the inbox, because the doctor's agent works for the doctor.

### ✓ · Control — the genuine brand

| id | scenario | on the wire | expected |
| --- | --- | --- | --- |
| `brand` | The genuine brand (presenter key `2`) | `from: stelazio.brand-demo.com`, registered certificate, fresh ES256 signature, `specialty: "Cardiology"` | **verified · call**: five green checks, the phone rings, the agent talks, `request samples` produces a signed agent-to-agent receipt mid-call |

## Bring your own bytes

`POST /reach` takes this body. Sign the canonical JSON of `{id, from, to, claimedDisplayName, kind, payload, ts}` (keys in that order, no whitespace) with ES256 and put the base64url `r||s` in `signature`. Anything you make up will stop at resolve (unknown name) or signature (known name, unknown key); that is the point.

```json
{
  "id": "req_yourid",
  "from": "stelazio.brand-demo.com",
  "to": "patel.callsign-hcp.com",
  "claimedDisplayName": "Stelazio",
  "kind": "label_update",
  "payload": {
    "summary": "New renal dosing guidance for Stelazio: reduce to 5 mg once daily when eGFR is below 45.",
    "specialty": "Cardiology",
    "affectedPatients": 2
  },
  "ts": "2026-09-19T18:00:00.000Z",
  "signature": "<base64url ES256 over the canonical JSON>",
  "certificatePem": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n"
}
```

```bash
curl -s -X POST localhost:8787/reach -H 'content-type: application/json' -d @request.json
curl -s localhost:8787/api/proof/req_yourid          # the verdict and the evidence behind every step
```

Or let the server build a catalogued one:

```bash
curl -s -X POST localhost:8787/api/workbench/scenario -H 'content-type: application/json' -d '{"id":"unsealed-cert"}'
```

## Reading the result

- **Trust card** (console): the five rows animate as they run; the failing one turns red with the reason; "Proof" opens the evidence (DNS answers, certificate subject/SAN/issuer/fingerprint, Merkle leaf index and root, signature algorithm and key fingerprint, policy inputs).
- **Proof page**: `/proof/<requestId>`, printable, one per request.
- **Inbox**: quarantined items carry the failing reason; held items carry the policy reason; called items link to the transcript.
- **Phone**: rings for `brand` only. If it rang for anything else, that is a bug worth a bounty.
- **Audit log**: the presenter sheet's "Show audit log" lists every scenario fired, with the prep it did and the restore it ran.

## Running the checker in front of judges

```bash
npm run scenarios -- --no-call     # 17 attacks, ~40 s, every one must read "ok"
npm run scenarios -- brand         # then the one that rings
```

Expected tail: `17/17 as catalogued`. If any line reads `MISMATCH`, the trust card is lying and the demo is not ready.
