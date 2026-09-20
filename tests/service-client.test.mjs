import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "../dist/services.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

test("client drains deposits recorded while a sync request is already in flight", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalCrypto = globalThis.crypto;
  const originalWindow = globalThis.window;
  const storage = new Map();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let posts = 0;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  globalThis.window = { addEventListener() {} };
  if (!globalThis.crypto) globalThis.crypto = { randomUUID };
  globalThis.fetch = async (url, options = {}) => {
    if (url === "/api/services")
      return json({
        nessie: { configured: true },
        notion: { configured: false },
      });
    if (url === "/api/nessie/deposits") {
      posts++;
      if (posts === 1) await gate;
      return json({ status: "confirmed", depositId: `deposit-${posts}` });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const client = createServiceClient();
    await client.refresh();
    client.recordDeposit(20);
    await tick();
    client.recordDeposit(20);
    release();
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(client.snapshot().pending, 0);
    assert.equal(posts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
    globalThis.window = originalWindow;
    if (!originalCrypto) delete globalThis.crypto;
  }
});

test("corrupt browser sync history is preserved and never sent", async () => {
  const original = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
  };
  const corrupt = "[broken-json";
  let stored = corrupt,
    posts = 0;
  globalThis.localStorage = {
    getItem: () => stored,
    setItem: (_, value) => {
      stored = value;
    },
  };
  globalThis.window = { addEventListener() {} };
  globalThis.fetch = async (url) => {
    if (url.includes("deposits")) posts++;
    return json({
      nessie: { configured: true },
      notion: { configured: false },
    });
  };
  try {
    const client = createServiceClient();
    await client.refresh();
    client.recordDeposit(20);
    await client.sync();
    assert.equal(stored, corrupt);
    assert.equal(posts, 0);
    assert.match(client.snapshot().message, /preserved/);
  } finally {
    Object.assign(globalThis, original);
  }
});

test("browser outbox merges other-tab records and keeps confirmed states", async () => {
  const original = {
    fetch: globalThis.fetch,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
  };
  let stored = "[]";
  const listeners = {};
  globalThis.localStorage = {
    getItem: () => stored,
    setItem: (_, value) => {
      stored = value;
    },
  };
  globalThis.window = {
    addEventListener: (event, cb) => (listeners[event] = cb),
  };
  globalThis.fetch = async () =>
    json({ nessie: { configured: false }, notion: { configured: false } });
  try {
    const client = createServiceClient();
    client.recordDeposit(20);
    const first = JSON.parse(stored)[0];
    stored = JSON.stringify([
      { id: randomUUID(), amount: 20, confirmed: false },
      { ...first, confirmed: true },
    ]);
    listeners.storage({ key: "codis-cove-nessie-outbox-v1" });
    client.recordDeposit(20);
    assert.equal(JSON.parse(stored).length, 3);
    assert.equal(client.snapshot().confirmed, 1);
    assert.equal(client.snapshot().pending, 2);
  } finally {
    Object.assign(globalThis, original);
  }
});
