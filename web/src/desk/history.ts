import type { DeskSession } from "@callsign/shared/src/desk.ts";
const KEY = "callsign.desk.history.v1";
export function loadHistory(): DeskSession[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((value): value is DeskSession => {
      if (!value || typeof value !== "object") return false;
      const item = value as Partial<DeskSession>;
      return typeof item.id === "string" && typeof item.callerName === "string" && typeof item.createdAt === "string" && typeof item.updatedAt === "string" &&
        ["screening", "blocked", "held", "ringing", "connected", "delivered", "ended"].includes(item.status ?? "") && ["call", "message"].includes(item.channel ?? "") &&
        Array.isArray(item.transcript) && item.transcript.every((line) => line && typeof line.id === "string" && typeof line.text === "string" && typeof line.ts === "string" && ["caller", "screener", "doctor"].includes(line.role)) &&
        Boolean(item.assessment && ["ask", "block", "allow"].includes(item.assessment.decision) && ["low", "medium", "high"].includes(item.assessment.risk) && typeof item.assessment.summary === "string" && Array.isArray(item.assessment.signals) && item.assessment.signals.every((signal) => signal && typeof signal.label === "string" && typeof signal.detail === "string"));
    }).slice(0, 30);
  } catch { return []; }
}
export function saveHistory(history: DeskSession[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(history.slice(0, 30))); return true; }
  catch { return false; }
}
