import type { AgentIdentity, DoctorProfile } from "./types.js";
import { config } from "./config.js";

/**
 * The two identities the gate knows: the provider (the recipient whose agent
 * verifies) and the care-team service (the sender that signs escalations). Both
 * read the live config so tests can reconfigure without re-importing.
 */
export const doctor: DoctorProfile = {
  get name() { return config.hcpDoctorName; },
  get agentName() { return config.hcpAgentName; },
  get specialty() { return config.hcpSpecialty; },
};

export const hcpIdentity: AgentIdentity = {
  get name() { return config.hcpAgentName; },
  role: "hcp",
  get displayName() { return config.hcpDoctorName; },
  get organization() { return config.hcpOrganization; },
  get cardUrl() { return `https://${config.hcpAgentName}/.well-known/agent.json`; },
};

/** The care-team service identity. It occupies Callsign's "brand" (sender) slot. */
export const brandIdentity: AgentIdentity = {
  get name() { return config.brandAgentName; },
  role: "careteam",
  get displayName() { return config.brandDisplayName; },
  get organization() { return config.brandOrganization; },
  get cardUrl() { return `https://${config.brandAgentName}/.well-known/agent.json`; },
};

/** A look-alike nobody registered: the identity the "spoofed sender" demo signs with. */
export const impostorIdentity: AgentIdentity = {
  get name() { return config.impostorAgentName; },
  role: "impostor",
  get displayName() { return config.brandDisplayName; },
  organization: "unknown",
  get cardUrl() { return `https://${config.impostorAgentName}/.well-known/agent.json`; },
};
