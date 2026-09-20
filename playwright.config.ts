import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:4320', channel: 'chrome', viewport: { width: 1440, height: 1100 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node tests/support/mock-gemini.mjs', url: 'http://127.0.0.1:4399', reuseExistingServer: false, timeout: 15000 },
    {
      command: 'ELEVENLABS_API_KEY=local-test-only ELEVENLABS_AGENT_ID=local-test-agent GEMINI_API_KEY=local-test-only GEMINI_ENDPOINT=http://127.0.0.1:4399/v1beta LIVEKIT_URL=wss://rtc.local-test LIVEKIT_API_KEY=local-test-key LIVEKIT_API_SECRET=local-test-secret PORT=4320 DATABASE_PATH=data/e2e.sqlite npm start',
      url: 'http://127.0.0.1:4320/api/health', reuseExistingServer: false, timeout: 30000,
    },
  ],
});
