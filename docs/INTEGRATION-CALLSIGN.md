# Callsign inside Aftercare: the escalation gate

Aftercare is the app. Callsign is the module that decides whether a nurse's
escalation may reach the intended provider. Nothing else changed hands:
Aftercare owns patients, intake, clinical urgency, nurse actions, the case
history and the calling system; Callsign owns signed-escalation verification,
tamper and replay detection, the recipient's policy, and the evidence that
explains every delivery decision.

```
Nurse escalates ──► Aftercare records the escalation (nurse note + attributed automated summary)
                 ──► Escalation gate (server/callsign/): sign as the care-team service, then
                       resolve · certificate · transparency log · signature + replay · provider's policy · content
                 ──► delivered  → the case appears on /provider with the evidence and reply controls
                 ──► held       → the nurse sees why (provider policy) and can retry later
                 ──► rejected   → the nurse sees which check stopped it; the provider was never contacted
Doctor replies on /provider ──► provider note in the same audit-derived thread the nurse reads
```

## Where the code is

| Path | What it is |
| --- | --- |
| `server/callsign/gate.ts` | The gate: builds the signed request, runs verification, screens content, writes the record and the audit entry. Never changes urgency or disposition. |
| `server/callsign/pipeline.ts`, `ans.ts`, `local-registry.ts`, `replay.ts`, `evidence.ts`, `sign.ts` | Callsign's verification core, extracted as-is: a self-hosted ANS-shaped registry (private CA, X.509 identity certificates with the ANS name as a URI SAN, a Merkle transparency log with signed checkpoints), ES256 signing, replay windows, and the evidence rows behind each step. |
| `server/callsign/policy.ts` | The provider's policy: accepting escalations or holding them, specialty filter. |
| `server/callsign/screening.ts` | Content screening adapted to an authorized care-team workflow: credential, payment, remote-access and bypass requests are blocked; clinical detail is expected; pressure language is flagged, not held. |
| `server/callsign/config.ts`, `identities.ts`, `types.ts` | Configuration (env), the two identities (provider agent, care-team service), and the contracts. |
| `shared/types.ts` (`EscalationRecord`, `EscalationView`, `ProviderPolicy`) | What both surfaces read. |
| `server/store.ts` (`escalations` table) | One row per delivery attempt, newest wins, scoped by run like everything else. |
| `src/EscalationGate.tsx` | The panel on the nurse's case (verdict, reason, retry, attack demos) and on the provider page (evidence of every check, proof link, policy toggle). |
| `callsign/` | The original Callsign project, vendored unchanged apart from env-driven names. It is the source the module was extracted from and still runs standalone (`npm run agent`); Aftercare does not call it. |

## Identities

Two ANS names exist in the local registry, both issued on first run under
`CALLSIGN_KEYS_DIR` (default `data/callsign-keys`, ignored by git):

| Role | Name | Env |
| --- | --- | --- |
| The provider's agent (recipient, verifier) | `lee.callsign-hcp.com` for Dr. Morgan Lee, Orthopedic Surgery | `PROVIDER_AGENT_NAME`, `PROVIDER_NAME`, `PROVIDER_SPECIALTY` |
| The care-team service (sender, signer) | `careteam.aftercare.work` | `CARE_TEAM_AGENT_NAME`, `CARE_TEAM_DISPLAY_NAME` |

Every escalation request carries the nurse, the patient case and the intended
provider in its payload and is signed by the care-team key. Verifying that
signature authenticates the care-team service, not the nurse; the nurse's name
stays self-reported, exactly as before.

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/patients/:id/actions {action:'escalate', note, nurse}` | Records the escalation and the automated summary, then runs the gate before responding. |
| `GET /api/patients/:id/escalation` | The latest gate record for the case, the provider's policy and the gate's configuration. |
| `POST /api/patients/:id/escalation/retry {nurse}` | Re-run delivery of a held or rejected escalation. |
| `POST /api/patients/:id/escalation/demo {variant: spoof|tamper|replay}` | Send an attacker's copy of the last escalation through the gate; recorded as a rejected attempt. |
| `GET /api/provider/policy`, `POST /api/provider/policy {acceptCalls, note}` | The provider's rule for delivery. |
| `GET /api/proof/:requestId` | The full record with evidence, for a third party to re-check. |
| `GET /ans/*` | The local registry: `/ans/dns/<name>`, `/ans/v1/agents/<id>`, `/ans/ca.pem`, `/ans/v1/log/audit`, `/ans/zone`. |

`GET /api/provider/queue` now lists only cases whose latest escalation was
delivered; held and rejected ones stay with the nurse, with the reason.

## Invariants kept

- Rules decide urgency; the gate reads severity and never writes it.
- Only a nurse closes a case. A held or rejected delivery leaves the case escalated and open.
- Generated text stays attributed: the automated summary is its own audit entry, the gate's verdict is another (`escalation_gate`, actor `Aftercare · escalation gate (Callsign)`), and provider replies are the provider's words.
- Nothing silently degrades. `ANS_MODE=local` needs no keys or network; with `ANS_MODE=mock` the record says the registry checks were simulated.

## What is not claimed

No public GoDaddy ANS registration is made; the registry is this server's own
(real cryptography, local trust anchor). No audio moves through the gate;
Aftercare's existing calling paths are untouched. The screening rules are
deterministic local rules, not a fraud guarantee.
