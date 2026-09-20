# Aftercare

> **Post-discharge care that reaches the patient first.**

Aftercare is an AI-assisted post-discharge follow-up system that conducts bilingual patient check-ins, identifies concerns in real time, prioritizes patients for nurses, generates source-linked clinical briefings, and securely escalates cases to providers.

It combines conversational AI, deterministic safety rules, real-time voice, clinician workflows, cryptographic identity verification, and auditable evidence into one post-discharge care system.


**Demo Video:** [Add demo link]
**Devpost:** [Add Devpost link]
**Built at VT Hacks 14**

---

## At a Glance

| Capability                                |                                Result |
| ----------------------------------------- | ------------------------------------: |
| Adaptive clarification latency            |                          ~0.9 seconds |
| Patient interaction modes                 | Voice, simulation, text, live handoff |
| Escalation verification checks            |                                     6 |
| Languages                                 |                     English + Spanish |
| Synthetic patients per demo               |                                    40 |
| Full wound-concern scenario               |                           ~13 seconds |
| Local simulation cost                     |                                    $0 |
| External services required for simulation |                                  None |

Aftercare can run its complete deterministic simulation locally with no cloud database, phone number, tunnel, API credits, or external network.

---

## The Problem

Hospital discharge is a major transition.

A patient goes from continuous clinical supervision to managing recovery largely on their own.

In the United States, there were approximately **3.6 million 30-day hospital readmissions in 2022**, with an average cost of **$20,329 per readmission**.

More than a third of readmissions occur within the **first 14 days after discharge**.

That is exactly when seemingly small problems can become serious:

* A wound starts looking different
* A patient is unsure about medication
* Transportation prevents follow-up
* Symptoms are difficult to describe
* A patient is unsure whether a concern is serious enough to call about
* Language or technology makes traditional follow-up difficult

Traditional follow-up often depends on the patient initiating contact.

Aftercare reverses that model.

The system initiates the check-in, listens to the patient naturally, identifies concerns, organizes the result for the care team, and supports secure escalation when needed.

---

## How Aftercare Works

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
│  Emergency detection         │
│  Wound concerns              │
│  Medication concerns         │
│  Practical barriers          │
│  Uncertainty detection       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Nurse Worklist          │
│                              │
│  Risk sorting                │
│  Full transcript             │
│  Source-linked briefing      │
│  Audit trail                 │
└──────────────┬───────────────┘
               │
               │ Escalation
               ▼
┌──────────────────────────────┐
│       Callsign Gate          │
│                              │
│  Identity                    │
│  Certificate                 │
│  Transparency log            │
│  Signature                   │
│  Provider policy             │
│  Content verification        │
└──────────────┬───────────────┘
               │
               ▼
            Provider
```

The core design principle is simple:

> **AI helps understand the conversation. Deterministic server rules control safety-critical decisions.**

---

## Core Features

### Bilingual Conversational Check-In

Patients can complete the intake naturally in **English or Spanish**.

Aftercare supports:

* Live ElevenLabs voice conversations
* Browser-based voice simulation
* Text conversations
* Live nurse handoff

The patient's original words remain available to the care team throughout the workflow.

---

### Deterministic Safety Routing

Urgency is determined by a server-side rules engine before any language model is consulted.

```text
Emergency language       → Immediate emergency pathway
Wound concerns           → Urgent review
Medication concerns      → Urgent review
Practical barriers       → Review
Patient uncertainty      → Review
Routine response         → Continue intake
```

Emergency language immediately interrupts the normal questionnaire and activates the emergency pathway.

This creates a clear separation between:

**AI for language understanding**

and

**deterministic logic for safety-critical workflow control**

---

## Adaptive AI Clarification

Patients rarely answer medical questions in perfectly structured sentences.

They say things like:

> "It's kind of warm, but I think it's probably okay."

When the rules engine cannot confidently interpret a response, Gemini can rephrase the current question to make it easier for the patient to answer.

The clarification system is tightly bounded.

The model can clarify the current question while the server continues to control:

* Questionnaire progression
* Urgency
* Patient disposition
* Session completion
* Escalation

This creates natural conversation while keeping the safety-critical workflow under deterministic server control.

---

## Source-Linked Clinical Briefing

Aftercare converts the patient conversation into a concise briefing for the care team.

Every generated statement is linked back to the transcript evidence supporting it.

```text
Patient:
"The incision looks more red today and it feels warmer."

Briefing:
"Increased redness and warmth around the incision were reported."

Source:
Transcript lines 18–19
```

The clinician can move directly from a generated summary to the patient's original statement.

```text
Patient Statement
       ↓
Transcript
       ↓
Generated Briefing
       ↓
Source Citation
       ↓
Clinician Review
```

Automated summaries and nurse-authored notes are stored separately with distinct attribution.

This preserves the origin of every piece of information.

---

## Risk-Sorted Nurse Worklist

Aftercare is built around the clinician workflow, not just the patient conversation.

The nurse dashboard converts an entire patient cohort into a prioritized worklist.

Each case can include:

* Risk level
* Full patient transcript
* Detected concerns
* Automated briefing
* Supporting transcript evidence
* Nurse notes
* Conversation history
* Escalation status
* Live handoff controls
* Audit history

Instead of treating every follow-up equally, the care team can immediately focus on patients requiring attention.

---

## Self-Initiating Outreach

Aftercare can automatically create follow-up outreach.

On **day 3 after discharge**, if no contact has been recorded, the server creates a patient invitation.

Each invitation contains a scoped patient token:

```text
/c/<token>
```

That route opens only the patient's individual check-in experience.

The system separates three different interfaces:

| Route        | User      | Purpose                              |
| ------------ | --------- | ------------------------------------ |
| `/c/<token>` | Patient   | Individual check-in                  |
| `/nurse`     | Care team | Worklist, briefing, handoff, actions |
| `/provider`  | Provider  | Verified escalated cases             |

This keeps patient, nurse, and provider workflows separated while connecting them through one system.

---

## Live Nurse Handoff

A patient can request to speak directly with a care-team member during the check-in.

When that happens, available nurse dashboards receive the request.

The handoff system includes:

* Atomic nurse acceptance
* Room-scoped join tokens
* 10-minute token expiration
* Real-time dashboard updates
* Participant-state tracking

A call is reported as live only after both participants have successfully joined.

This turns Aftercare from a passive questionnaire into a direct bridge between the patient and care team.

---

## Technical Highlight: Solving Voice Interruption

Natural voice interaction introduced an important engineering problem.

During recovery, patients may:

* Cough
* Shift in a chair
* Move their phone
* Make short background noises

Voice systems can interpret those sounds as interruptions and stop speaking unexpectedly.

Aftercare handles this with two complementary layers.

### Browser-Level Audio Gate

While the agent is speaking, the browser continues monitoring the actual microphone input.

The interruption gate opens only after approximately:

**180 ms of sustained input**

This filters many short accidental noises while remaining responsive to intentional speech.

After speech stops, the gate remains open for roughly:

**1 second**

This prevents natural gaps between words from closing the microphone too quickly.

When the system is actively listening for the patient's answer, the gate is removed so normal responses are not clipped.

---

### Agent-Level Turn Handling

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

Together, these layers create voice interaction that remains responsive while reducing accidental interruptions.

---

## Technical Highlight: Callsign

Clinical escalation introduces another challenge:

> **How does one healthcare agent verify that an escalation is actually reaching the intended provider?**

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

The provider receives both the escalation and the verification evidence associated with it.

---

## Cryptographic Identity Pipeline

```text
Care Team
    │
    │ Signed Escalation
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

The local verification environment includes:

* Private certificate authority
* X.509 identity certificates
* Merkle transparency log
* Signed checkpoints
* Request verification evidence

Verification evidence can be inspected through:

```http
GET /api/proof/<requestId>
```

---

## Security Demonstration

The Callsign interface makes the security architecture visible.

After a legitimate escalation is generated, the system can replay altered versions through the same verification pipeline.

Three built-in scenarios demonstrate different security properties:

```text
Spoofed identity
Tampered request
Replayed request
```

Each request passes through the same gate used for legitimate escalations.

The interface displays which verification step handled the request.

This turns backend security into something that can be directly observed during the demo.

---

## Model Selection Based on Measurement

Aftercare uses different models for different latency requirements.

A clarification occurs during an active voice conversation and must fit comfortably inside ElevenLabs' **10-second tool window**.

Measured performance:

| Model                                    | Measured Latency | Role                    |
| ---------------------------------------- | ---------------: | ----------------------- |
| `gemini-flash-lite-latest`               |           ~0.9 s | Real-time clarification |
| `gemini-3.6-flash`                       |         2.4–8+ s | Higher-depth processing |
| `gemini-3.6-flash` without turn deadline |         Flexible | Clinical briefing       |

Instead of using one model for every task, Aftercare selects models based on the requirements of each part of the system.

```text
Real-Time Conversation
        ↓
Low-Latency Model

Clinical Briefing
        ↓
Higher-Depth Model
```

This keeps live conversations responsive while allowing more detailed processing where latency is less constrained.

---

## Performance

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

## System Architecture

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
       └── Gemini Clarification
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
          ├── Transparency log
          ├── Signature
          ├── Replay protection
          ├── Provider policy
          └── Content screen
          │
          ▼
       Provider
```

---

## Built for Auditability

Healthcare systems need more than a final answer.

Aftercare records the path that produced it.

The audit system captures information including:

* Patient conversation
* Routing decisions
* Clarification events
* Model identity
* Model latency
* Escalation evidence
* Nurse actions
* Automated summaries
* Clinician notes
* Handoff state
* Verification results

Patient-generated, AI-generated, and clinician-generated information remain separately attributed.

---

## Safety by Design

Aftercare uses architectural boundaries to keep AI in a narrow, inspectable role.

### Rules Own Urgency

Emergency and concern routing happen through deterministic server logic.

### Models Clarify Language

AI improves conversational understanding while the server controls workflow state.

### Clinicians Retain Control

Care-team actions and case resolution remain explicit clinician actions.

### Evidence Stays Attached

Generated briefings link directly back to patient statements.

### Escalations Are Verified

Provider-bound requests pass through a cryptographic verification layer.

### Important Actions Are Auditable

State transitions and automated operations are preserved in the audit history.

---

## Testing

Run the test suite with:

```bash
npm test
npm run build
npm run test:e2e
```

### Conversation

The test suite covers:

* English and Spanish routing
* Consent
* Ambiguity
* Negation
* Repeated starts
* Adaptive clarification
* Preserved flags
* Session persistence

### Safety

* Emergency interruption
* Server timeouts
* Stale results
* Routing rules
* Recording protection
* Clinician-controlled resolution

### AI

* Clarification boundaries
* Model latency
* Source-linked briefings
* Citation validation
* Provider handling

### Handoff

* Atomic nurse claims
* Token scope
* Token signing
* Join state
* Ring timeout behavior

### Security

* ANS parsing
* Destination verification
* Replay handling
* Origin policy
* Host policy
* Rate limits

### Browser

* Live worklist updates
* Refresh recovery
* History
* Microphone handling
* Keyboard accessibility
* Mobile layout
* Text clarification
* Source links
* Handoff state

End-to-end browser tests use a separate database and local Gemini stand-in so the suite can run without consuming model quota.

---

## Getting Started

Aftercare requires:

```text
Node.js 24+
npm
```

Install dependencies:

```bash
npm install
```

Build the project:

```bash
npm run build
```

Start the application:

```bash
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

Vite runs on port `4317` and the API runs on port `4318`.

---

## Enable Live AI Features

Copy:

```text
.env.example
```

to:

```text
.env
```

Then configure the integrations you want.

| Feature                | Environment Variables                                  |
| ---------------------- | ------------------------------------------------------ |
| Adaptive clarification | `GEMINI_API_KEY`                                       |
| Text conversation      | `GEMINI_API_KEY`                                       |
| Clinical briefing      | `GEMINI_API_KEY`                                       |
| Live voice             | `ELEVENLABS_API_KEY`                                   |
| Nurse handoff          | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| Agent identity         | `ANS_API_KEY`, `ANS_CARE_TEAM_NAME`                    |

For live voice setup:

```bash
npm run voice:setup
```

The setup creates the private ElevenLabs agent and prints:

```text
ELEVENLABS_AGENT_ID
```

Add that value to your `.env` file.

---

## Project Structure

```text
Aftercare
│
├── Patient Experience
│   ├── Voice
│   ├── Text
│   └── Simulation
│
├── Care-Team Application
│   ├── Risk Worklist
│   ├── Clinical Briefing
│   ├── Nurse Actions
│   └── Live Handoff
│
├── Safety Engine
│   ├── Emergency Rules
│   ├── Concern Routing
│   ├── Negation Handling
│   └── Clarification Boundary
│
├── Callsign
│   ├── Agent Identity
│   ├── Certificates
│   ├── Transparency Log
│   ├── Signatures
│   └── Replay Protection
│
├── Audit Layer
│
└── Provider Experience
```

---

## Documentation

| Document                       | Contents                                                  |
| ------------------------------ | --------------------------------------------------------- |
| `AGENTS.md`                    | Development commands, layout, and conventions             |
| `docs/ARCHITECTURE.md`         | Data model, request flow, live updates, and run isolation |
| `docs/CALLING.md`              | Voice architecture and audio paths                        |
| `docs/INTEGRATION.md`          | Integration architecture                                  |
| `docs/INTEGRATION-CALLSIGN.md` | Callsign verification system                              |
| `HANDOFF.md`                   | Implementation and verification notes                     |
| `deploy/README.md`             | Infrastructure and deployment                             |

The local API contains **27 documented endpoints**.

---

## The Bigger Idea

Many healthcare AI systems start with:

> **What can an AI model automate?**

Aftercare starts with a different question:

> **Where can intelligence reduce friction while preserving control, evidence, and accountability?**

The result is more than a chatbot.

It is a complete post-discharge workflow.

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

Every step between them remains inspectable.

---

## Team

**[Team Member]** — [GitHub] · [LinkedIn]
**[Team Member]** — [GitHub] · [LinkedIn]
**[Team Member]** — [GitHub] · [LinkedIn]

---

## License

MIT License

---

<p align="center">
  <strong>Aftercare</strong>
  <br>
  Post-discharge follow-up that reaches out first.
  <br><br>
  <strong>Built at VT Hacks 14</strong>
</p>
