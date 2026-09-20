/**
 * Content screening for an authorized care-team escalation.
 *
 * Adapted from Callsign's caller screener. Identity, tamper and replay checks
 * stay strict (pipeline.ts); the content rules here are for a message the
 * verified care-team service sends a provider about a case, so they differ from
 * screening an unknown caller:
 *  - requests for secrets, unsafe payments, remote access or attempts to bypass
 *    screening are blocked, as before;
 *  - patient details and clinical language are expected, not suspicious;
 *  - pressure language is surfaced as a warning for the provider to see, never a
 *    reason to hold a clinical escalation.
 * Local rules only: deterministic, explainable, and available without a key.
 */
export interface ScreeningSignal { label: string; detail: string; quote?: string; severity: "neutral" | "warning" | "danger" }
export interface ScreeningAssessment { decision: "allow" | "block"; risk: "low" | "medium" | "high"; summary: string; signals: ScreeningSignal[]; source: "local" }

const dangerRules: Array<{ label: string; detail: string; pattern: RegExp }> = [
  {
    label: "Credential request",
    detail: "The message asks for a secret or access credential. An escalation never needs one.",
    pattern: /(?:send|share|give|provide|tell|confirm|read|enter|need|want|verify|disclose|forward|your)\b.{0,85}\b(?:password|passcode|one[ -]?time (?:code|password)|(?:six|6)[ -]?digit code|verification code|security code|login code|login credentials|otp|2fa code|mfa code|social security|ssn|bank details|credit card|card number)|\b(?:password|passcode|one[ -]?time code|verification code|otp|2fa code|mfa code)\b.{0,65}\b(?:send|share|give|provide|read|enter)/i,
  },
  {
    label: "High-risk payment request",
    detail: "The message requests money through a commonly abused transfer method.",
    pattern: /\b(?:wire|transfer|send|pay|buy|purchase|deposit)\b.{0,85}\b(?:money|funds|bitcoin|crypto|gift cards?|giftcards?|wallet|bank account)|\b(?:gift cards?|giftcards?|bitcoin|crypto(?:currency)?)\b.{0,65}\b(?:payment|pay|send|purchase|buy)/i,
  },
  {
    label: "Remote access request",
    detail: "The message asks to install remote-control software or grant device access.",
    pattern: /\b(?:install|download|open|run|enable|grant|give)\b.{0,65}\b(?:anydesk|teamviewer|remote access|remote desktop|remote control)|\b(?:remote access|remote control)\b.{0,65}\b(?:computer|device|system)/i,
  },
  {
    label: "Attempt to bypass screening",
    detail: "The message tries to override the screening rules rather than state a clinical reason.",
    pattern: /\b(?:ignore|disregard|override|forget)\b.{0,65}\b(?:instructions?|rules?|screening|prompt|policy)|\b(?:mark|classify|set|output|return)\b.{0,45}\b(?:low[ -]risk|decision.{0,10}allow|verified|trusted)|\b(?:bypass|disable)\b.{0,35}\b(?:screening|security|checks?|agent)/i,
  },
].map((rule) => ({ ...rule, pattern: new RegExp(rule.pattern.source, "is") }));

const unsafeLink = /(?:https?:\/\/|www\.)\S+/i;
const credentialContext = /\b(?:log[ -]?in|sign[ -]?in|verify your|verification|payment|bank|credential)\b/i;
const pressure = /\b(?:final warning|legal action|suspend|arrest|do not tell|don't tell)\b/i;

function excerpt(text: string, match: RegExpMatchArray): string {
  const start = Math.max(0, (match.index ?? 0) - 20);
  return text.slice(start, Math.min(text.length, start + 220));
}

export function screenEscalation(text: string): ScreeningAssessment {
  const signals: ScreeningSignal[] = [];
  for (const rule of dangerRules) {
    const match = text.match(rule.pattern);
    if (match) signals.push({ label: rule.label, detail: rule.detail, severity: "danger", quote: excerpt(text, match) });
  }
  const link = text.match(unsafeLink);
  if (link && credentialContext.test(text)) signals.push({ label: "Unverified account link", detail: "A link is paired with a login, verification or payment request. The destination has not been verified.", severity: "danger", quote: excerpt(text, link) });
  if (signals.length) {
    return { decision: "block", risk: "high", summary: "The escalation text contains a high-risk request. It was not delivered; the case stays with the nurse.", signals, source: "local" };
  }
  const pressured = text.match(pressure);
  if (pressured) signals.push({ label: "Pressure language", detail: "Coercive wording is unusual in a clinical escalation. Delivered, and flagged for the provider.", severity: "warning", quote: excerpt(text, pressured) });
  signals.push({ label: "Care-team escalation", detail: "A signed escalation from the verified care-team service about an open case. Clinical content is expected here.", severity: "neutral" });
  return { decision: "allow", risk: pressured ? "medium" : "low", summary: pressured ? "Delivered with a warning: the text uses pressure language." : "The escalation content is suitable to deliver to the provider.", signals, source: "local" };
}
