import { config } from "../config.ts";
import { STELAZIO_LABEL } from "../label/stelazio.ts";
import { requestSamplesFromCall } from "../negotiate/index.ts";
import { doctor } from "../seed/data.ts";
import type { CallVariables } from "./provider.ts";
import type { Turn } from "./dialogue.ts";

/**
 * GEMINI CONVERSATION  (LLM_MODE=real)
 *
 * The brand agent on the call is a Gemini model with the full prescribing
 * label as grounding, a per-call conversation history, and two tools it can
 * call mid-sentence: request_samples (runs the real agent-to-agent
 * negotiation) and end_call. Function calling per
 * https://ai.google.dev/gemini-api/docs/function-calling. Never throws:
 * any failure returns undefined and the caller falls back to the keyword brain.
 */

type Part =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };
type Content = { role: "user" | "model"; parts: Part[] };

const histories = new Map<string, Content[]>();
const MAX_HISTORY = 24;

export function resetConversation(callId: string) {
  histories.delete(callId);
}

function systemPrompt(v: CallVariables): string {
  const label = STELAZIO_LABEL.sections.map((s) => `[${s.number}] ${s.title}: ${s.text}`).join("\n");
  return `You are the verified ${v.brand} agent on a live voice call with ${v.doctor_name}, a ${v.specialty.toLowerCase()} physician. You reached her through Callsign: her own agent already verified your identity through the Agent Name Service (domain-anchored certificate and a public transparency-log receipt) before this call connected.

Why you called: ${v.update_summary} ${v.affected_patients} of her patients are affected.

HOW TO SPEAK
- This is spoken aloud by text-to-speech. One or two short sentences per turn. No lists, no markdown, no emojis, no headings.
- Be warm, direct, and quick. She is between patients.
- Say numbers and units plainly ("5 milligrams once daily", "e G F R below 45").

WHAT YOU MAY SAY ABOUT THE DRUG
- Only what is in the prescribing information below. Cite the section in words ("that's section 2.3").
- If it isn't in the label, say so and offer to send the full prescribing information to her inbox.
- Never give clinical advice or tell her what to do for a specific patient; you can state what the label says.

TOOLS
- When she asks for samples, cartons, boxes, a rep visit, a follow-up, or a call back, call request_samples with her words. Then read the confirmation back in one sentence.
- When the conversation is done (she says thanks, bye, not interested, send it to my inbox, or has nothing else), say a one-sentence goodbye and call end_call.
- If she asks who you are or whether you're real, explain the verification in one sentence and offer the one-line change.

PRESCRIBING INFORMATION (${STELAZIO_LABEL.product}, ${STELAZIO_LABEL.generic}, updated ${STELAZIO_LABEL.updated})
${label}

Doctor on file: ${doctor.name}, ${doctor.specialty}, ${doctor.state} license ${doctor.licenseNumber}.`;
}

const tools = [
  {
    functionDeclarations: [
      {
        name: "request_samples",
        description: "Request product samples, a rep visit, or a follow-up for the doctor. Runs the signed agent-to-agent negotiation and returns a confirmation sentence to read back.",
        parameters: {
          type: "object",
          properties: { request: { type: "string", description: "What the doctor asked for, in her words, e.g. 'two boxes next Friday'" } },
          required: ["request"],
        },
      },
      {
        name: "end_call",
        description: "Hang up after your goodbye sentence. Call this when the doctor is done.",
        parameters: { type: "object", properties: { reason: { type: "string" } } },
      },
    ],
  },
];

export async function geminiRespond(callId: string, vars: CallVariables, heard: string, opening?: string): Promise<Turn | undefined> {
  const key = config.llm.geminiApiKey;
  if (!key) return undefined;
  const model = config.llm.geminiModel || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  let history = histories.get(callId);
  if (!history) {
    history = [];
    if (opening) history.push({ role: "model", parts: [{ text: opening }] });
    histories.set(callId, history);
  }
  history.push({ role: "user", parts: [{ text: heard || "(silence)" }] });

  let end = false;
  let spoken = "";

  try {
    for (let hop = 0; hop < 3; hop++) {
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt(vars) }] },
        contents: history.slice(-MAX_HISTORY),
        tools,
        generationConfig: { temperature: 0.4, maxOutputTokens: 200 },
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9_000);
      let data: { candidates?: { content?: Content; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      if (data.promptFeedback?.blockReason) throw new Error(`blocked: ${data.promptFeedback.blockReason}`);
      const content = data.candidates?.[0]?.content;
      if (!content?.parts?.length) throw new Error("empty candidate");
      history.push({ role: "model", parts: content.parts });

      const calls = content.parts.filter((p): p is Extract<Part, { functionCall: unknown }> => "functionCall" in p);
      const texts = content.parts.filter((p): p is { text: string } => "text" in p && Boolean(p.text?.trim())).map((p) => p.text.trim());
      if (texts.length) spoken = [spoken, ...texts].filter(Boolean).join(" ");

      if (!calls.length) break;

      const responses: Part[] = [];
      for (const c of calls) {
        const name = c.functionCall.name;
        const args = c.functionCall.args ?? {};
        if (name === "request_samples") {
          const out = await requestSamplesFromCall(String(args.request ?? heard), callId);
          responses.push({ functionResponse: { name, response: { confirmation: out.confirmation, status: out.status } } });
        } else if (name === "end_call") {
          end = true;
          responses.push({ functionResponse: { name, response: { ok: true } } });
        } else {
          responses.push({ functionResponse: { name, response: { error: "unknown tool" } } });
        }
      }
      history.push({ role: "user", parts: responses });
      if (end && spoken) break; // goodbye already said
    }
  } catch (e) {
    console.warn("[gemini-dialogue]", (e as Error).message);
    // Drop the failed user turn so a retry does not double it.
    if (history[history.length - 1]?.role === "user") history.pop();
    return undefined;
  }

  spoken = spoken.replace(/\s+/g, " ").replace(/[*_#`]/g, "").trim();
  if (!spoken) spoken = end ? `Thanks, ${doctor.name}. It's in your inbox. Have a good clinic.` : "Sorry, could you say that again?";
  return { reply: spoken, end };
}
