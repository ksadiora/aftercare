import type { LabelLookupResponse } from "@callsign/shared";
import { effectiveModes } from "../config.ts";
import { STELAZIO_LABEL } from "./stelazio.ts";

/**
 * LABEL LOOKUP  (owner: Story lane)
 *
 * Answers a doctor's question strictly from the brand's published label.
 * Mock: keyword match over label sections. Real: Gemini with the label as
 * context and a prompt that forbids anything not in the text. Keep the
 * export signature; the voice agent's label_lookup tool calls this.
 */
export async function labelLookup(question: string): Promise<LabelLookupResponse> {
  if (effectiveModes().llm === "real") {
    const { labelLookupGemini } = await import("./gemini.ts");
    return labelLookupGemini(question, STELAZIO_LABEL);
  }
  return labelLookupMock(question);
}

function labelLookupMock(question: string): LabelLookupResponse {
  const q = question.toLowerCase();
  const words = q.split(/\W+/).filter((w) => w.length > 3);
  let best: { score: number; section: (typeof STELAZIO_LABEL.sections)[number] } | undefined;
  for (const section of STELAZIO_LABEL.sections) {
    const hay = `${section.title} ${section.text}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    if (!best || score > best.score) best = { score, section };
  }
  if (!best || best.score === 0) {
    return { found: false, answer: "That isn't covered in the current label. I can send you the full prescribing information." };
  }
  const firstSentence = best.section.text.split(/(?<=\.)\s/)[0];
  return {
    found: true,
    answer: firstSentence,
    citation: `${STELAZIO_LABEL.product} prescribing information, section ${best.section.number}`,
  };
}
