import { labelLookup } from "../label/index.ts";
import { requestSamplesFromCall } from "../negotiate/index.ts";
import type { CallVariables } from "./provider.ts";
import { effectiveModes } from "../config.ts";

/**
 * THE CONVERSATION
 *
 * One place that decides what the agent says next, used by every carrier:
 * the in-app call, Twilio, and the mock. Speech-to-text happens elsewhere;
 * this receives text and returns text. Every answer about the drug comes
 * from the label through labelLookup(); anything transactional goes through
 * the negotiation. Never throws.
 */

export const MAX_TURNS = 8;

export function openingLine(v: CallVariables): string {
  return `${v.doctor_name}, this is the verified ${v.brand} agent, calling through Callsign. ${v.update_summary} ${v.affected_patients} of your patients are affected. Want the one-line change, or should I send it to your inbox?`;
}

export interface Turn {
  reply: string;
  end: boolean;
}

export async function respond(callId: string, vars: CallVariables, heard: string, turn: number): Promise<Turn> {
  // Real brain first: Gemini with the label as grounding and tools. Falls through on any failure.
  if (effectiveModes().llm === "real") {
    const { geminiRespond } = await import("./gemini-dialogue.ts");
    const out = await geminiRespond(callId, vars, heard, openingLine(vars));
    if (out) {
      if (turn >= MAX_TURNS * 2 && !out.end) return { reply: `${out.reply} I'll put the rest in your inbox. Have a good clinic.`, end: true };
      return out;
    }
  }
  const h = heard.trim().toLowerCase();
  let reply: string;
  let end = false;
  try {
    if (!h) {
      reply = "Sorry, I didn't catch that. Want the one-line change, or should I send it to your inbox?";
    } else if (/\b(sample|samples|box|boxes|carton|cartons|rep visit|follow[- ]?up|call me back|call back)\b/.test(h)) {
      const out = await requestSamplesFromCall(heard, callId);
      reply = `${out.confirmation} Anything else?`;
    } else if (/\b(who are you|who is this|are you real|are you a bot|how do i know|prove|verified|legit|scam)\b/.test(h)) {
      reply = `I'm ${vars.brand}'s agent. Your Callsign agent verified my identity through the Agent Name Service before this call connected: my domain, my certificate, and a public transparency-log receipt. The proof is on your console. Want the one-line change?`;
    } else if (/\b(what is this about|what's this about|why are you calling|what do you want)\b/.test(h)) {
      reply = `${vars.update_summary} ${vars.affected_patients} of your patients are affected. Want the one-line change, or should I send it to your inbox?`;
    } else if (/\b(not interested|don't call|do not call|stop calling|remove me|unsubscribe)\b/.test(h)) {
      reply = "Understood. I've told your agent to hold future calls from us and send updates to your inbox only. Have a good clinic.";
      end = true;
    } else if (/\b(inbox|send it|email|later|busy|not now)\b/.test(h)) {
      reply = "Sent to your inbox with the full label section. Have a good clinic.";
      end = true;
    } else if (/\b(bye|goodbye|thanks|thank you|that's all|that is all|nothing else|no thanks|we're good|all good)\b/.test(h)) {
      reply = "You're welcome. It's in your inbox too. Have a good clinic.";
      end = true;
    } else if (/\b(one[- ]?liner|one line|short version|what changed|the change|go ahead|yes|sure|okay|ok)\b/.test(h) && turn <= 2) {
      reply = `${vars.update_summary} That's section 2.3 of the label. Want me to send samples, or is there a patient you want to check?`;
    } else {
      const ans = await labelLookup(heard);
      reply = ans.found
        ? `${ans.answer}${ans.citation ? ` That's from the ${ans.citation}.` : ""} Anything else?`
        : `${ans.answer} Anything else?`;
    }
  } catch (e) {
    console.warn("[dialogue] turn failed", (e as Error).message);
    reply = "Something went wrong on my side. I'll send the update to your inbox. Have a good clinic.";
    end = true;
  }
  if (turn >= MAX_TURNS && !end) {
    reply += " I'll put the rest in your inbox. Have a good clinic.";
    end = true;
  }
  return { reply, end };
}
