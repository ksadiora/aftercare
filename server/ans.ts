import { AppError } from './store.js';

/**
 * GoDaddy Agent Name Service (ANS) identity check for the nurse-coordination service.
 *
 * Scope, stated plainly: this resolves an ANSName against the registry and refuses to
 * hand patient context to a destination the registry does not vouch for. It does NOT
 * perform X.509 identity-certificate chain validation, DANE/TLSA pinning, or SCITT
 * transparency-log verification (ANS-2/3/4/5). Those need the private CA trust anchor
 * and a DNSSEC-validating resolver.
 *
 * ANS identity proves service and domain identity. It does not prove that a person is a
 * licensed nurse, and it does not authorise access to a patient record.
 *
 * The resolve path below is NOT confirmed against the live registry. Set ANS_RESOLVE_URL
 * (with a {name} placeholder) once you have developer access, rather than trusting it.
 */
export interface AnsConfig { apiKey?: string; registry?: string; resolveUrl?: string; careTeamName?: string }
export interface Verification { service: string; verified: boolean; detail: string; at: string }

const DEFAULT_REGISTRY = 'https://api.agentnameregistry.org';
const DEFAULT_RESOLVE = '{registry}/v1/agents/lookup?ansName={name}';
// ans://v{MAJOR}.{MINOR}.{PATCH}.{agentHost}  (ANS-2 §3)
const ANS_NAME = /^ans:\/\/v(\d+\.\d+\.\d+)\.([a-z0-9.-]+\.[a-z]{2,})$/i;

export function parseAnsName(name: string) {
  const match = ANS_NAME.exec(name.trim());
  if (!match) return null;
  return { version: match[1], agentHost: match[2].toLowerCase(), name: name.trim() };
}

export function ansCapability(config: AnsConfig) {
  const parsed = config.careTeamName ? parseAnsName(config.careTeamName) : null;
  const enabled = Boolean(config.apiKey && parsed);
  return {
    enabled,
    careTeam: parsed?.name || '',
    reason: !config.careTeamName
      ? 'Set ANS_CARE_TEAM_NAME to the care-team agent name to verify the handoff destination.'
      : !parsed
        ? 'ANS_CARE_TEAM_NAME must look like ans://v1.0.0.careteam.example.com'
        : !config.apiKey
          ? 'Set ANS_API_KEY to verify the care-team service before a handoff.'
          : `Care-team identity verified through ANS · ${parsed.name}`,
  };
}

const fail = (service: string, detail: string): Verification => ({ service, verified: false, detail, at: new Date().toISOString() });

/**
 * Resolves the care-team agent and checks that `endpoint` is one it actually declares.
 * Returns an unverified result rather than throwing: the caller decides whether an
 * unverified destination blocks the handoff.
 */
export async function verifyCareTeam(config: AnsConfig, endpoint: string, fetcher: typeof fetch = fetch): Promise<Verification> {
  const capability = ansCapability(config);
  const parsed = config.careTeamName ? parseAnsName(config.careTeamName) : null;
  if (!capability.enabled || !parsed) return fail(config.careTeamName || 'unconfigured', capability.reason);

  const url = (config.resolveUrl || DEFAULT_RESOLVE)
    .replace('{registry}', config.registry || DEFAULT_REGISTRY)
    .replace('{name}', encodeURIComponent(parsed.name));

  let response: Response;
  try { response = await fetcher(url, { headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }); }
  catch { return fail(parsed.name, 'The ANS registry could not be reached. Verification is unavailable.'); }
  if (response.status === 404) return fail(parsed.name, 'The registry has no record of this agent name.');
  if (response.status === 401 || response.status === 403) return fail(parsed.name, 'The ANS registry rejected the API key.');
  if (!response.ok) return fail(parsed.name, `The ANS registry returned HTTP ${response.status}. Verification is unavailable.`);

  const record = await response.json().catch(() => undefined) as {
    ansName?: string; ansId?: string; agentHost?: string; status?: string;
    endpoints?: { protocol?: string; agentUrl?: string }[];
  } | undefined;
  if (!record || typeof record !== 'object') return fail(parsed.name, 'The registry returned an unreadable record.');

  // Every check below must pass before any patient context leaves this server.
  if (record.ansName !== parsed.name) return fail(parsed.name, `The registry returned a different agent name (${record.ansName || 'none'}).`);
  if (record.agentHost?.toLowerCase() !== parsed.agentHost) return fail(parsed.name, `The record's host (${record.agentHost || 'none'}) does not match the requested name.`);
  const status = String(record.status || '').toUpperCase();
  if (status !== 'ACTIVE') return fail(parsed.name, `The agent is not active in the registry (${status || 'unknown status'}).`);

  const declared = (record.endpoints || []).map(e => String(e.agentUrl || '')).filter(Boolean);
  if (!declared.some(candidate => sameEndpoint(candidate, endpoint))) {
    return fail(parsed.name, `The registry does not list ${endpoint} for this agent. The handoff destination was rejected.`);
  }
  return { service: parsed.name, verified: true, detail: `Resolved ${record.ansId || 'record'} · host ${record.agentHost} · endpoint ${endpoint} listed and ACTIVE.`, at: new Date().toISOString() };
}

/** Origin and path must both match: a registry entry for one host never authorises another. */
function sameEndpoint(declared: string, target: string) {
  try {
    const a = new URL(declared);
    const b = new URL(target);
    return a.protocol === b.protocol && a.host === b.host && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch { return false; }
}

export function requireVerified(verification: Verification) {
  if (!verification.verified) throw new AppError(502, `Care-team service could not be verified: ${verification.detail}`);
  return verification;
}
