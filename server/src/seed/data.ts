import type { AgentIdentity, DoctorProfile } from "@callsign/shared";
import { config } from "../config.ts";

/**
 * Seed data for the demo. All fake. Owned by the Story lane; the label text
 * in label/stelazio.ts is the source the voice agent answers from.
 */

export const doctor: DoctorProfile = {
  name: "Dr. Priya Patel",
  agentName: config.hcpAgentName,
  specialty: "Cardiology",
  npi: "1932847561",
  state: "VA",
  licenseNumber: "0101-284736",
  callWindow: { start: "08:00", end: "18:00", tz: "America/New_York" },
  patientsOnBrand: 2,
};

export const hcpIdentity: AgentIdentity = {
  name: config.hcpAgentName,
  role: "hcp",
  displayName: doctor.name,
  organization: "Blacksburg Cardiology Associates",
  cardUrl: `https://${config.hcpAgentName}/.well-known/agent.json`,
};

export const brandIdentity: AgentIdentity = {
  name: config.brandAgentName,
  role: "brand",
  displayName: "Stelazio",
  organization: "Stelazio Pharmaceuticals (demo)",
  cardUrl: `https://${config.brandAgentName}/.well-known/agent.json`,
};

export const impostorIdentity: AgentIdentity = {
  name: config.impostorAgentName,
  role: "impostor",
  displayName: "Stelazio", // it claims to be the brand
  organization: "unknown",
  cardUrl: `https://${config.impostorAgentName}/.well-known/agent.json`,
};

/** The update the brand agent is calling about. Read aloud on the call. */
export const todaysUpdate = {
  kind: "label_update" as const,
  summary: "New renal dosing guidance for Stelazio: reduce to 5 mg once daily when eGFR is below 45.",
  detail:
    "Section 2.3 of the prescribing information was updated on September 18, 2026. For patients with an estimated glomerular filtration rate below 45 mL/min/1.73 m², the recommended dose is now 5 mg once daily. Monitor renal function at baseline and every 3 months. No change for patients with eGFR 45 or above.",
  affectedPatients: doctor.patientsOnBrand,
  specialty: "Cardiology",
};

/** Other physicians in the mock network, for the inbox's "who else was reached" and for realism. */
export const otherDoctors: DoctorProfile[] = [
  { name: "Dr. Marcus Reed", agentName: "reed.callsign-hcp.com", specialty: "Nephrology", npi: "1478236590", state: "VA", licenseNumber: "0101-118273", callWindow: { start: "09:00", end: "17:00", tz: "America/New_York" }, patientsOnBrand: 5 },
  { name: "Dr. Elena Sousa", agentName: "sousa.callsign-hcp.com", specialty: "Internal Medicine", npi: "1659384720", state: "NC", licenseNumber: "2019-04477", callWindow: { start: "08:30", end: "17:30", tz: "America/New_York" }, patientsOnBrand: 1 },
  { name: "Dr. Wen Liu", agentName: "liu.callsign-hcp.com", specialty: "Cardiology", npi: "1284759301", state: "VA", licenseNumber: "0101-336610", callWindow: { start: "07:00", end: "15:00", tz: "America/New_York" }, patientsOnBrand: 3 },
];
