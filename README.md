# Aftercare

> Post-discharge care that reaches the patient first.

Aftercare is an AI-assisted post-discharge follow-up system that conducts bilingual patient check-ins, identifies concerns in real time, prioritizes patients for nurses, generates source-linked clinical briefings, and securely escalates cases to providers.

It combines conversational AI with deterministic safety rules, real-time voice, clinician workflows, cryptographic identity verification, and auditable evidence.

![Aftercare nurse worklist](docs/images/worklist.png)

**Demo:** [Add demo video]
**Devpost:** [Add Devpost]
**Built at VT Hacks 14**

---

## At a Glance

| Capability                                |                                Result |
| ----------------------------------------- | ------------------------------------: |
| Adaptive clarification latency            |                          ~0.9 seconds |
| Patient interaction modes                 | Voice, simulation, text, live handoff |
| Escalation verification checks            |                                     6 |
| Languages                                 |                     English + Spanish |
| Synthetic patients per demo run           |                                    40 |
| Full wound-concern demo                   |                           ~13 seconds |
| Local demo cost                           |                                    $0 |
| External services required for simulation |                                  None |

Aftercare can run its complete deterministic demo locally with no cloud database, phone number, tunnel, API credits, or external network.

---

## The Problem

Hospital discharge is a handoff from continuous clinical supervision to a patient suddenly managing recovery at home.

In the United States, there were approximately **3.6 million 30-day hospital readmissions in 2022**, with an average cost of **$20,329 per readmission**.

More than a third of readmissions occur within the **first 14 days after discharge**.

That is exactly when small problems can become serious:

* a wound begins to look different
* a patient is unsure about medication
* transportation prevents follow-up
* symptoms are difficult to describe
* a patient does not know whether a concern is worth calling about

Traditional follow-up systems depend heavily on patients initiating contact.

Aftercare reverses that model.

The system initiates the check-in, listens to the patient naturally, detects concerns, and organizes the result for the care team.

---

# How Aftercare Works

Aftercare creates a continuous path from patient follow-up to clinician action.

```text
Patient
   │
   │  English / Spanish
   │  Voice / Text / Simulation
   ▼
┌──────────────────────────────┐
│     Structured Check-In      │
│                              │
│  Natural patient responses   │
│  + adaptive clarification    │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│     Safety Rules Engine      │
│                              │
│ Emergency detection          │
│ Wound concerns               │
│ Medication concerns          │
│ Practical barriers           │
│ Uncertainty detection        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Nurse Worklist          │
│                              │
│ Risk sorting                 │
│ Full transcript              │
│ Source-linked briefing       │
│ Audit trail                  │
└──────────────┬───────────────┘
               │
               │ Escalation
               ▼
┌──────────────────────────────┐
│       Callsign Gate          │
│                              │
│ Identity                     │
│ Certificate                  │
│ Transparency log             │
│ Signature                    │
│ Provider policy              │
│ Content verification         │
└──────────────┬───────────────┘
               │
               ▼
            Provider
```

The key design choice is simple:

> AI helps understand the conversation. Deterministic server rules control safety-critical decisions.

---

# Core Features

### Bilingual Conversational Check-In

Patients can complete the intake naturally in **English or Spanish**.

Aftercare supports:

* live ElevenLabs voice conversations
* browser-based simulation
* text conversation
* live nurse handoff

The patient's original words remain available to the care team throughout the workflow.

---

### Deterministic Safety Routing

Urgency is determined by a server-side rules engine before any language model is consulted.

The engine detects categories including:

```text
Emergency language       → Immediate emergency path
Wound concerns           → Urgent review
Medication concerns      → Urgent review
Practical barriers       → Review
Patient uncertainty      → Review
Routine response         → Continue intake
```

Emergency language immediately interrupts the normal questionnaire and switches to the emergency pathway.

This creates a clean separation between:

**AI for language understanding**

and

**deterministic logic for clinical workflow control**

---

### Bounded AI Clarification

Patients rarely answer medical questions in perfectly structured sentences.

They say things like:

> “It’s kind of warm, but I think it’s probably okay.”

When the rules engine cannot confidently interpret a response, Gemini can reformulate the current question.

That clarification system is deliberately bounded.

The model can clarify one question while the server continues to own:

* questionnaire progression
* urgency
* disposition
* session completion
* escalation

The result is natural conversation without giving the language model control over the safety-critical state machine.

---

# Source-Linked Clinical Briefing

Aftercare converts a full patient conversation into a concise briefing for the care team.

But the briefing stays connected to its evidence.

Every generated statement references the transcript lines supporting it.

```text
Patient:
"The incision looks more red today and it feels warmer."

Briefing:
"Increased redness and warmth around the incision were reported."

Source:
Transcript lines 18–19
```

The clinician can move directly from summary to original evidence.

This creates an auditable path:

```text
Patient statement
      ↓
Transcript
      ↓
Generated briefing
      ↓
Source citation
      ↓
Clinician review
```

Automated summaries and nurse-authored notes are also stored separately with distinct attribution.

That preserves the origin of every piece of information.

---

# A Risk-Sorted Nurse Worklist

Aftercare is designed around the clinician workflow rather than just the patient conversation.

The nurse dashboard turns an entire patient cohort into a prioritized queue.

Each case can include:

* risk level
* patient transcript
* detected concerns
* automated briefing
* supporting transcript evidence
* nurse notes
* conversation history
* escalation status
* live handoff controls
* audit history

Instead of reading forty conversations equally, the care team can immediately focus on the patients who need attention first.

---

# Self-Initiating Outreach

Aftercare can create follow-up outreach automatically.

On **day 3 after discharge**, when no contact has been recorded, the server creates an invitation for the patient.

The invitation uses a scoped patient token.

```text
/c/<token>
```

That route opens only the patient's check-in experience.

The patient sees:

* their check-in
* their conversation
* their interaction controls

The clinical dashboard remains a separate protected surface.

The architecture cleanly separates the three roles:

| Route        | User      | Purpose                                 |
| ------------ | --------- | --------------------------------------- |
| `/c/<token>` | Patient   | Individual check-in                     |
| `/nurse`     | Care team | Worklist, briefing, handoff and actions |
| `/provider`  | Provider  | Verified escalated cases                |

---

# Live Nurse Handoff

A patient can request to speak with a person during the check-in.

When that happens, open nurse dashboards receive the request.

The handoff system includes:

* atomic nurse acceptance
* room-scoped join tokens
* 10-minute token expiration
* real-time dashboard updates
* explicit participant state

A call is marked live only after both participants have joined.

This turns Aftercare from a passive questionnaire into a direct bridge between patient and care team.

---

# Technical Highlight: Solving Voice Interruption

Natural voice interaction introduced a deceptively hard problem.

A recovering patient might:

* cough
* shift in a chair
* move their phone
* make a short background sound

A voice system can interpret those events as interruptions.

Aftercare solves this with two complementary layers.

## Browser-Level Audio Gate

While the agent is speaking, the browser monitors the actual microphone input.

The microphone opens for interruption only after approximately:

**180 ms of sustained input**

This is long enough to reject many transient noises while remaining responsive to intentional speech.

After speech stops, the gate remains open for roughly:

**1 second**

That prevents natural gaps between words from prematurely closing the microphone.

During normal listening, the gate is removed entirely so patient answers remain uninterrupted.

---

## Agent-Level Turn Handling

The voice agent separately handles short non-lexical fillers such as:

```text
uh
hm
ah
```

Important questionnaire responses remain valid speech:

```text
yes
no
okay
sí
claro
```

The result is a voice interaction that is both responsive and resistant to accidental interruption.

---

# Technical Highlight: Callsign

Clinical escalation introduces another problem:

> How does one healthcare agent know that the destination receiving a patient escalation is actually the intended provider?

Aftercare integrates **Callsign**, an agent identity and verification layer.

Before an escalation reaches the provider, the request passes through six independent verification checks.

| Verification              | Purpose                              |
| ------------------------- | ------------------------------------ |
| ANS name resolution       | Resolve the intended agent identity  |
| X.509 certificate         | Verify cryptographic identity        |
| Transparency-log receipt  | Verify registration evidence         |
| Signature + replay window | Verify authenticity and freshness    |
| Provider policy           | Confirm escalation acceptance policy |
| Content screen            | Validate escalation content          |

Each verification step preserves its evidence.

The provider receives both the clinical escalation and the proof that accompanied it.

---

## Cryptographic Identity Pipeline

```text
Care Team
    │
    │ signed escalation
    ▼
careteam.aftercare.work
    │
    ▼
ANS Resolution
    │
    ▼
X.509 Certificate
    │
    ▼
Transparency Log
    │
    ▼
Signature Verification
    │
    ▼
Replay Protection
    │
    ▼
Provider Policy
    │
    ▼
Content Verification
    │
    ▼
lee.callsign-hcp.com
    │
    ▼
Provider
```

The local environment includes:

* a private certificate authority
* X.509 identity certificates
* a Merkle transparency log
* signed checkpoints
* request verification evidence

Verification evidence can be inspected through:

```text
GET /api/proof/<requestId>
```

---

# Attack Demonstration

The Callsign demo also makes the security model visible.

After a legitimate escalation is created, the interface can replay modified versions through the same verification pipeline.

Three scenarios demonstrate different security properties:

```text
Spoofed identity
Tampered request
Replayed request
```

Each request goes through the same gate as a legitimate escalation.

The interface then shows which verification check handled the request.

That makes the security architecture observable instead of leaving it hidden behind the backend.

---

# Model Selection Based on Measurement

Aftercare uses different models for different latency constraints.

A clarification occurs inside an active voice conversation, so it must fit comfortably inside ElevenLabs' **10-second tool window**.

Measured performance:

| Model                                    | Measured latency | Role                    |
| ---------------------------------------- | ---------------: | ----------------------- |
| `gemini-flash-lite-latest`               |           ~0.9 s | Real-time clarification |
| `gemini-3.6-flash`                       |         2.4–8+ s | Higher-depth processing |
| `gemini-3.6-flash` without turn deadline |         Flexible | Clinical briefing       |

Instead of using one model everywhere, Aftercare assigns models based on the requirements of each task.

```text
Real-time conversation
        ↓
Low-latency model

Clinical briefing
        ↓
Higher-depth model
```

This keeps conversation responsive while allowing richer reasoning where latency is less constrained.

---

# Performance

| Metric                       |      Result |
| ---------------------------- | ----------: |
| Adaptive clarification       |      ~0.9 s |
| Voice tool budget            |        10 s |
| Audio interruption threshold |     ~180 ms |
| Audio release window         |        ~1 s |
| Full wound scenario          |       ~13 s |
| Browser session cap          |       5 min |
| Lost heartbeat detection     |       ~35 s |
| Handoff token lifetime       |      10 min |
| Synthetic cohort             | 40 patients |

---

# Architecture

```text
Patient
│
├── Simulation
│      └── Browser SpeechSynthesis
│
├── Live Voice
│      └── ElevenLabs Agent
│             │
│             ├── get_next_step
│             └── finish_session
│
└── Text
       └── Gemini clarification
              │
              ▼
     ┌──────────────────────────┐
     │ Server-Owned Protocol    │
     │                          │
     │ Emergency detection      │
     │ Wound routing            │
     │ Medication routing       │
     │ Barrier detection        │
     │ Negation handling        │
     │ Uncertainty detection    │
     └────────────┬─────────────┘
                  │
                  ▼
               SQLite
                  │
          ┌───────┼────────┐
          │       │        │
          ▼       ▼        ▼
       /nurse  /provider  /c/<token>
          │
          ▼
       Escalation
          │
          ▼
      Callsign Gate
          │
          ├── ANS resolution
          ├── X.509 certificate
          ├── transparency log
          ├── signature
          ├── replay protection
          ├── provider policy
          └── content screen
          │
          ▼
       Provider
```

---

# Built for Auditability

Healthcare software needs more than a final output.

Aftercare records the path that produced it.

The audit system captures information including:

* patient conversation
* routing decisions
* clarification events
* model identity
* model latency
* escalation evidence
* nurse actions
* automated summaries
* clinician notes
* handoff state
* verification results

Patient-generated, AI-generated, and clinician-generated information remain separately attributed.

---

# Safety by Design

Aftercare uses several architectural boundaries to keep AI in a narrow and inspectable role.

### Rules own urgency

Emergency and concern routing happen through deterministic server logic.

### Models clarify language

AI improves conversational understanding without owning the workflow state.

### Clinicians retain control

Care-team actions and resolution remain explicit clinician actions.

### Evidence stays attached

Generated briefings link back to patient statements.

### Escalations are verified

Provider-bound requests pass through a cryptographic verification layer.

### Every important action is auditable

State transitions and automated operations are preserved in the audit history.

---

# Testing

Run the test suite with:

```bash
npm test
npm run build
npm run test:e2e
```

The test suite covers major system behavior across:

### Conversation

* English and Spanish routing
* consent
* ambiguity
* negation
* repeated starts
* adaptive clarification
* preserved flags
* session persistence

### Safety

* emergency interruption
* server timeouts
* stale results
* routing rules
* recording protection
* clinician-controlled resolution

### AI

* clarification boundaries
* model latency
* source-linked briefings
* citation validation
* graceful provider handling

### Handoff

* atomic nurse claims
* token scope
* token signing
* join state
* ring timeout behavior

### Security

* ANS parsing
* destination verification
* replay handling
* origin policy
* host policy
* rate limits

### Browser

* live worklist updates
* refresh recovery
* history
* microphone handling
* keyboard accessibility
* mobile layout
* text clarification
* source links
* handoff state

End-to-end browser tests use a separate database and local Gemini stand-in so the test suite can run without consuming model quota.

---

# Getting Started

Aftercare requires:

```text
Node.js 24+
npm
```

Install and start:

```bash
npm install
npm run build
npm start
```

Then open:

```text
http://127.0.0.1:4317
```

The simulation works immediately.

No `.env` file is required for the local simulated workflow.

For development:

```bash
npm run dev
```

Vite runs on port `4317` and the API runs on `4318`.

---

# Enable Live AI Features

Copy:

```text
.env.example
```

to:

```text
.env
```

Then configure the integrations you want.

| Feature                | Environment variables                                  |
| ---------------------- | ------------------------------------------------------ |
| Adaptive clarification | `GEMINI_API_KEY`                                       |
| Text conversation      | `GEMINI_API_KEY`                                       |
| Clinical briefing      | `GEMINI_API_KEY`                                       |
| Live voice             | `ELEVENLABS_API_KEY`                                   |
| Nurse handoff          | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| Agent identity         | `ANS_API_KEY`, `ANS_CARE_TEAM_NAME`                    |

For live voice:

```bash
npm run voice:setup
```

The setup creates the private ElevenLabs agent and prints the resulting:

```text
ELEVENLABS_AGENT_ID
```

---

# Project Structure

```text
Aftercare
│
├── Patient experience
│   ├── Voice
│   ├── Text
│   └── Simulation
│
├── Care-team application
│   ├── Risk worklist
│   ├── Clinical briefing
│   ├── Nurse actions
│   └── Live handoff
│
├── Safety engine
│   ├── Emergency rules
│   ├── Concern routing
│   ├── Negation handling
│   └── Clarification boundary
│
├── Callsign
│   ├── Agent identity
│   ├── Certificates
│   ├── Transparency log
│   ├── Signatures
│   └── Replay protection
│
├── Audit layer
│
└── Provider experience
```

---

# Documentation

| Document                       | Contents                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `AGENTS.md`                    | Development commands, layout and conventions             |
| `docs/ARCHITECTURE.md`         | Data model, request flow, live updates and run isolation |
| `docs/CALLING.md`              | Voice architecture and audio paths                       |
| `docs/INTEGRATION.md`          | Integration architecture                                 |
| `docs/INTEGRATION-CALLSIGN.md` | Callsign verification system                             |
| `HANDOFF.md`                   | Implementation and verification notes                    |
| `deploy/README.md`             | Infrastructure and deployment                            |

The full local API contains **27 documented endpoints**.

---

# The Bigger Idea

Most healthcare AI systems start with:

> What can an AI model automate?

Aftercare starts with a different question:

> Where can intelligence reduce friction while preserving clear control, evidence, and accountability?

The result is not just a chatbot.

It is a complete post-discharge workflow:

```text
OUTREACH
   ↓
CONVERSATION
   ↓
UNDERSTANDING
   ↓
SAFETY ROUTING
   ↓
CLINICIAN PRIORITIZATION
   ↓
SOURCE-LINKED BRIEFING
   ↓
HUMAN HANDOFF
   ↓
VERIFIED ESCALATION
   ↓
PROVIDER
```

The patient gets a simple conversation.

The nurse gets a prioritized worklist.

The provider gets a verified escalation.

And every step between them remains inspectable.

---

# Team

**[Team member]** — [GitHub / LinkedIn]
**[Team member]** — [GitHub / LinkedIn]
**[Team member]** — [GitHub / LinkedIn]

---

# License

MIT License

---

<p align="center">
  <strong>Aftercare</strong><br>
  Post-discharge follow-up that reaches out first.<br><br>
  Built at VT Hacks 14
</p>
