import type { NegotiationKind } from "@callsign/shared";

/**
 * MOCK LICENSE + ELIGIBILITY REGISTRY  (owner: Story lane)
 *
 * Stands in for a state medical board lookup and the brand's PDMA sample
 * ledger. Keyed by license number. All fake. One expired and one suspended
 * entry exist so the negotiation has a real failure path to demo:
 *   POST /api/tools/request_samples {"request":"send samples, license 0101-777120"}
 */

export type LicenseStatus = "active" | "expired" | "suspended";

export interface LicenseRecord {
  licenseNumber: string;
  state: string;
  name: string;
  specialty: string;
  status: LicenseStatus;
  /** ISO date the license expires or expired. */
  expires: string;
  /** Days since this prescriber last received professional samples; undefined = never. */
  lastSampleRequestDaysAgo?: number;
}

export const SAMPLE_COOLDOWN_DAYS = 30;
/** Label section 16: "limited to 2 cartons of 14 tablets per request". */
export const MAX_CARTONS_PER_REQUEST = 2;

export const LICENSE_REGISTRY: Record<string, LicenseRecord> = {
  "0101-284736": {
    licenseNumber: "0101-284736",
    state: "VA",
    name: "Dr. Priya Patel",
    specialty: "Cardiology",
    status: "active",
    expires: "2028-02-28",
    lastSampleRequestDaysAgo: 94,
  },
  "0101-118273": {
    licenseNumber: "0101-118273",
    state: "VA",
    name: "Dr. Marcus Reed",
    specialty: "Nephrology",
    status: "active",
    expires: "2027-06-30",
    lastSampleRequestDaysAgo: 12, // inside the cooldown: eligibility fails for samples
  },
  "2019-04477": {
    licenseNumber: "2019-04477",
    state: "NC",
    name: "Dr. Elena Sousa",
    specialty: "Internal Medicine",
    status: "active",
    expires: "2027-12-31",
  },
  "0101-336610": {
    licenseNumber: "0101-336610",
    state: "VA",
    name: "Dr. Wen Liu",
    specialty: "Cardiology",
    status: "active",
    expires: "2027-10-31",
    lastSampleRequestDaysAgo: 40,
  },
  "0101-777120": {
    licenseNumber: "0101-777120",
    state: "VA",
    name: "Dr. Samuel Okafor",
    specialty: "Cardiology",
    status: "expired",
    expires: "2026-06-30",
  },
  "0101-550019": {
    licenseNumber: "0101-550019",
    state: "VA",
    name: "Dr. Hannah Brooks",
    specialty: "Family Medicine",
    status: "suspended",
    expires: "2027-03-31",
  },
};

export interface LicenseCheck {
  ok: boolean;
  record?: LicenseRecord;
  /** A predicate that reads after "the license ...", e.g. "is active through 2028-02-28" or "expired on 2026-06-30". */
  detail: string;
}

export function lookupLicense(licenseNumber: string, state?: string): LicenseCheck {
  const record = LICENSE_REGISTRY[licenseNumber.trim()];
  if (!record) return { ok: false, detail: `is not on file with the ${state ?? "state"} board` };
  if (state && record.state !== state) {
    return { ok: false, record, detail: `was issued by ${record.state}, not ${state}` };
  }
  if (record.status === "expired") return { ok: false, record, detail: `expired on ${record.expires}` };
  if (record.status === "suspended") return { ok: false, record, detail: `is suspended by the ${record.state} board` };
  return { ok: true, record, detail: `is active through ${record.expires}` };
}

export interface EligibilityCheck {
  ok: boolean;
  detail: string;
}

/**
 * Sample eligibility follows the Prescription Drug Marketing Act shape: a
 * licensed prescriber in good standing, a written (here: signed) request,
 * and a per-request quantity cap. Follow-ups and rep visits only need an
 * active license.
 */
export function checkEligibility(record: LicenseRecord, kind: NegotiationKind, cartonsRequested = 1): EligibilityCheck {
  if (kind !== "samples") {
    return { ok: true, detail: `prescriber in good standing; ${kind === "rep_visit" ? "in-person visits" : "follow-up contact"} allowed by the practice` };
  }
  if (record.lastSampleRequestDaysAgo !== undefined && record.lastSampleRequestDaysAgo < SAMPLE_COOLDOWN_DAYS) {
    return {
      ok: false,
      detail: `a sample shipment went out ${record.lastSampleRequestDaysAgo} days ago; the next is allowed after ${SAMPLE_COOLDOWN_DAYS} days`,
    };
  }
  const cap = cartonsRequested > MAX_CARTONS_PER_REQUEST ? `, capped at ${MAX_CARTONS_PER_REQUEST} cartons per request` : "";
  const last = record.lastSampleRequestDaysAgo === undefined ? "no prior sample request" : `last request ${record.lastSampleRequestDaysAgo} days ago`;
  return { ok: true, detail: `prescriber in good standing, ${last}${cap}` };
}
