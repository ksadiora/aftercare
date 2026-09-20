import type { DoctorPolicy, PolicyUpdateBody } from "./types.js";

/**
 * THE DOCTOR'S POLICY
 *
 * Identity says who is calling. Policy says whether Dr. Patel wants to be
 * reached right now. Her agent enforces both. Toggled from the Present
 * sheet during the demo: flip "In clinic" and a fully verified brand still
 * lands in the inbox with the phone silent.
 */
const policy: DoctorPolicy = {
  acceptCalls: true,
  specialtyOnly: true,
  requireReceipt: true,
  note: undefined,
};

export function getPolicy(): DoctorPolicy {
  return { ...policy };
}

export function updatePolicy(patch: PolicyUpdateBody): DoctorPolicy {
  if (typeof patch.acceptCalls === "boolean") policy.acceptCalls = patch.acceptCalls;
  if (typeof patch.specialtyOnly === "boolean") policy.specialtyOnly = patch.specialtyOnly;
  if (typeof patch.requireReceipt === "boolean") policy.requireReceipt = patch.requireReceipt;
  if (patch.note !== undefined) policy.note = patch.note ? String(patch.note).slice(0, 80) : undefined;
  if (!policy.acceptCalls && !policy.note) policy.note = "Calls are paused";
  if (policy.acceptCalls && policy.note === "Calls are paused") policy.note = undefined;
  return getPolicy();
}

/**
 * Decide the policy step for a verified request. Returns ok=true to call,
 * ok=false with a human reason to hold in the inbox. Evidence lists the
 * inputs so the proof drawer can show why.
 */
export function evaluatePolicy(input: { specialty?: string; doctorSpecialty: string; hasReceipt: boolean; doctorName?: string }): {
  ok: boolean;
  detail: string;
  evidence: { label: string; value: string; mono?: boolean }[];
} {
  const p = policy;
  const evidence = [
    { label: "Accept calls", value: p.acceptCalls ? "yes" : `no · ${p.note ?? "held"}` },
    { label: "Specialty filter", value: p.specialtyOnly ? `on · ${input.doctorSpecialty}` : "off" },
    { label: "Request targets", value: input.specialty ?? "(unspecified)" },
    { label: "Receipt required", value: p.requireReceipt ? (input.hasReceipt ? "yes · present" : "yes · missing") : "no" },
  ];
  if (p.requireReceipt && !input.hasReceipt) return { ok: false, detail: "no transparency-log receipt", evidence };
  const relevant = !p.specialtyOnly || !input.specialty || input.specialty === input.doctorSpecialty;
  if (!relevant) return { ok: false, detail: `not relevant to ${input.doctorSpecialty} · held in inbox`, evidence };
  if (!p.acceptCalls) return { ok: false, detail: `${p.note ?? `${input.doctorName ?? "The doctor"} is not taking calls`} · held in inbox`, evidence };
  return { ok: true, detail: `relevant to ${input.doctorSpecialty} · accepting calls · caller allowed`, evidence };
}
