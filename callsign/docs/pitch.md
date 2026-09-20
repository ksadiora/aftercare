# Callsign — pitch script, demo beats, and judge Q&A

Four minutes spoken, then questions. One presenter talks, one drives the console. The judge holds the phone: their own, paired at the start of the demo. If they'd rather not, the presenter's second phone is already paired and goes into their hand instead. Read it aloud twice before you go on; cut anything that runs long rather than speeding up.

---

## The four-minute script

**[0:00] Cold open**

Everyone in this room has ignored a text from a number they didn't recognize. Now imagine you're a cardiologist, it's 2 pm, and the text says "Stelazio Safety Team: dosing has changed, reply with your NPI." Is that real? You have no way to know. So you ignore it. And if it was real, a patient with failing kidneys just stayed on the wrong dose.

This is Callsign. An AI agent has to prove who it is before a physician's phone rings.

**[0:30] The problem, in one breath**

Impiricus reaches over a million opted-in doctors by SMS. It works. But a text can't prove who sent it, can't answer a question, and can't get anything done. And SMS is off limits for this challenge anyway. So we built the channel after SMS.

**[0:50] The idea**

Don't message the doctor. Message the doctor's agent. Every physician gets a personal agent with a real domain name, a certificate, and a public log entry, all through GoDaddy's Agent Name Service. Brands reach that agent, agent to agent. The agent verifies them, applies the doctor's own rules, and only then rings the phone.

**[1:05] Demo beat 1: pair the phone**

*(Cue: driver presses backtick; the QR fills the panel.)* For the next three minutes, your phone is Dr. Patel's phone. Scan this, tap Pair. *(Judge scans; the panel flips to "Paired".)* That's it. Nothing installed, no number, no account. It's a page on the venue Wi-Fi, and it's now the only phone her agent can ring.

**[1:20] Demo beat 2: the impostor**

*(Cue: driver selects **Forged certificate** and clicks Run attack.)* This one is smarter than a look-alike domain. It claims to be Stelazio at the brand's real name, and it brought a certificate for that name. Watch the trust card. Resolve: the brand's record exists, green. Certificate: issued by a CA nobody trusts, and the fingerprint isn't the one sealed in the transparency log. Quarantined. The phone in your hand did not ring. *(Optional, if there's time: click the red step.)* Every check keeps its evidence. That's the rogue issuer, that's the fingerprint that didn't match. A judge can scan this and verify it on their own phone.

There are five of these attacks in the panel, and each one dies at a different step: a look-alike domain with no record, a forged certificate, a real message with the dose edited in flight, a real message replayed from earlier, and a real brand that simply isn't relevant to a cardiologist. Depth, not a red light.

**[1:45] Demo beat 3: the real brand**

*(Cue: driver clicks Brand calls.)* Now the real Stelazio agent. Same message shape. Resolve: DNS records found. Certificate chain valid, SAN matches. Transparency log receipt checks out. Signature verifies against that certificate's key. And finally Dr. Patel's own policy: it's cardiology, it's inside her hours, this sender isn't muted. *(The judge's phone rings and buzzes: incoming call, Stelazio, verified.)* Go ahead, tap Accept.

**[2:10] Demo beat 4: the conversation and the handshake**

*(The phone speaks.)* "Dr. Patel, this is the verified Stelazio agent, calling through Callsign. New renal dosing guidance: below eGFR 45, reduce to 5 milligrams once daily. Two of your patients are affected." Ask it about kidney function. *(Judge speaks into the phone; the line lands on the console transcript.)* The agent answers from section 2.3 of the label, and only from the label. It will not give clinical advice. If the label doesn't cover it, it says so and offers the full document.

Now ask it to send you two boxes for next Friday. *(Judge asks; watch the right side of the console.)* Her agent verifies the brand agent. The brand agent checks her Virginia license: active. Checks sample eligibility under PDMA: good standing, no request in thirty days. Proposes two starter cartons, next Friday, Blacksburg Cardiology. Her agent accepts. Both sign the hash. Under five seconds, and the phone in your hand is still reading the confirmation back. That's a signed agent-to-agent agreement, not a promise to call back.

**[3:00] Demo beat 5: the doctor's rules, and the network**

*(Cue: driver flips **Accepting calls** off in the panel, then clicks Brand calls again.)* Identity is half of it. The other half is whether Dr. Patel wants to be reached right now. Same verified brand. Every check green. And the phone stays silent, because her agent knows she's in clinic until two. Held in the inbox, not lost. *(Cue: driver clicks **Reach the network**.)* And it isn't one doctor. The brand reached four physicians at once. Two cardiologists got the call. The nephrologist and the internist were held, each for their own reason. Impiricus has a million of these.

Everything you just saw is in the inbox and the audit log, held in this server’s memory for the demo: who reached her, which check failed for the impostor, the transcript, the agreement with both signatures. There is no phone number in any of it, because we never asked you for one. Your phone paired itself.

**[3:15] Why this matters to Impiricus**

Impact on the doctor: one trusted channel instead of a hundred unverified ones, and the call does work for her instead of asking her to do work. Originality: identity-first outreach, agent to agent, with a signed outcome. Technical execution: five verification steps, three integrations, a ring on a real device with no carrier, and every one of them runs in mock mode if the network dies on stage. Commercial fit: Impiricus already has the opt-in relationship with a million physicians. The reach request that becomes an SMS today becomes a verified agent call tomorrow, with a delivery receipt that proves who was reached and what was agreed.

**[3:45] Close**

Callsign. The phone only rings for agents that can prove who they are. Thank you.

---

## The demo beats with stage cues

| # | Beat | Presenter says | Driver does | Console shows | Phone |
| --- | --- | --- | --- | --- | --- |
| 1 | Pair | "Scan this, tap Pair. That's Dr. Patel's phone now." | Press backtick. The panel shows the QR with the LAN URL (e.g. `https://10.101.6.210:5173/phone`). | Panel flips to "Paired" with the device name. | Judge scans, accepts the certificate warning once, taps **Pair**. Screen says it is waiting for a call. |
| 2 | Impostor | "Watch the trust card." | Select **Forged certificate** in the Run group, click **Run attack** (or press 1; `npm run impostor -- forged-cert`). Then click the red step to open the proof drawer. | Resolve passes, certificate fails red: "issuer not trusted · fingerprint not the one sealed for this agent". Proof drawer with the certificate's real fields and a QR to `/proof/<id>`. Inbox item quarantined. | Silent, in the judge's hand. |
| 3 | Real brand | "Same message shape, real identity." | Click **Brand calls** (or press 2). | Five steps go green in about 3.5 s, then the call card flips to dialing → ringing. | Rings and vibrates: incoming-call screen, "Stelazio, verified". Judge taps **Accept**. |
| 4 | Conversation and handshake | "Ask it about kidney function." Then: "Ask for two boxes next Friday." | Nothing. Watch the transcript. | Transcript lines land as they're spoken; `label_lookup` shows in the audit drawer with the section citation. Then the negotiation panel: verify_peer → check_license → check_eligibility → propose → agree → sign → done, both signatures, hash. | The agent speaks each line; the judge talks back. The agent reads the confirmation aloud. |
| 5 | Rules and network | "Same brand. She's in clinic." Then: "It's four doctors at once." | Flip **Accepting calls** off, click **Brand calls**. Flip it back on, click **Reach the network** (or press 3). | Trust card: "Verified · held", amber, "In clinic until 2:00 PM · held in inbox". Inbox row gets a Held pill. Network strip: four tiles resolve, two Called, two Held with reasons. | Silent during the held call. Rings again on the network broadcast; the judge can decline it. |
| 6 | Receipt | "We never asked for a number." | Open the audit drawer. | Inbox with every item, audit trail, the phone listed by device name only. | Judge taps **End**, or the agent signs off. |

**Autopilot.** Press **A** (or the Autopilot button) and the driver's hands come off the keyboard: reset, the selected attack, a four-second pause, then the brand call. Esc cancels. Use it if the driver is nervous; use the buttons if you want to talk between beats.

**Sounds.** The console plays a soft chime on verified and a low thud on quarantined. The More group has the switch. Leave it on if the room is quiet; it makes the silence after the impostor land harder.

**Fallbacks.** Wi-Fi is the one dependency: the laptop and the phone must be on the same network, and venue Wi-Fi often isolates clients from each other. Bring a travel router or run a hotspot from a teammate's phone, put the laptop and the judge's phone on it, and confirm a pair in the hallway before you go on. If the judge's phone won't pair (certificate screen, managed device, no camera), hand them the presenter's second phone, already paired. If speech recognition fails on the phone, the phone app has a type-to-talk field: the judge types the question and the agent still answers aloud. If no phone is paired at all, **Brand calls** runs the simulated call on the console with a scripted transcript that still executes the real negotiation; `CALLS_MODE=mock` forces that path. If the impostor request has already been fired, click **Reset** (or press 0).

**Failure path, if a judge asks to see one.** Type `send samples, license 0101-777120` into the request_samples tool (or curl it): the license check comes back expired and the negotiation ends "failed" with a spoken reason.

---

## Q&A: eleven likely questions

**1. Isn't a voice agent talking to a doctor about dosing giving medical advice?**
No. The agent reads from the published prescribing information and cites the section; the label is the only context Gemini sees, the section number is validated against the real label, and anything not covered gets "that isn't in the current label, I can send you the full prescribing information." It relays the manufacturer's own label, which is exactly what a rep does today, and it never interprets it for a specific patient.

**2. How does the sample request stay compliant with the PDMA?**
The negotiation encodes the PDMA shape: a licensed prescriber in good standing (state license check), a signed request from the prescriber's side (the doctor's agent signs the terms hash), and a per-request quantity cap taken from the label. An expired or suspended license or a request inside the cooldown window fails the negotiation with a stated reason instead of shipping anything.

**3. What happens if ANS is down?**
The verifier fails closed: a step that cannot complete is a failure, the request is quarantined, and the phone does not ring. Availability of the identity layer only ever costs a delayed message, never a spoofed call, and the doctor's agent keeps the request in the inbox for retry.

**4. Why not just use SMS?**
A text can't prove who sent it, can't answer a follow-up, and can't close an action; it is a one-way notification into the same inbox as the phishing. A verified agent call answers the question and signs the agreement in the same minute, and the SMS channel is off limits for this challenge anyway.

**5. How does Impiricus make money from this?**
Same customers, higher-value unit: brands already pay for verified reach to opted-in physicians, and a verified conversation with a signed outcome (sample shipped, rep booked, CME accepted) is worth far more than a delivered text. Impiricus supplies the opt-in relationship and the physician agents; brands pay per verified engagement and per completed action.

**6. Where does the doctor's phone number live?**
Nowhere. Callsign never asks for one. The doctor's phone is a browser page that pairs itself with her agent over the network and is known only by a device name; the agent rings it over a WebSocket. The persistence layer still scrubs anything shaped like a phone number before it leaves the process, and the Twilio and ElevenLabs carriers we also built mask any number they handle, so a real-line deployment keeps the number behind the carrier and out of every log and every brand agent's view.

**7. Why a web app and not a real phone call?**
Because identity is the point, not telephony. The moment that matters is the phone staying silent for the impostor and ringing for the verified agent, and that gate is the same whatever is on the other end. In production the paired device is Impiricus's existing physician app, which already holds the opt-in relationship; the ring lands there. Where a real line is wanted, the same verification gates a PSTN call through the Twilio carrier we also built, running the same dialogue code. The web phone also demos on nothing but venue Wi-Fi: no carrier account, no public URL, and no number collected from anyone in the room.

**8. What's real and what's mocked today?**
Real: the agent-to-agent protocol, the five-step verification pipeline and fail-closed logic, the signed negotiation, the label-grounded Gemini lookup, the in-app call (a real ring on a real device, speech in and out in the browser), in-memory session state, and the console. Mocked or switchable: the ANS calls, the PSTN carriers, and the state license lookup, each behind a `_MODE` flag with a mock that runs with no keys.

**9. How exactly is the impostor detected?**
Its name, `stelazio-updates.xyz`, has no record in the Agent Name Service, so resolution fails before we even look at its certificate; if it had a certificate, the SAN would not match a claimed name that ANS vouches for, and its signature would not verify against any ANS-anchored key. Display names are ignored entirely, which is why "Stelazio" in the message means nothing.

**10. What's the latency?**
Verification runs in about 3.5 seconds; the in-app ring lands within half a second of the policy step going green, and a PSTN call takes a few seconds more to start ringing. The negotiation is budgeted at 3.4 seconds of phases plus at most 1.2 seconds of Gemini phrasing, and the label lookup has an 8-second cap with a keyword fallback so the voice agent never stalls.

**11. What breaks at scale?**
Nothing in the trust path is per-doctor state: ANS lookups and signature checks are stateless and cacheable, and each doctor's agent is an independent process. The pressure points are the voice provider's concurrent-call limits on the PSTN path and the license registry, which would move from a lookup table to the state boards' APIs; the store already writes through to Atlas so agents can be restarted or sharded without losing history.
