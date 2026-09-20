# Identity workspace verification

Verified in Chrome on 2026-09-19 against the production build, using the local ANS registry and paired browser call provider.

Open **Identity checks** in the main navigation, or `/#identity`.

## Restored components

The workspace reuses `Workbench` / `IdentityPicker`, `AttackPicker`, `TrustCard`, `ProofDrawer`, `PhoneCard`, `LiveCall`, and `Qr`. The standalone proof page remains at `/proof/:requestId`; the full scenario deck remains at `/try`.

Every trust-card step opens its evidence drawer. Each workbench result step also links directly to the corresponding proof-page section. Skipped checks explain why no evidence was examined.

Server-signed identities are labeled **demo credentials** in the picker, trust card, proof drawer, proof page, and phone receiver. The optional `VerificationResult.content` shared contract, introduced by the related call-gating change, is supported by these displays so content rejection is not presented as call approval.

## Chrome checks

| Check | Observed result |
| --- | --- |
| Look-alike preset | Rejected at Resolve: no ANS record. |
| Forged-certificate preset | Rejected at Certificate: issuer not trusted. |
| Tampered-message preset | Rejected at Signature: signed body does not match. |
| Replayed-message preset | Rejected at Signature: message is 11 minutes old. |
| Off-topic preset | Demo credentials pass; Policy holds the Nephrology update for a cardiologist. |
| Custom identity | Entered an unregistered domain; rejection matched the Resolve prediction. |
| Spoof identity | Forged-certificate checkbox changed prediction from Signature to Certificate. |
| Manual tamper | Checkbox changed prediction to Signature; submitted request failed there, marked “As predicted.” |
| Positive control | Untampered demo-brand request passed all five checks and rang the docked phone. Decline ended the call. |
| Exact replay | Replayed the positive control; signature was valid but the already-seen message ID was rejected. |
| Clickable evidence | Resolve, Certificate, Log, Signature, and Policy tabs each displayed the corresponding evidence. |
| Proof QR destination | Opened proof link using the LAN host and actual production port; five checks, hashes, certificate, replay evidence, and demo label rendered. |
| Phone QR destination | Opened LAN phone link successfully; pairing page rendered. |
| Responsive layout | Workspace and proof page had no horizontal overflow at 390px. |
| Browser console | No errors or warnings recorded for workspace or LAN phone page. |

The QR codes include a quiet margin. LAN URLs use the browser’s actual protocol and port, preserving an explicit public tunnel when present. Five focused URL tests cover production/development ports, public HTTPS tunnels, reachable origins, VPN interface ordering, and invalid URLs.

Phone reachability was checked in Chrome through the LAN address. A physical handset scan was not performed; LAN access requires the phone to be on the same reachable network. The app explains that microphone access requires HTTPS while typed replies work over HTTP.

## Evidence

- [Restored workspace, result evidence, proof QR, and phone QR](screens/identity-workspace.png)
- [Proof page at phone width](screens/identity-proof-mobile.png)

## Automated verification

The coordinated checkout passed lint, type checking, production build, all 46 tests, and all 18 scenarios. After the final build, a second Chrome smoke check confirmed “Demo credentials verified” while ringing and in the declined-call summary accessibility label. All created Chrome tabs were closed; the shared server owner was notified to stop the verification server. No database access was introduced.
