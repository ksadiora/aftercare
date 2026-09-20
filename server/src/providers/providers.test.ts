import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { generateGeminiJson, generateGeminiText, getGeminiConfiguration } from "./gemini.ts";
import { getElevenLabsConfiguration, synthesizeElevenLabsSpeech } from "./elevenlabs.ts";
import { ProviderError, readProviderBody } from "./http.ts";

const environmentKeys = [
  "GEMINI_API_KEY", "GEMINI_MODEL", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_SCREENER_VOICE_ID", "ELEVENLABS_DOCTOR_VOICE_ID", "ELEVENLABS_TTS_MODEL",
];
let originalEnvironment: Array<[string, string | undefined]>;

beforeEach(() => {
  originalEnvironment = environmentKeys.map((key) => [key, process.env[key]]);
  for (const key of environmentKeys) delete process.env[key];
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const request = { systemInstruction: "Classify the supplied test message.", prompt: "A test call." };

function geminiResponse(text: string, finishReason = "STOP") {
  return Response.json({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
}

test("configuration is a local check and missing keys never make requests", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request"); });
  assert.equal(getGeminiConfiguration().configured, false);
  assert.equal(getElevenLabsConfiguration().configured, false);
  await assert.rejects(generateGeminiText(request), { code: "not_configured" });
  await assert.rejects(synthesizeElevenLabsSpeech("Hello."), { code: "not_configured" });
  process.env.GEMINI_API_KEY = "test-key";
  process.env.ELEVENLABS_API_KEY = "test-key";
  assert.equal(getGeminiConfiguration().configured, true);
  assert.equal(getElevenLabsConfiguration().configured, true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Gemini authenticates in a header, requests JSON, and excludes thought parts", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_MODEL = "test-model";
  const schema = { type: "object", properties: { decision: { type: "string" } } };
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-key");
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body)) as { generationConfig: Record<string, unknown> };
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
      { text: "internal reasoning", thought: true }, { text: '{"decision":"review"}' },
    ] } }] });
  });
  assert.deepEqual(await generateGeminiJson({ ...request, schema }), { decision: "review" });
});

test("Gemini rejects incomplete, blocked, malformed, and empty results", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const responses = [
    geminiResponse('{"decision":"allow"}', "MAX_TOKENS"),
    Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
    geminiResponse("not-json"),
    Response.json({ candidates: [{ content: { parts: [] } }] }),
  ];
  mock.method(globalThis, "fetch", async () => responses.shift()!);
  for (let index = 0; index < 4; index++) {
    await assert.rejects(generateGeminiJson(request), { code: "invalid_response" });
  }
});

test("upstream failure messages never include provider bodies or credentials", async () => {
  process.env.GEMINI_API_KEY = "secret-test-value";
  mock.method(globalThis, "fetch", async () => new Response("secret-test-value private upstream detail", { status: 429 }));
  await assert.rejects(generateGeminiText(request), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 429);
    assert.match(error.message, /quota/);
    assert.doesNotMatch(error.message, /secret-test-value|private upstream/);
    return true;
  });
});

test("oversize conversation input fails before any request", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const fetchMock = mock.method(globalThis, "fetch", async () => geminiResponse("unused"));
  await assert.rejects(generateGeminiText({ ...request, prompt: "x".repeat(48_001) }), { code: "invalid_input" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("ElevenLabs uses role voices and returns actual MP3 response bytes", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_VOICE_ID = "default-voice";
  process.env.ELEVENLABS_DOCTOR_VOICE_ID = "doctor-voice";
  process.env.ELEVENLABS_TTS_MODEL = "test-tts-model";
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.elevenlabs.io/v1/text-to-speech/doctor-voice?output_format=mp3_44100_128");
    assert.equal(new Headers(init?.headers).get("xi-api-key"), "test-key");
    const body = JSON.parse(String(init?.body)) as { text: string; model_id: string };
    assert.equal(body.text, "Hello, this is a simulated doctor.");
    assert.equal(body.model_id, "test-tts-model");
    assert.ok(init?.signal);
    return new Response(new Uint8Array([73, 68, 51, 0]), { headers: { "content-type": "audio/mpeg" } });
  });
  const result = await synthesizeElevenLabsSpeech(" Hello, this is a simulated doctor. ", "doctor");
  assert.equal(result.contentType, "audio/mpeg");
  assert.deepEqual(result.audio, Buffer.from([73, 68, 51, 0]));
});

test("ElevenLabs rejects non-audio, empty audio, and invalid input without fallback", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  const responses = [
    Response.json({ error: "not audio" }),
    new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } }),
  ];
  const fetchMock = mock.method(globalThis, "fetch", async () => responses.shift()!);
  await assert.rejects(synthesizeElevenLabsSpeech("Hello."), { code: "invalid_response" });
  await assert.rejects(synthesizeElevenLabsSpeech("Hello."), { code: "invalid_response" });
  await assert.rejects(synthesizeElevenLabsSpeech(" "), { code: "invalid_input" });
  await assert.rejects(synthesizeElevenLabsSpeech("x".repeat(2_001)), { code: "invalid_input" });
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("provider byte limits cancel streaming bodies without trusting Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(20)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readProviderBody(new Response(stream), 10, "ElevenLabs"), { code: "invalid_response" });
  assert.equal(cancelled, true);
});
