import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class ServiceError extends Error {
  constructor(message, status = 502, code = "upstream_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isNessieId = (value) =>
  typeof value === "string" &&
  (/^[a-f0-9]{24}$/i.test(value) || uuid.test(value));
const notionId =
  /^[a-f0-9]{32}$|^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sameId = (a, b) =>
  String(a).replaceAll("-", "").toLowerCase() ===
  String(b).replaceAll("-", "").toLowerCase();
const text = (parts) =>
  (Array.isArray(parts)
    ? parts.map((p) => p.plain_text ?? p.text?.content ?? "").join("")
    : ""
  ).slice(0, 3000);
const quests = ["bank", "classroom", "garden"];

export function createServices(
  config,
  { fetchImpl = fetch, ledgerFile = ".data/nessie-events.json" } = {},
) {
  let ledger;
  let writeQueue = Promise.resolve();
  const locked = (fn) => {
    const result = writeQueue.then(fn);
    writeQueue = result.catch(() => {});
    return result;
  };
  async function loadLedger() {
    if (ledger) return;
    try {
      const parsed = JSON.parse(await readFile(ledgerFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      for (const [id, entry] of Object.entries(parsed)) {
        if (
          !uuid.test(id) ||
          !entry ||
          !isNessieId(entry.account) ||
          !Number.isSafeInteger(entry.amount) ||
          entry.amount < 1 ||
          entry.amount > 100000 ||
          !["pending", "confirmed", "rejected"].includes(entry.status) ||
          (entry.status === "confirmed" && typeof entry.depositId !== "string")
        )
          throw new Error();
      }
      ledger = parsed;
    } catch (error) {
      if (error.code === "ENOENT") ledger = {};
      else
        throw new ServiceError(
          "The local sync record needs repair before deposits can resume.",
          503,
          "storage_error",
        );
    }
  }
  async function persist() {
    try {
      await mkdir(dirname(ledgerFile), { recursive: true, mode: 0o700 });
      await writeFile(`${ledgerFile}.tmp`, JSON.stringify(ledger, null, 2), {
        mode: 0o600,
      });
      await rename(`${ledgerFile}.tmp`, ledgerFile);
    } catch {
      throw new ServiceError(
        "Could not save the local sync record. No new deposit will be retried automatically.",
        503,
        "storage_error",
      );
    }
  }
  async function request(service, path, { method = "GET", body } = {}) {
    const isNessie = service === "Nessie";
    const url = new URL(
      path,
      isNessie
        ? "https://prod-api.nessieisreal.com/"
        : "https://api.notion.com/v1/",
    );
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (isNessie) url.searchParams.set("key", config.nessieKey);
    else {
      headers.Authorization = `Bearer ${config.notionToken}`;
      headers["Notion-Version"] = "2025-09-03";
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new ServiceError(
        `${service} could not be reached. Your island progress is safe.`,
        503,
        "unavailable",
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      if (isNessie && response.ok && method === "POST")
        data = { acknowledged: true };
      else
        throw new ServiceError(
          `${service} returned an unreadable response.`,
          502,
          "invalid_response",
        );
    }
    const status =
      response.ok && !(Number(data?.code) >= 400)
        ? 200
        : Number(data?.code) >= 400
          ? Number(data.code)
          : response.status;
    if (status !== 200) {
      const reason =
        status === 401
          ? "Check the server API credential."
          : status === 403
            ? "Check connection permissions."
            : status === 404
              ? "Check the configured account or classroom ID and sharing permissions."
              : status === 429
                ? "Too many requests; try again shortly."
                : "Try again later.";
      const error = new ServiceError(
        `${service} rejected the request (${status}). ${reason}`,
        status === 429 ? 429 : 502,
        "upstream_error",
      );
      error.upstreamStatus = status;
      throw error;
    }
    return data;
  }
  function requireNessie() {
    if (!config.nessieKey || !config.nessieAccount)
      throw new ServiceError(
        "Nessie needs an API key and sandbox account ID in the server .env file.",
        503,
        "not_configured",
      );
    if (!isNessieId(config.nessieAccount))
      throw new ServiceError(
        "NESSIE_ACCOUNT_ID must be the sandbox account’s UUID or legacy 24-character ID.",
        503,
        "invalid_config",
      );
  }
  function requireNotion() {
    if (!config.notionToken || !(config.notionSource || config.notionDatabase))
      throw new ServiceError(
        "Notion needs a token and classroom data source ID in the server .env file.",
        503,
        "not_configured",
      );
    if (!notionId.test(config.notionSource || config.notionDatabase))
      throw new ServiceError(
        "Check the Notion data source or database ID in .env.",
        503,
        "invalid_config",
      );
  }
  async function sourceId() {
    requireNotion();
    if (config.notionSource) return config.notionSource;
    const database = await request(
      "Notion",
      `databases/${config.notionDatabase}`,
    );
    if (database.data_sources?.length !== 1)
      throw new ServiceError(
        "This Notion database has multiple or no data sources. Set NOTION_DATA_SOURCE_ID explicitly.",
        503,
        "invalid_config",
      );
    return database.data_sources[0].id;
  }
  const paths = () => `accounts/${config.nessieAccount}`;
  async function bank() {
    requireNessie();
    const [account, deposits] = await Promise.all([
      request("Nessie", paths()),
      request("Nessie", `${paths()}/deposits`),
    ]);
    if (
      account?._id !== config.nessieAccount ||
      !Number.isFinite(account.balance) ||
      !Array.isArray(deposits)
    )
      throw new ServiceError(
        "Nessie returned an unexpected account response.",
        502,
        "invalid_response",
      );
    return {
      nickname: String(account.nickname || "Cove savings").slice(0, 100),
      balance: account.balance,
      deposits: deposits
        .filter((d) => String(d.description).startsWith("Codi Cove "))
        .map((d) => ({
          id: d._id,
          amount: d.amount,
          status: d.status || "recorded",
          date: d.transaction_date,
        }))
        .slice(-20)
        .reverse(),
    };
  }
  async function deposit(event) {
    requireNessie();
    if (
      !uuid.test(event?.id) ||
      !Number.isSafeInteger(event?.amount) ||
      event.amount < 1 ||
      event.amount > 100000
    )
      throw new ServiceError("Invalid savings event.", 400, "invalid_input");
    return locked(async () => {
      await loadLedger();
      const key = event.id;
      const description = `Codi Cove ${event.id}`;
      const prior = ledger[key];
      if (prior && prior.account !== config.nessieAccount)
        throw new ServiceError(
          "This savings event belongs to another sandbox account. Restore the original account to finish syncing it.",
          409,
          "account_conflict",
        );
      if (prior && prior.amount !== event.amount)
        throw new ServiceError(
          "A savings event cannot change its amount.",
          409,
          "event_conflict",
        );
      if (prior?.status === "confirmed")
        return { status: "confirmed", depositId: prior.depositId };
      // Read before writing, including after a lost response or process restart.
      const deposits = await request("Nessie", `${paths()}/deposits`);
      if (!Array.isArray(deposits))
        throw new ServiceError(
          "Nessie returned an unexpected deposit list.",
          502,
          "invalid_response",
        );
      const found = deposits.find((d) => d.description === description);
      if (found) {
        if (found.amount !== event.amount)
          throw new ServiceError(
            "Nessie has a conflicting savings event.",
            409,
            "event_conflict",
          );
        if (["cancelled", "rejected"].includes(found.status))
          throw new ServiceError(
            "Nessie rejected this deposit. Check the sandbox account.",
            409,
            "deposit_rejected",
          );
        ledger[key] = {
          account: config.nessieAccount,
          amount: event.amount,
          status: "confirmed",
          depositId: found._id,
        };
        await persist();
        return { status: "confirmed", depositId: found._id };
      }
      if (prior?.status === "pending")
        throw new ServiceError(
          "This deposit is awaiting Nessie confirmation. Refresh later; a duplicate has not been sent.",
          409,
          "confirmation_pending",
        );
      ledger[key] = {
        account: config.nessieAccount,
        amount: event.amount,
        status: "pending",
        date: new Date().toISOString(),
      };
      await persist();
      let result;
      try {
        result = await request("Nessie", `${paths()}/deposits`, {
          method: "POST",
          body: {
            medium: "balance",
            status: "completed",
            transaction_date: new Date().toISOString().slice(0, 10),
            amount: event.amount,
            description,
          },
        });
      } catch (error) {
        // Definite request rejections may be retried. Timeouts/5xx remain ambiguous.
        if ([400, 401, 403, 404, 422, 429].includes(error.upstreamStatus)) {
          ledger[key].status = "rejected";
          await persist();
        }
        throw error;
      }
      let id = result?.objectCreated?._id || result?._id;
      // The current API may return only a creation acknowledgement. Read the record back.
      if (!id) {
        const updated = await request("Nessie", `${paths()}/deposits`);
        const match =
          Array.isArray(updated) &&
          updated.find(
            (d) =>
              d.description === description &&
              d.amount === event.amount &&
              !["cancelled", "rejected"].includes(d.status),
          );
        id = match?._id;
      }
      if (!id)
        throw new ServiceError(
          "Nessie received the request but confirmation is incomplete. Refresh later.",
          409,
          "confirmation_pending",
        );
      ledger[key] = {
        account: config.nessieAccount,
        amount: event.amount,
        status: "confirmed",
        depositId: id,
      };
      await persist();
      return { status: "confirmed", depositId: id };
    });
  }
  function assignment(page) {
    const properties = page.properties || {};
    const questProp = properties[config.notionQuest];
    const rawQuest = questProp?.select?.name ?? text(questProp?.rich_text);
    const quest = quests.includes(rawQuest?.toLowerCase())
      ? rawQuest.toLowerCase()
      : null;
    const done = properties[config.notionDone];
    return {
      id: page.id,
      title:
        text(
          Object.values(properties).find((p) => p.type === "title")?.title,
        ) || "Untitled assignment",
      quest,
      notes: text(properties[config.notionNotes]?.rich_text),
      done: done?.checkbox === true,
      canComplete: done?.type === "checkbox",
    };
  }
  async function assignments() {
    const source = await sourceId();
    const pages = [];
    let cursor;
    const cursors = new Set();
    let requests = 0;
    do {
      if (++requests > 10)
        throw new ServiceError(
          "Use a classroom data source with at most 1,000 rows.",
          503,
          "classroom_too_large",
        );
      const result = await request("Notion", `data_sources/${source}/query`, {
        method: "POST",
        body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      });
      if (!Array.isArray(result.results))
        throw new ServiceError(
          "Notion returned an unexpected classroom response.",
          502,
          "invalid_response",
        );
      pages.push(
        ...result.results.filter(
          (p) => p.object === "page" && !p.archived && !p.in_trash,
        ),
      );
      cursor = result.has_more ? result.next_cursor : null;
      if (result.has_more && !cursor)
        throw new ServiceError(
          "Notion pagination could not be completed.",
          502,
          "invalid_response",
        );
      if (cursor && cursors.has(cursor))
        throw new ServiceError(
          "Notion repeated a page cursor. Refresh the classroom later.",
          502,
          "invalid_response",
        );
      if (cursor) cursors.add(cursor);
      if (cursor && pages.length >= 1000)
        throw new ServiceError(
          "Use a classroom data source with at most 1,000 assignments.",
          503,
          "classroom_too_large",
        );
    } while (cursor);
    return { assignments: pages.map(assignment) };
  }
  async function completeAssignment(id) {
    if (!notionId.test(id))
      throw new ServiceError("Invalid assignment ID.", 400, "invalid_input");
    const source = await sourceId();
    const page = await request("Notion", `pages/${id}`);
    if (
      !sameId(page.parent?.data_source_id, source) ||
      page.archived ||
      page.in_trash
    )
      throw new ServiceError(
        "This assignment does not belong to the connected classroom.",
        403,
        "wrong_classroom",
      );
    const task = assignment(page);
    if (!task.canComplete)
      throw new ServiceError(
        `Add a checkbox property named ${config.notionDone} to the classroom.`,
        409,
        "invalid_schema",
      );
    if (!task.done)
      await request("Notion", `pages/${id}`, {
        method: "PATCH",
        body: { properties: { [config.notionDone]: { checkbox: true } } },
      });
    return { assignment: { ...task, done: true } };
  }
  return {
    status: () => ({
      nessie: { configured: !!(config.nessieKey && config.nessieAccount) },
      notion: {
        configured: !!(
          config.notionToken &&
          (config.notionSource || config.notionDatabase)
        ),
      },
    }),
    bank,
    deposit,
    assignments,
    completeAssignment,
  };
}
