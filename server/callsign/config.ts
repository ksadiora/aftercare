import { resolve } from "node:path";

/**
 * Escalation-gate configuration. Read once from the environment; tests and the
 * app factory can override fields with configureCallsign(). Field names match
 * what the extracted Callsign modules expect (hcpAgentName, brandAgentName,
 * publicBaseUrl, ans.mode): here the "HCP" is the provider and the "brand" slot
 * is the care-team service identity that signs escalations.
 */
const env = (k: string, d = "") => process.env[k]?.trim() || d;

export const config = {
  /** Where the local registry keeps the CA, agent keys and certificates. Never committed (data/ is ignored). */
  keysDir: resolve(env("CALLSIGN_KEYS_DIR", "data/callsign-keys")),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:4317"),

  hcpAgentName: env("PROVIDER_AGENT_NAME", "lee.callsign-hcp.com"),
  hcpDoctorName: env("PROVIDER_NAME", "Dr. Morgan Lee"),
  hcpSpecialty: env("PROVIDER_SPECIALTY", "Orthopedic Surgery"),
  hcpOrganization: env("PROVIDER_ORGANIZATION", "Blacksburg Orthopedics (demo)"),

  brandAgentName: env("CARE_TEAM_AGENT_NAME", "careteam.aftercare.work"),
  brandDisplayName: env("CARE_TEAM_DISPLAY_NAME", "Aftercare care team"),
  brandOrganization: env("CARE_TEAM_ORGANIZATION", "Aftercare post-discharge care team (demo)"),

  impostorAgentName: env("IMPOSTOR_AGENT_NAME", "aftercare-careteam.xyz"),

  ans: {
    mode: (env("ANS_MODE", "local") === "mock" ? "mock" : "local") as "mock" | "local" | "real",
  },
};

export type CallsignConfig = typeof config;

/** Override configuration (tests, or the app factory). Returns the live config. */
export function configureCallsign(patch: Partial<Omit<CallsignConfig, "ans">> & { ans?: Partial<CallsignConfig["ans"]> }): CallsignConfig {
  const { ans, ...rest } = patch;
  Object.assign(config, rest);
  if (ans) Object.assign(config.ans, ans);
  if (rest.keysDir) config.keysDir = resolve(rest.keysDir);
  return config;
}
