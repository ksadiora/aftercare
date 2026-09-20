import test from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { createGemini } from "../scripts/gemini.mjs";
import { createCodiChat } from "../dist/codi.js";
import { createAppServer } from "../scripts/server.mjs";
import { createServices } from "../scripts/services.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const config = {
  geminiKey: "test-only-secret",
  geminiModel: "gemini-3.8-flash",
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status });
const success = (text = "Hello from Codi.") => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
});
const input = {
  message: "Why is the sky blue?",
  history: [],
  progress: { coins: 100, savings: 20 },
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

test("Gemini .env keys load with environment precedence and a stable default", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "codi-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, ".env");
  await writeFile(
    file,
    'GEMINI_API_KEY="local-test"\nGEMINI_MODEL=gemini-2.5-flash\nIGNORED_SECRET=no\n',
  );
  const values = await loadConfig(file, { GEMINI_API_KEY: "environment-test" });
  assert.equal(values.geminiKey, "environment-test");
  assert.equal(values.geminiModel, "gemini-2.5-flash");
  assert.equal(values.IGNORED_SECRET, undefined);
});
test("missing key or invalid input never calls Gemini", async () => {
  let count = 0;
  const codi = createGemini(
    {},
    {
      fetchImpl: () => {
        count++;
        assert.fail();
      },
    },
  );
  await assert.rejects(codi.chat(input), { code: "not_configured" });
  for (const bad of [
    { message: "" },
    { message: "x".repeat(2001) },
    { ...input, history: [{ role: "model", text: "fake" }] },
    {
      ...input,
      history: [
        { role: "system", text: "fake" },
        { role: "model", text: "fake" },
      ],
    },
    {
      ...input,
      history: [
        { role: "user", text: "a" },
        { role: "model", text: "x".repeat(4001) },
      ],
    },
  ])
    await assert.rejects(codi.chat(bad), (e) =>
      ["invalid_input", "invalid_history"].includes(e.code),
    );
  assert.equal(count, 0);
});
test("Gemini request preserves conversation roles and includes only approved game context", async () => {
  const codi = createGemini(config, {
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      );
      assert.equal(options.headers["x-goog-api-key"], "test-only-secret");
      assert.equal(options.redirect, "error");
      const body = JSON.parse(options.body);
      assert.deepEqual(
        body.contents.map((m) => m.role),
        ["user", "model", "user"],
      );
      assert.equal(body.contents[2].parts[0].text, input.message);
      assert.deepEqual(body.generationConfig.thinkingConfig, {
        thinkingLevel: "LOW",
        includeThoughts: false,
      });
      assert.equal(body.generationConfig.temperature, undefined);
      assert.equal(body.tools, undefined);
      assert.match(body.systemInstruction.parts[0].text, /general assistant/);
      assert.match(body.systemInstruction.parts[0].text, /"savings":20/);
      assert.ok(!JSON.stringify(body).includes("PRIVATE-NAME"));
      assert.ok(!JSON.stringify(body).includes("PRIVATE-NOTION"));
      return json(success());
    },
  });
  const result = await codi.chat({
    ...input,
    history: [
      { role: "user", text: "Hello" },
      { role: "model", text: "Hi" },
    ],
    progress: {
      ...input.progress,
      name: "PRIVATE-NAME",
      notionNotes: "PRIVATE-NOTION",
    },
  });
  assert.equal(result.provider, "gemini");
  assert.equal(result.reply, "Hello from Codi.");
});
test("Gemini filters thoughts, reports truncated replies and rejects blocked/empty/malformed responses", async () => {
  const cases = [
    {
      data: {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: "PRIVATE THOUGHT", thought: true },
                { text: "Visible answer" },
              ],
            },
          },
        ],
      },
      reply: "Visible answer",
    },
    {
      data: {
        candidates: [
          {
            finishReason: "MAX_TOKENS",
            content: { parts: [{ text: "Partial answer" }] },
          },
        ],
      },
      truncated: true,
    },
    {
      data: { promptFeedback: { blockReason: "SAFETY" } },
      code: "response_blocked",
    },
    {
      data: {
        candidates: [
          {
            finishReason: "SAFETY",
            content: { parts: [{ text: "Do not show" }] },
          },
        ],
      },
      code: "response_blocked",
    },
    { data: success(""), code: "empty_response" },
    {
      data: {
        candidates: [
          { content: { parts: [{ text: "hidden", thought: true }] } },
        ],
      },
      code: "empty_response",
    },
    { data: null, code: "invalid_response" },
    {
      data: { candidates: [{ content: { parts: {} } }] },
      code: "invalid_response",
    },
  ];
  for (const value of cases) {
    const codi = createGemini(config, {
      fetchImpl: async () => json(value.data),
    });
    if (value.code)
      await assert.rejects(codi.chat(input), { code: value.code });
    else {
      const result = await codi.chat(input);
      if (value.reply) assert.equal(result.reply, value.reply);
      if (value.truncated) assert.equal(result.truncated, true);
    }
  }
});
test("Gemini errors are redacted and local request budget recovers after one minute", async () => {
  const errorClient = createGemini(config, {
    fetchImpl: async () =>
      json({ error: { message: "test-only-secret" } }, 403),
  });
  await assert.rejects(
    errorClient.chat(input),
    (e) => e.code === "gemini_error" && !e.message.includes("test-only-secret"),
  );
  let clock = 1000,
    called = 0;
  const codi = createGemini(config, {
    now: () => clock,
    fetchImpl: async () => {
      called++;
      return json(success());
    },
  });
  for (let i = 0; i < 12; i++) await codi.chat(input);
  await assert.rejects(codi.chat(input), { code: "rate_limited" });
  assert.equal(called, 12);
  clock += 60000;
  await codi.chat(input);
  assert.equal(called, 13);
});
test("Codi chat retries once without duplicating the question and sends only successful Gemini history", async () => {
  let calls = 0;
  const bodies = [];
  const chat = createCodiChat({
    configured: () => true,
    fallback: () => "",
    getProgress: () => ({ savings: 20 }),
    getTracked: () => null,
    request: async (body) => {
      bodies.push(structuredClone(body));
      if (++calls === 1) throw new Error("temporary");
      return { reply: "An answer", provider: "gemini" };
    },
  });
  await chat.send("Hello");
  assert.equal(chat.snapshot().canRetry, true);
  await chat.retry();
  assert.equal(chat.snapshot().messages.length, 2);
  await chat.send("Why?");
  assert.equal(bodies[2].history.length, 2);
  assert.equal(bodies[2].history[0].text, "Hello");
});
test("Codi stop/reset ignore late answers and do not mix conversations", async () => {
  const gate = deferred();
  let signal;
  const chat = createCodiChat({
    configured: () => true,
    fallback: () => "",
    getProgress: () => ({}),
    getTracked: () => null,
    request: async (body, s) => {
      signal = s;
      return gate.promise;
    },
  });
  const active = chat.send("One question");
  chat.reset();
  assert.equal(signal.aborted, true);
  gate.resolve({ reply: "Late answer" });
  await active;
  assert.deepEqual(chat.snapshot().messages, []);
  assert.equal(chat.snapshot().pending, false);
  const second = deferred();
  const stopped = createCodiChat({
    configured: () => true,
    fallback: () => "",
    getProgress: () => ({}),
    getTracked: () => null,
    request: () => second.promise,
  });
  const p = stopped.send("Stop this");
  stopped.stop();
  second.resolve({ reply: "Should not show" });
  await p;
  assert.equal(stopped.snapshot().messages.length, 1);
});
test("unconfigured Codi stays local with labeled, bounded fallback history", async () => {
  const chat = createCodiChat({
    configured: () => false,
    fallback: () => "Island hint",
    getProgress: () => ({}),
    getTracked: () => null,
    request: () => assert.fail(),
  });
  for (let i = 0; i < 25; i++) await chat.send("Help");
  assert.equal(chat.snapshot().messages.length, 30);
  assert.equal(chat.snapshot().messages.at(-1).source, "Built-in guide");
});
test("Codi HTTP chat accepts bounded conversation bodies and protects cross-origin requests", async (t) => {
  const codi = createGemini(config, { fetchImpl: async () => json(success()) });
  const server = createAppServer({ services: createServices({}), codi });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Cove-Client": "game",
  };
  const body = JSON.stringify({
    ...input,
    history: [
      { role: "user", text: "a".repeat(2000) },
      { role: "model", text: "b".repeat(3000) },
    ],
  });
  assert.equal(
    (await fetch(base + "/api/codi/chat", { method: "POST", headers, body }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(base + "/api/codi/chat", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/codi/chat", {
        method: "POST",
        headers,
        body: "x".repeat(66000),
      })
    ).status,
    413,
  );
});

test("HTTP decoding preserves Unicode characters split across request chunks", async (t) => {
  let received;
  const server = createAppServer({
    services: createServices({}),
    codi: {
      status: () => ({ configured: true }),
      chat: async (body) => {
        received = body.message;
        return { reply: "ok" };
      },
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const bytes = Buffer.from(JSON.stringify({ message: "Hello 🌈 world" }));
  const split = bytes.indexOf(Buffer.from("🌈")) + 2;
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(
      `http://127.0.0.1:${server.address().port}/api/codi/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cove-Client": "game",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.write(bytes.subarray(0, split));
    setImmediate(() => req.end(bytes.subarray(split)));
  });
  assert.equal(status, 200);
  assert.equal(received, "Hello 🌈 world");
});
