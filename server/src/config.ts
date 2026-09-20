const env = (k: string, d = "") => process.env[k]?.trim() || d;

export const config = {
  port: Number(env("PORT", "8787")),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:8787"),

  hcpAgentName: env("HCP_AGENT_NAME", "patel.callsign-hcp.com"),
  brandAgentName: env("BRAND_AGENT_NAME", "stelazio.brand-demo.com"),
  impostorAgentName: env("IMPOSTOR_AGENT_NAME", "stelazio-updates.xyz"),

  ans: {
    mode: env("ANS_MODE", "local") as "mock" | "local" | "real",
    apiKey: env("ANS_API_KEY"),
    apiSecret: env("ANS_API_SECRET"),
    apiBase: env("ANS_API_BASE", "https://api.godaddy.com/v1/ans"),
  },

  calls: {
    mode: env("CALLS_MODE", "real") as "mock" | "real",
    provider: env("CALLS_PROVIDER", "app") as "app" | "twilio" | "elevenlabs",
    twilioFromNumber: env("TWILIO_FROM_NUMBER"),
    elevenLabsApiKey: env("ELEVENLABS_API_KEY"),
    elevenLabsAgentId: env("ELEVENLABS_AGENT_ID"),
    elevenLabsPhoneNumberId: env("ELEVENLABS_PHONE_NUMBER_ID"),
    elevenLabsWebhookSecret: env("ELEVENLABS_WEBHOOK_SECRET"),
    twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
  },

  llm: {
    mode: env("LLM_MODE", "mock") as "mock" | "real",
    geminiApiKey: env("GEMINI_API_KEY"),
    geminiModel: env("GEMINI_MODEL", "gemini-3.8-flash"),
  },
};

/** Late-bound so config.ts does not import the call module. Set by call/app.ts. */
let phonePairedProbe: () => boolean = () => false;
export function setPhonePairedProbe(fn: () => boolean) {
  phonePairedProbe = fn;
}

/** Effective modes after checking that the keys a "real" mode needs are present. */
export function effectiveModes() {
  const ans = config.ans.mode === "real" ? "real" : config.ans.mode === "local" ? "local" : "mock";
  const c = config.calls;
  const elevenReady = Boolean(c.elevenLabsApiKey && c.elevenLabsAgentId && c.elevenLabsPhoneNumberId);
  const twilioReady = Boolean(c.twilioAccountSid && c.twilioAuthToken && c.twilioFromNumber);
  const calls =
    c.provider === "app"
      ? c.mode === "mock" || !phonePairedProbe()
        ? "mock"
        : "real"
      : c.mode === "real" && (c.provider === "twilio" ? twilioReady : elevenReady)
        ? "real"
        : "mock";
  const llm = config.llm.mode === "real" && config.llm.geminiApiKey ? "real" : "mock";
  return { ans, calls, llm, provider: c.provider } as const;
}
