import type { VerificationResult, VerificationStep } from "./index.ts";

export type DeskChannel = "call" | "message";
export type DeskRole = "caller" | "screener" | "doctor";
export type DeskStatus = "screening" | "blocked" | "held" | "ringing" | "connected" | "delivered" | "ended";

export interface DeskRegistry {
  mode: "local" | "real" | "mock";
  label: string;
  description: string;
  sender: string;
  logUrl: string;
}

export interface DeskVerification extends Omit<VerificationResult, "steps"> {
  turnId: string;
  registry: DeskRegistry;
  steps: (Omit<VerificationStep, "id" | "status"> & { id: VerificationStep["id"] | "content"; status: VerificationStep["status"] | "ask" })[];
}

export type DeskStreamEvent = { type: "progress" | "complete"; session: DeskSession } | { type: "error"; error: string };

export interface DeskTurn {
  id: string;
  role: DeskRole;
  text: string;
  ts: string;
  engine?: "gemini" | "local";
  delivered?: boolean;
  verification?: DeskVerification;
}

export interface DeskSignal {
  label: string;
  detail: string;
  quote?: string;
  severity: "neutral" | "warning" | "danger";
}

export interface DeskAssessment {
  decision: "ask" | "block" | "allow";
  risk: "low" | "medium" | "high";
  summary: string;
  signals: DeskSignal[];
  source: "gemini" | "local";
  identity: "unverified";
}

export interface DeskSession {
  id: string;
  callerName: string;
  channel: DeskChannel;
  status: DeskStatus;
  transcript: DeskTurn[];
  assessment: DeskAssessment;
  createdAt: string;
  updatedAt: string;
  error?: string;
  verification?: DeskVerification;
  holdReason?: string;
  endReason?: "declined";
}

export interface DeskProviderStatus {
  gemini: boolean;
  elevenlabs: boolean;
  model: string;
  registry: DeskRegistry;
}
