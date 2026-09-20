import test from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServices } from "../scripts/services.mjs";
import { createAppServer } from "../scripts/server.mjs";
import { loadConfig } from "../scripts/config.mjs";

const account = "111111111111111111111111";
const source = "11111111-1111-1111-1111-111111111111";
const taskId = "22222222-2222-2222-2222-222222222222";
const event = { id: "33333333-3333-3333-3333-333333333333", amount: 20 };
const config = {
  nessieKey: "test-only-nessie",
  nessieAccount: account,
  notionToken: "test-only-notion",
  notionSource: source,
  notionDone: "Done",
  notionQuest: "Quest",
  notionNotes: "Instructions",
};
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function setup(t, fetchImpl, override = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cove-services-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerFile = join(dir, "ledger.json");
  return {
    client: createServices(
      { ...config, ...override },
      { fetchImpl, ledgerFile },
    ),
    ledgerFile,
  };
}
const page = (patch = {}) => ({
  object: "page",
  id: taskId,
  parent: { data_source_id: source },
  properties: {
    Name: {
      type: "title",
      title: [{ plain_text: "Practice a little kindness" }],
    },
    Quest: { type: "select", select: { name: "garden" } },
    Instructions: {
      type: "rich_text",
      rich_text: [{ plain_text: "Share the harvest." }],
    },
    Done: { type: "checkbox", checkbox: false },
  },
  ...patch,
});

test("unconfigured services make no network calls and expose no credentials", async (t) => {
  const { client } = await setup(t, () => assert.fail("must not fetch"), {
    nessieKey: "",
    notionToken: "",
  });
  await assert.rejects(client.bank(), { code: "not_configured" });
  await assert.rejects(client.deposit(event), { code: "not_configured" });
  await assert.rejects(client.assignments(), { code: "not_configured" });
  assert.deepEqual(client.status(), {
    nessie: { configured: false },
    notion: { configured: false },
  });
});
test("Nessie records once across concurrent requests and process restart; rejects payload/account reuse", async (t) => {
  let posts = 0;
  const rows = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, "https://prod-api.nessieisreal.com");
    assert.equal(url.searchParams.get("key"), config.nessieKey);
    assert.equal(options.redirect, "error");
    if (options.method === "POST") {
      posts++;
      const body = JSON.parse(options.body);
      assert.equal(body.medium, "balance");
      assert.equal(body.amount, 20);
      const pending = JSON.parse(await readFile(ledgerFile, "utf8"));
      assert.equal(pending[event.id].status, "pending");
      rows.push({ ...body, _id: "deposit-1", status: "pending" });
      return response({ code: 201, objectCreated: rows[0] }, 201);
    }
    return response(rows);
  };
  const { client, ledgerFile } = await setup(t, fetchImpl);
  await Promise.all([client.deposit(event), client.deposit(event)]);
  const restarted = createServices(config, { fetchImpl, ledgerFile });
  await restarted.deposit(event);
  assert.equal(posts, 1);
  await assert.rejects(restarted.deposit({ ...event, amount: 40 }), {
    code: "event_conflict",
  });
  await assert.rejects(
    createServices(
      { ...config, nessieAccount: "222222222222222222222222" },
      { fetchImpl, ledgerFile },
    ).deposit(event),
    { code: "account_conflict" },
  );
});
test("Nessie lost response reconciles a committed deposit without reposting", async (t) => {
  let posts = 0;
  const rows = [];
  const { client } = await setup(t, async (url, options) => {
    if (options.method === "POST") {
      posts++;
      rows.push({ ...JSON.parse(options.body), _id: "deposit-lost" });
      throw new Error("secret URL must not escape");
    }
    return response(rows);
  });
  await assert.rejects(client.deposit(event), { code: "unavailable" });
  assert.equal((await client.deposit(event)).status, "confirmed");
  assert.equal(posts, 1);
});
test("Nessie ambiguous missing transaction remains pending instead of issuing another deposit", async (t) => {
  let posts = 0;
  const { client, ledgerFile } = await setup(t, async (url, options) => {
    if (options.method === "POST") {
      posts++;
      throw new Error("timeout");
    }
    return response([]);
  });
  await assert.rejects(client.deposit(event));
  const restarted = createServices(config, {
    ledgerFile,
    fetchImpl: async () => response([]),
  });
  await assert.rejects(restarted.deposit(event), {
    code: "confirmation_pending",
  });
  assert.equal(posts, 1);
});
test("Nessie definite rejection can retry, while account reads return only safe fields", async (t) => {
  let posts = 0;
  const { client } = await setup(t, async (url, options) => {
    if (options.method === "POST") {
      posts++;
      return posts === 1
        ? response({ code: 429 }, 429)
        : response({ objectCreated: { _id: "ok" } }, 201);
    }
    if (url.pathname.endsWith("/deposits")) return response([]);
    return response({
      _id: account,
      balance: 100,
      nickname: "Demo",
      customer_id: "private",
      account_number: "private",
    });
  });
  await assert.rejects(client.deposit(event), { status: 429 });
  await client.deposit(event);
  assert.equal(posts, 2);
  assert.deepEqual(await client.bank(), {
    nickname: "Demo",
    balance: 100,
    deposits: [],
  });
});
test("Notion paginates assignments with pinned version and a server-only bearer token", async (t) => {
  let requests = 0;
  const { client } = await setup(t, async (url, options) => {
    assert.equal(
      url.href,
      `https://api.notion.com/v1/data_sources/${source}/query`,
    );
    assert.equal(options.headers.Authorization, `Bearer ${config.notionToken}`);
    assert.equal(options.headers["Notion-Version"], "2025-09-03");
    requests++;
    const body = JSON.parse(options.body);
    if (requests === 1)
      return response({
        results: [page()],
        has_more: true,
        next_cursor: "cursor-2",
      });
    assert.equal(body.start_cursor, "cursor-2");
    return response({
      results: [page({ id: "different" })],
      has_more: false,
      next_cursor: null,
    });
  });
  const result = await client.assignments();
  assert.equal(result.assignments.length, 2);
  assert.deepEqual(result.assignments[0], {
    id: taskId,
    title: "Practice a little kindness",
    quest: "garden",
    notes: "Share the harvest.",
    done: false,
    canComplete: true,
  });
});
test("Notion repeated cursors stop instead of looping", async (t) => {
  let count = 0;
  const { client } = await setup(t, async () => {
    count++;
    return response({ results: [], has_more: true, next_cursor: "same" });
  });
  await assert.rejects(client.assignments(), { code: "invalid_response" });
  assert.equal(count, 2);
});
test("Notion completion validates the parent and updates only Done; retries are idempotent", async (t) => {
  let done = false,
    patches = 0;
  const { client } = await setup(t, async (url, options) => {
    if (options.method === "PATCH") {
      patches++;
      assert.deepEqual(JSON.parse(options.body), {
        properties: { Done: { checkbox: true } },
      });
      done = true;
      return response(page());
    }
    const p = page();
    p.properties.Done.checkbox = done;
    return response(p);
  });
  assert.equal((await client.completeAssignment(taskId)).assignment.done, true);
  await client.completeAssignment(taskId);
  assert.equal(patches, 1);
  for (const invalid of [
    page({ parent: { data_source_id: taskId } }),
    page({ archived: true }),
    page({ in_trash: true }),
  ]) {
    const service = createServices(config, {
      fetchImpl: async (url, o) => {
        assert.notEqual(o.method, "PATCH");
        return response(invalid);
      },
    });
    await assert.rejects(service.completeAssignment(taskId), {
      code: "wrong_classroom",
    });
  }
});
test("Notion database discovery rejects ambiguity and invalid schema errors are explicit", async (t) => {
  const { client } = await setup(
    t,
    async () => response({ data_sources: [{ id: source }, { id: taskId }] }),
    { notionSource: "", notionDatabase: source },
  );
  await assert.rejects(client.assignments(), { code: "invalid_config" });
  const p = page();
  delete p.properties.Done;
  const service = createServices(config, {
    fetchImpl: async () => response(p),
  });
  await assert.rejects(service.completeAssignment(taskId), {
    code: "invalid_schema",
  });
});
test("HTTP server protects API origins, input size and secrets; missing config remains honest", async (t) => {
  const configEmpty = await loadConfig("/does-not-exist", {});
  const server = createAppServer({
    services: createServices(configEmpty),
    root: resolve("dist"),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/.env`)).status, 403);
  assert.equal(
    (
      await fetch(`${base}/api/services`, {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const invalidHostStatus = await new Promise((resolve, reject) => {
    httpRequest(
      `${base}/api/services`,
      { headers: { Host: "localhost.evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    )
      .on("error", reject)
      .end();
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(`${base}/api/nessie/account`)).status, 503);
  assert.equal(
    (
      await fetch(`${base}/api/nessie/deposits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/nessie/deposits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cove-Client": "game",
        },
        body: "x".repeat(5000),
      })
    ).status,
    413,
  );
  const status = await (await fetch(`${base}/api/services`)).json();
  assert.deepEqual(status, {
    nessie: { configured: false },
    notion: { configured: false },
    gemini: { configured: false, model: "gemini-3.8-flash" },
  });
});

test("current Nessie acknowledgement-only creation is reconciled through the deposit list", async (t) => {
  const rows = [];
  let posts = 0;
  const currentAccount = "44444444-4444-4444-4444-444444444444";
  const fetchImpl = async (url, options) => {
    assert.ok(url.pathname.startsWith(`/accounts/${currentAccount}`));
    if (options.method === "POST") {
      posts++;
      const body = JSON.parse(options.body);
      assert.equal(body.status, "completed");
      rows.push({ ...body, _id: "current-api-deposit" });
      return response("Deposit created", 201);
    }
    if (!url.pathname.endsWith("/deposits"))
      return response({ _id: currentAccount, nickname: "Demo", balance: 20 });
    return response(rows);
  };
  const { client, ledgerFile } = await setup(t, fetchImpl, {
    nessieAccount: currentAccount,
  });
  assert.deepEqual(await client.deposit(event), {
    status: "confirmed",
    depositId: "current-api-deposit",
  });
  const restarted = createServices(
    { ...config, nessieAccount: currentAccount },
    { fetchImpl, ledgerFile },
  );
  await restarted.deposit(event);
  assert.equal((await restarted.bank()).balance, 20);
  assert.equal(posts, 1);
});

test("Nessie rejects malformed account paths before any provider request", async (t) => {
  for (const nessieAccount of [
    "../customers",
    "44444444-4444-4444-4444-444444444444/deposits",
    "11111111111111111111111z",
  ]) {
    const { client } = await setup(t, () => assert.fail("must not fetch"), {
      nessieAccount,
    });
    await assert.rejects(client.bank(), { code: "invalid_config" });
    await assert.rejects(client.deposit(event), { code: "invalid_config" });
  }
});

test("malformed server journal fails closed on repeated attempts", async (t) => {
  const { client, ledgerFile } = await setup(t, () =>
    assert.fail("No provider call with a malformed journal"),
  );
  await writeFile(ledgerFile, "[]");
  await assert.rejects(client.deposit(event), { code: "storage_error" });
  await assert.rejects(client.deposit(event), { code: "storage_error" });
  assert.equal(await readFile(ledgerFile, "utf8"), "[]");
});
