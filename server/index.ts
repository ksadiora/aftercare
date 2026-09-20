import { Store } from './store.js';
import { createApp } from './app.js';
const store = new Store(process.env.DATABASE_PATH || 'data/aftercare.sqlite');
const { app, close } = createApp(store, {
  voice: { apiKey: process.env.ELEVENLABS_API_KEY, agentId: process.env.ELEVENLABS_AGENT_ID },
  gemini: { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, briefingModel: process.env.GEMINI_BRIEFING_MODEL, endpoint: process.env.GEMINI_ENDPOINT },
  media: { apiKey: process.env.LIVEKIT_API_KEY, apiSecret: process.env.LIVEKIT_API_SECRET, url: process.env.LIVEKIT_URL },
  ans: { apiKey: process.env.ANS_API_KEY, registry: process.env.ANS_REGISTRY, resolveUrl: process.env.ANS_RESOLVE_URL, careTeamName: process.env.ANS_CARE_TEAM_NAME },
  trustedHosts: (process.env.TRUSTED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean),
  serveStatic: process.env.NODE_ENV === 'production',
});
const port = Number(process.env.PORT || 4317);
const bind = process.env.HOST || '127.0.0.1';
const server = app.listen(port, bind, () => console.log(`Aftercare is ready at http://${bind}:${port}`));
function shutdown() { close(); server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
