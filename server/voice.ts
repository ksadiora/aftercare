import { AppError } from './store.js';
export interface VoiceConfig { apiKey?: string; agentId?: string }
export function capabilities(config: VoiceConfig) {
  return { voice: Boolean(config.apiKey && config.agentId), voiceReason: !config.apiKey ? 'Add your ElevenLabs API key to .env to enable in-app calls. Simulation is ready now.' : !config.agentId ? 'Run npm run voice:setup, then add the agent ID to .env.' : 'In-app call · uses your ElevenLabs allowance', maxSessionSeconds: 300 };
}
export async function signedVoiceUrl(config: VoiceConfig, fetcher: typeof fetch = fetch) {
  if (!config.apiKey || !config.agentId) throw new AppError(503, capabilities(config).voiceReason);
  const headers = { 'xi-api-key': config.apiKey };
  let agentResponse: Response;
  try { agentResponse = await fetcher(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(config.agentId)}`, { headers, signal: AbortSignal.timeout(10000) }); }
  catch { throw new AppError(502, 'Could not reach ElevenLabs. Check your connection. Simulation remains available.'); }
  if (!agentResponse.ok) throw providerError(agentResponse.status);
  const agent = await agentResponse.json();
  if (agent.platform_settings?.privacy?.record_voice !== false || agent.platform_settings?.auth?.enable_auth !== true) {
    throw new AppError(409, 'This agent must have audio recording disabled and signed-URL authentication enabled. Use npm run voice:setup.');
  }
  let response: Response;
  try { response = await fetcher(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(config.agentId)}`, { headers, signal: AbortSignal.timeout(10000) }); }
  catch { throw new AppError(502, 'The voice connection timed out. Simulation remains available.'); }
  if (!response.ok) throw providerError(response.status);
  const data = await response.json();
  if (typeof data.signed_url !== 'string' || !data.signed_url.startsWith('wss://')) throw new AppError(502, 'ElevenLabs did not provide a usable voice connection.');
  return data.signed_url as string;
}
function providerError(status: number) {
  if (status === 401 || status === 403) return new AppError(503, 'ElevenLabs rejected the credentials or agent permissions. Check your API key and agent ID.');
  if (status === 402 || status === 429) return new AppError(503, 'ElevenLabs credits or usage limits are unavailable. Try again later or use simulation.');
  if (status === 404) return new AppError(503, 'The configured ElevenLabs agent could not be found. Run npm run voice:setup.');
  return new AppError(502, 'ElevenLabs is unavailable. Simulation remains ready.');
}
