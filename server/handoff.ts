import { createHmac, randomUUID } from 'node:crypto';
import { AppError } from './store.js';

export interface MediaConfig { apiKey?: string; apiSecret?: string; url?: string }

// Long enough for two people to notice a ring and walk between two laptops.
export const HANDOFF_RING_MS = 180000;
const TOKEN_TTL_SECONDS = 600;

export function mediaCapability(config: MediaConfig) {
  const enabled = Boolean(config.apiKey && config.apiSecret && config.url);
  return {
    enabled,
    url: config.url || '',
    reason: enabled
      ? 'Live nurse handoff · self-hosted LiveKit'
      : 'Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to enable the live nurse handoff. A callback task is recorded without it.',
  };
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * Room-scoped, short-lived LiveKit join token. Minted per participant so a patient
 * token can never be replayed into another room or reused after the call.
 */
export function joinToken(config: MediaConfig, room: string, identity: string, name: string) {
  if (!config.apiKey || !config.apiSecret) throw new AppError(503, mediaCapability(config).reason);
  const issued = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: config.apiKey, sub: identity, name, jti: randomUUID(),
    nbf: issued, iat: issued, exp: issued + TOKEN_TTL_SECONDS,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false },
  }));
  const signature = createHmac('sha256', config.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return { token: `${header}.${payload}.${signature}`, url: config.url || '', room, identity, expiresAt: new Date((issued + TOKEN_TTL_SECONDS) * 1000).toISOString() };
}

/** Test and debug helper: decode without verifying. Never used for authorisation. */
export function readToken(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
}
