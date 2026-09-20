import type {
  Negotiation,
  NegotiationEvent,
  NegotiationKind,
  NegotiationPhase,
  RequestSamplesResponse,
} from "@callsign/shared";
import { id, nowIso } from "../events.ts";
import { doctor, brandIdentity, hcpIdentity } from "../seed/data.ts";
import { audit, upsertNegotiation, activeCall } from "../store.ts";
import { sha256, signAs } from "../verify/sign.ts";
import { config, effectiveModes } from "../config.ts";
import { checkEligibility, lookupLicense, MAX_CARTONS_PER_REQUEST, type EligibilityCheck, type LicenseCheck } from "./registry.ts";

/**
 * AGENT-TO-AGENT NEGOTIATION  (owner: Story lane, signing from Identity lane)
 *
 * The doctor's agent and the brand agent run a short signed exchange:
 *   verify_peer -> check_license -> check_eligibility -> propose -> agree -> sign -> done
 * Each phase pushes an event so the screen shows the transcript live. The
 * whole thing finishes in under 5 seconds so it lands while the call is
 * still going (3.4 s of phase timing, plus at most 1.2 s waiting on Gemini).
 *
 * Facts are always decided deterministically here: what the doctor asked for
 * (parseTerms / inferKind), the license lookup and PDMA eligibility
 * (registry.ts), the terms hash and both signatures (verify/sign.ts). When
 * LLM_MODE=real, Gemini only rephrases the human-readable transcript lines
 * from those facts; the deterministic lines are the fallback. The
 * confirmation sentence the voice agent reads back is never LLM-written.
 *
 * Failure path: a license that is not active (see registry.ts) fails at
 * check_license; a prescriber inside the 30-day sample cooldown fails at
 * check_eligibility. Both end with status "failed" and a readable
 * confirmation. Mention a license number in the request to pick a record:
 *   "send two boxes next Friday, license 0101-777120"   -> expired -> failed
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function requestSamplesFromCall(requestText: string, callId?: string): Promise<RequestSamplesResponse> {
  const text = (requestText ?? "").trim() || "samples";
  const n = await negotiate(inferKind(text), text, callId ?? activeCall()?.id);
  return {
    confirmation: n.confirmation ?? "The request could not be completed.",
    negotiationId: n.id,
    status: n.status === "agreed" ? "agreed" : "failed",
  };
}

export async function negotiate(kind: NegotiationKind, requestText: string, callId?: string): Promise<Negotiation> {
  const terms = parseTerms(requestText, kind);
  const n: Negotiation = {
    id: id("neg"),
    kind,
    callId,
    requestText,
    terms,
    events: [],
    status: "running",
    startedAt: nowIso(),
  };
  upsertNegotiation(n);
  audit("negotiation", `Negotiation started: ${kind} · "${requestText}"`, n.id);

  const push = (phase: NegotiationPhase, actor: NegotiationEvent["actor"], text: string, sign?: string) => {
    const ev: NegotiationEvent = { phase, actor, text, ts: nowIso() };
    if (sign) ev.signature = signAs(sign, text);
    n.events.push(ev);
    upsertNegotiation({ ...n, events: [...n.events] });
  };

  const fail = (phase: NegotiationPhase, confirmation: string) => {
    n.status = "failed";
    n.confirmation = confirmation;
    n.finishedAt = nowIso();
    push("failed", "system", confirmation);
    audit("negotiation", `Failed at ${phase}: ${confirmation}`, n.id);
    return n;
  };

  // ---- Facts first, then words -------------------------------------------
  const licenseNumber = terms.license || doctor.licenseNumber;
  const license = lookupLicense(licenseNumber, doctor.state);
  const cartons = Number(terms.cartonsRequested || "1");
  const eligibility = license.record ? checkEligibility(license.record, kind, cartons) : undefined;
  const facts: Facts = { kind, terms, licenseNumber, license, eligibility };
  const fallback = deterministicLines(facts);
  const lines = effectiveModes().llm === "real" ? await phraseWithGemini(facts, fallback) : fallback;

  // ---- Phases --------------------------------------------------------------
  push("verify_peer", "hcp", lines.verify_hcp, config.hcpAgentName);
  await sleep(500);
  push("verify_peer", "brand", lines.verify_brand, config.brandAgentName);
  await sleep(500);
  push("check_license", "brand", lines.license, config.brandAgentName);
  await sleep(600);
  if (!license.ok || !license.record || !eligibility) {
    return fail(
      "check_license",
      `I can't complete that ${describeKind(kind)}: the ${doctor.state} license on file for ${license.record?.name ?? doctor.name} ${license.detail}. I've flagged it for a human representative to follow up.`,
    );
  }

  push("check_eligibility", "brand", lines.eligibility, config.brandAgentName);
  await sleep(600);
  if (!eligibility.ok) {
    return fail(
      "check_eligibility",
      `I can't complete that ${describeKind(kind)} today: ${eligibility.detail}. I've noted the request for a human representative.`,
    );
  }

  push("propose", "brand", lines.propose, config.brandAgentName);
  await sleep(500);
  push("agree", "hcp", lines.agree, config.hcpAgentName);
  await sleep(400);

  const termsHash = sha256(JSON.stringify(n.terms));
  n.receipt = {
    hash: termsHash,
    hcpSignature: signAs(config.hcpAgentName, termsHash),
    brandSignature: signAs(config.brandAgentName, termsHash),
    signedAt: nowIso(),
  };
  push("sign", "system", `Both agents signed terms ${termsHash.slice(0, 12)}…`);
  await sleep(300);

  n.status = "agreed";
  n.confirmation = confirmationFor(kind, terms);
  n.finishedAt = nowIso();
  push("done", "system", n.confirmation);
  audit("negotiation", `Agreed and signed: ${n.confirmation}`, n.id, n.receipt);
  return n;
}

// ---------------------------------------------------------------------------
// Understanding what the doctor said
// ---------------------------------------------------------------------------

const SAMPLE_WORDS = /\b(samples?|boxes|box|cartons?|packs?|starter)\b/;
const REP_WORDS = /\b(rep|reps|representative|visit|come by|stop by|swing by|drop by|in person|in-person|lunch|office visit)\b/;
const FOLLOWUP_WORDS =
  /\b(follow[\s-]?up|call (me )?back|callback|ring (me )?back|reach out|check (back )?in|circle back|touch base|email me|send (me )?(the|an?) (full )?(label|pdf|prescribing|information|details|inbox))\b/;

/** Pick the negotiation kind from the doctor's words. Samples win when named; otherwise a rep visit, then a follow-up. */
export function inferKind(text: string): NegotiationKind {
  const t = (text ?? "").toLowerCase();
  if (SAMPLE_WORDS.test(t)) return "samples";
  if (REP_WORDS.test(t)) return "rep_visit";
  if (FOLLOWUP_WORDS.test(t)) return "followup";
  return "samples";
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, three: 3, few: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
};

export function parseTerms(text: string, kind: NegotiationKind = inferKind(text)): Record<string, string> {
  const t = (text ?? "").toLowerCase();
  const when = parseWhen(t, kind);
  const license = t.match(/\b(\d{4}-\d{4,6})\b/)?.[1];

  const base: Record<string, string> = { requestedBy: doctor.name };
  if (license) base.license = license;

  if (kind === "samples") {
    const requested = parseCartons(t);
    const cartons = Math.min(requested, MAX_CARTONS_PER_REQUEST);
    return {
      product: "Stelazio 5 mg",
      quantity: `${cartons} starter ${cartons === 1 ? "carton" : "cartons"} of 14 tablets`,
      cartonsRequested: String(requested),
      deliverBy: when,
      shipTo: hcpIdentity.organization,
      ...base,
    };
  }
  if (kind === "rep_visit") {
    return {
      purpose: "In-person visit to review the Stelazio renal dosing update",
      when,
      location: hcpIdentity.organization,
      ...base,
    };
  }
  const channel = /\b(email|inbox|send|pdf|label)\b/.test(t) ? "secure inbox" : "phone";
  return {
    topic: "Stelazio renal dosing update (section 2.3)",
    when,
    channel,
    ...base,
  };
}

function parseCartons(t: string): number {
  const m = t.match(/\b(\d+|a couple of|a few|a|an|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\s+(?:more\s+)?(?:sample\s+)?(boxes|box|cartons?|packs?|samples?)\b/);
  if (!m) return MAX_CARTONS_PER_REQUEST;
  const word = m[1].replace(/^a (couple of|few)$/, "$1");
  const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
  return n && n > 0 ? n : MAX_CARTONS_PER_REQUEST;
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function parseWhen(t: string, kind: NegotiationKind): string {
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const day = DAYS.find((d) => t.includes(d));
  const part = t.match(/\b(morning|afternoon|evening|lunchtime|noon)\b/)?.[1];
  if (day) {
    const next = new RegExp(`\\bnext\\s+${day}\\b`).test(t) ? "next " : "";
    return `${next}${cap(day)}${part ? ` ${part}` : ""}`;
  }
  if (/\b(today|asap|right away|as soon as possible|immediately)\b/.test(t)) return part ? `today ${part}` : "today";
  if (/\btomorrow\b/.test(t)) return part ? `tomorrow ${part}` : "tomorrow";
  if (/\bnext week\b/.test(t)) return "next week";
  if (/\b(this|end of the|end of) week\b/.test(t)) return "by the end of the week";
  if (/\bnext month\b/.test(t)) return "next month";
  if (/\bin (\w+) (days?|weeks?)\b/.test(t)) {
    const m = t.match(/\bin (\w+) (days?|weeks?)\b/)!;
    return `in ${m[1]} ${m[2]}`;
  }
  if (kind === "samples") return "next business day";
  if (kind === "rep_visit") return "next week";
  return "within two business days";
}

function describeKind(kind: NegotiationKind) {
  return kind === "samples" ? "sample request" : kind === "rep_visit" ? "visit request" : "follow-up request";
}

function confirmationFor(kind: NegotiationKind, terms: Record<string, string>): string {
  if (kind === "samples") {
    const capped =
      Number(terms.cartonsRequested) > MAX_CARTONS_PER_REQUEST ? ` That's the label's limit of ${MAX_CARTONS_PER_REQUEST} cartons per request.` : "";
    return `Confirmed: ${terms.quantity} of ${terms.product} arriving ${terms.deliverBy} at ${terms.shipTo}, signed by both agents.${capped}`;
  }
  if (kind === "rep_visit") {
    return `Confirmed: a ${brandIdentity.displayName} representative will visit ${terms.location} ${terms.when}, signed by both agents.`;
  }
  return `Confirmed: ${brandIdentity.displayName} will follow up by ${terms.channel} ${terms.when} about the ${terms.topic}, signed by both agents.`;
}

// ---------------------------------------------------------------------------
// Transcript lines: deterministic, optionally rephrased by Gemini
// ---------------------------------------------------------------------------

interface Facts {
  kind: NegotiationKind;
  terms: Record<string, string>;
  licenseNumber: string;
  license: LicenseCheck;
  eligibility?: EligibilityCheck;
}

type LineKey = "verify_hcp" | "verify_brand" | "license" | "eligibility" | "propose" | "agree";
type Lines = Record<LineKey, string>;

function deterministicLines(f: Facts): Lines {
  const { terms, kind } = f;
  const propose =
    kind === "samples"
      ? `Proposal: ${terms.quantity} of ${terms.product}, delivered by ${terms.deliverBy} to ${terms.shipTo}.`
      : kind === "rep_visit"
        ? `Proposal: a ${brandIdentity.displayName} representative visits ${terms.location} ${terms.when} to review the renal dosing update.`
        : `Proposal: ${brandIdentity.displayName} follows up by ${terms.channel} ${terms.when} about the ${terms.topic}.`;
  return {
    verify_hcp: `Verifying ${brandIdentity.name} before sharing prescriber details.`,
    verify_brand: `Verifying ${config.hcpAgentName}. Certificate and log receipt valid.`,
    license: `${doctor.state} license ${f.licenseNumber} for ${f.license.record?.name ?? doctor.name} ${f.license.detail}.`,
    eligibility: f.eligibility
      ? f.eligibility.ok
        ? `${kind === "samples" ? "Sample eligibility under PDMA" : "Eligibility"}: ${f.eligibility.detail}.`
        : `${kind === "samples" ? "Sample eligibility under PDMA" : "Eligibility"} failed: ${f.eligibility.detail}.`
      : `Eligibility not checked: license lookup failed.`,
    propose,
    agree: `Accepted on behalf of ${doctor.name}.`,
  };
}

const PHRASE_TIMEOUT_MS = 1_200;

/** Ask Gemini to rephrase the lines from the facts. Never decides anything; any problem returns the fallback. */
async function phraseWithGemini(facts: Facts, fallback: Lines): Promise<Lines> {
  try {
    const { geminiGenerate, extractJson, cleanSpoken } = await import("../label/gemini.ts");
    const system = [
      "You write one-line transcript entries for a signed agent-to-agent negotiation log shown live on a screen.",
      "You receive structured FACTS and a DRAFT for each line. Rephrase each draft so it reads naturally to a physician, in plain English, at most 22 words, no markdown.",
      "You must not add, remove, soften or change any fact: keep every number, name, date, license number, quantity, status word (active, expired, suspended, failed) and product name exactly as given.",
      "Reply with a single JSON object whose keys are exactly the draft keys and whose values are the rephrased lines.",
    ].join("\n");
    const user = JSON.stringify({ FACTS: facts, DRAFT: fallback });
    const raw = await geminiGenerate({ system, user, json: true, timeoutMs: PHRASE_TIMEOUT_MS, maxOutputTokens: 600, temperature: 0.4 });
    const obj = extractJson(raw) as Record<string, unknown> | undefined;
    if (!obj || typeof obj !== "object") return fallback;
    const out: Lines = { ...fallback };
    for (const key of Object.keys(fallback) as LineKey[]) {
      const v = obj[key];
      if (typeof v !== "string") continue;
      const line = cleanSpoken(v);
      if (!line || line.length > 240) continue;
      if (!keepsFacts(key, line, facts)) continue;
      out[key] = line;
    }
    return out;
  } catch (e) {
    console.warn("[negotiate] Gemini phrasing unavailable, using deterministic lines:", (e as Error).message);
    return fallback;
  }
}

/** Cheap guard: the rephrased line must still carry the load-bearing tokens of its fact. */
function keepsFacts(key: LineKey, line: string, f: Facts): boolean {
  const l = line.toLowerCase();
  switch (key) {
    case "license":
      return (
        l.includes(f.licenseNumber.toLowerCase()) &&
        (f.license.ok ? l.includes("active") : /\b(expired|suspended|not on file|not \w+)\b/.test(l))
      );
    case "eligibility":
      return f.eligibility ? (f.eligibility.ok ? !/\b(fail|denied|not eligible)\b/.test(l) : /\b(fail|denied|not eligible|not allowed|can't|cannot)\b/.test(l)) : true;
    case "propose":
      return f.kind === "samples" ? l.includes(f.terms.quantity.toLowerCase()) && l.includes(f.terms.deliverBy.toLowerCase()) : l.includes(f.terms.when.toLowerCase());
    case "verify_hcp":
      return l.includes(brandIdentity.name.toLowerCase());
    case "verify_brand":
      return l.includes(config.hcpAgentName.toLowerCase());
    case "agree":
      return l.includes(doctor.name.toLowerCase()) && !/\b(reject|declin)/.test(l);
    default:
      return true;
  }
}
