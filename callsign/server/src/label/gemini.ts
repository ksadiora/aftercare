import type { LabelLookupResponse } from "@callsign/shared";
import { config } from "../config.ts";
import type { STELAZIO_LABEL } from "./stelazio.ts";

/**
 * GEMINI LABEL Q&A  (owner: Story lane)
 *
 * Google AI Studio REST API, no SDK:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=...
 *
 * Rules the prompt enforces: answer only from the label text supplied, under
 * two sentences, safe for a voice agent to read aloud, cite the section
 * number, and if the label does not cover it say so with the standard line.
 * The model is asked for JSON ({found, answer, citation, section}) and the
 * reply is parsed defensively. Any failure (no key, timeout, bad JSON,
 * hallucinated section) falls back to the keyword lookup so the voice tool
 * never breaks mid-call.
 *
 * Model id confirmed against https://ai.google.dev/gemini-api/docs/models on
 * 2026-09-17: `gemini-3.8-flash` is the current recommended fast model;
 * `gemini-2.5-flash` (the config.ts default) is still served.
 */
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
export const GEMINI_TIMEOUT_MS = 8_000;

export const NOT_COVERED_ANSWER =
  "That isn't covered in the current label. I can send you the full prescribing information.";

type Label = typeof STELAZIO_LABEL;

export async function labelLookupGemini(question: string, label: Label): Promise<LabelLookupResponse> {
  const q = (question ?? "").trim();
  if (!q) return { found: false, answer: NOT_COVERED_ANSWER };
  if (!config.llm.geminiApiKey) return labelLookupKeyword(q, label);

  try {
    const raw = await geminiGenerate({
      system: labelSystemPrompt(label),
      user: `Question from the physician: "${q}"`,
      json: true,
      timeoutMs: GEMINI_TIMEOUT_MS,
      maxOutputTokens: 512,
    });
    const parsed = parseLookup(raw, label);
    if (parsed) return parsed;
    console.warn("[gemini] label_lookup: unusable reply, falling back to keyword lookup");
  } catch (e) {
    console.warn("[gemini] label_lookup failed, falling back to keyword lookup:", (e as Error).message);
  }
  return labelLookupKeyword(q, label);
}

// ---------------------------------------------------------------------------
// Prompt + parsing
// ---------------------------------------------------------------------------

function labelSystemPrompt(label: Label): string {
  const sections = label.sections.map((s) => `[Section ${s.number}] ${s.title}\n${s.text}`).join("\n\n");
  return [
    `You are the label-lookup tool for a pharmaceutical voice agent that is on a phone call with a physician.`,
    `You answer ONLY from the prescribing information below for ${label.product} (${label.generic}), last updated ${label.updated}.`,
    ``,
    `Rules:`,
    `1. Use only facts stated in the label text. Never add outside medical knowledge, never give clinical advice, never speculate.`,
    `2. Answer in at most two short sentences of plain spoken English. No markdown, no bullet points, no abbreviations the doctor would not say aloud (write "eGFR" and "mg" as-is; they are spoken).`,
    `3. Always cite the section you used by its number.`,
    `4. If the label does not cover the question, set found to false and use exactly this answer: "${NOT_COVERED_ANSWER}"`,
    `5. Reply with a single JSON object and nothing else, in this shape:`,
    `   {"found": true|false, "answer": "<spoken answer>", "section": "<section number or empty>", "citation": "${label.product} prescribing information, section <number>"}`,
    ``,
    `PRESCRIBING INFORMATION:`,
    sections,
  ].join("\n");
}

function parseLookup(raw: string, label: Label): LabelLookupResponse | undefined {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;

  const found = typeof o.found === "boolean" ? o.found : undefined;
  let answer = typeof o.answer === "string" ? cleanSpoken(o.answer) : "";
  if (found === undefined || !answer) return undefined;

  if (!found) return { found: false, answer: NOT_COVERED_ANSWER };

  // Only accept a section number that really exists in the label.
  const sectionRaw = typeof o.section === "string" ? o.section : typeof o.section === "number" ? String(o.section) : "";
  const citationRaw = typeof o.citation === "string" ? o.citation : "";
  const known = new Set(label.sections.map((s) => s.number));
  let section = sectionRaw.trim().replace(/^section\s*/i, "");
  if (!known.has(section)) {
    const m = citationRaw.match(/section\s+([\d.]+)/i);
    section = m && known.has(m[1]) ? m[1] : "";
  }
  if (!section) return undefined; // found=true without a real section is not trustworthy

  answer = limitSentences(answer, 2);
  return { found: true, answer, citation: `${label.product} prescribing information, section ${section}` };
}

/** Pull the first JSON object out of a reply that may be wrapped in prose or a code fence. */
export function extractJson(raw: string): unknown {
  if (!raw) return undefined;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** Strip markdown and stray whitespace so the line is safe to hand to text-to-speech. */
export function cleanSpoken(s: string): string {
  return s
    .replace(/[*_`#>]+/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function limitSentences(s: string, max: number): string {
  const parts = s.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [s];
  return parts.slice(0, max).join("").trim();
}

// ---------------------------------------------------------------------------
// Keyword fallback: the same behaviour as the mock in label/index.ts, kept
// local so this module never depends on the mock path or the mode switch.
// ---------------------------------------------------------------------------

export function labelLookupKeyword(question: string, label: Label): LabelLookupResponse {
  const q = question.toLowerCase();
  const words = q.split(/\W+/).filter((w) => w.length > 3);
  let best: { score: number; section: Label["sections"][number] } | undefined;
  for (const section of label.sections) {
    const hay = `${section.title} ${section.text}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    if (!best || score > best.score) best = { score, section };
  }
  if (!best || best.score === 0) return { found: false, answer: NOT_COVERED_ANSWER };
  const firstSentence = best.section.text.split(/(?<=\.)\s/)[0];
  return {
    found: true,
    answer: firstSentence,
    citation: `${label.product} prescribing information, section ${best.section.number}`,
  };
}

// ---------------------------------------------------------------------------
// Thin REST client. Shared with negotiate/ for phrasing transcript lines.
// ---------------------------------------------------------------------------

export interface GeminiGenerateOptions {
  system?: string;
  user: string;
  /** Ask for application/json output. */
  json?: boolean;
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
}

/** Returns the text of the first candidate. Throws on any transport, HTTP, timeout or shape error. */
export async function geminiGenerate(opts: GeminiGenerateOptions): Promise<string> {
  const key = config.llm.geminiApiKey;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = opts.model || config.llm.geminiModel || GEMINI_DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens ?? 512,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Gemini HTTP ${res.status} ${detail}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked prompt: ${data.promptFeedback.blockReason}`);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) throw new Error(`Gemini returned no text (finishReason=${data.candidates?.[0]?.finishReason ?? "none"})`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
