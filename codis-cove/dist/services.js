const OUTBOX_KEY = "codis-cove-nessie-outbox-v1";
export function createServiceClient({ changed = () => {} } = {}) {
  let status = {
    nessie: { configured: false },
    notion: { configured: false },
    gemini: { configured: false },
    available: false,
  };
  let outbox = [];
  let syncing = false;
  let message = "";
  let storageHealthy = true;
  function mergeStored() {
    try {
      const raw = localStorage.getItem(OUTBOX_KEY);
      const data = raw === null ? [] : JSON.parse(raw);
      if (
        !Array.isArray(data) ||
        data.some(
          (e) =>
            !e ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              e.id,
            ) ||
            !Number.isSafeInteger(e.amount) ||
            e.amount < 1 ||
            e.amount > 100000,
        )
      )
        throw new Error();
      const merged = new Map(outbox.map((e) => [e.id, e]));
      for (const event of data) {
        const current = merged.get(event.id);
        if (current && current.amount !== event.amount) throw new Error();
        merged.set(event.id, {
          id: event.id,
          amount: event.amount,
          confirmed: current?.confirmed === true || event.confirmed === true,
        });
      }
      outbox = [...merged.values()];
      return true;
    } catch {
      storageHealthy = false;
      message =
        "Local sync history could not be read. It has been preserved; savings sync is paused.";
      return false;
    }
  }
  mergeStored();
  function persist() {
    if (!storageHealthy || !mergeStored()) return false;
    try {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
      return true;
    } catch {
      message =
        "Browser storage is unavailable. New savings cannot be synced safely.";
      changed();
      return false;
    }
  }
  window.addEventListener("storage", (event) => {
    if (event.key === OUTBOX_KEY) {
      mergeStored();
      changed();
    }
  });
  async function api(path, body, signal) {
    let response;
    try {
      response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body
          ? { "Content-Type": "application/json", "X-Cove-Client": "game" }
          : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error(
        "The local service server is unavailable. Your island progress is safe.",
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Restart the game with npm start to enable services.");
    }
    if (!response.ok)
      throw new Error(
        result.error || "This service is temporarily unavailable.",
      );
    return result;
  }
  async function refresh() {
    try {
      status = { ...(await api("/api/services")), available: true };
    } catch {
      status = {
        nessie: { configured: false },
        notion: { configured: false },
        gemini: { configured: false },
        available: false,
      };
    }
    changed();
    return status;
  }
  async function sync() {
    if (syncing || !status.nessie.configured || !storageHealthy) return;
    syncing = true;
    message = "";
    changed();
    try {
      if (!persist()) return;
      while (outbox.some((e) => !e.confirmed)) {
        const event = outbox.find((e) => !e.confirmed);
        await api("/api/nessie/deposits", {
          id: event.id,
          amount: event.amount,
        });
        const current = outbox.find((e) => e.id === event.id);
        if (current) current.confirmed = true;
        if (!persist()) return;
      }
      message = "Savings records are up to date.";
    } catch (error) {
      message = error.message;
    } finally {
      syncing = false;
      changed();
    }
  }
  function recordDeposit(amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    const event = { id: crypto.randomUUID(), amount, confirmed: false };
    outbox.push(event);
    if (!persist()) {
      outbox = outbox.filter((e) => e.id !== event.id);
      changed();
      return;
    }
    changed();
    if (status.nessie.configured) void sync();
  }
  return {
    refresh,
    sync,
    recordDeposit,
    snapshot: () => ({
      ...status,
      syncing,
      message,
      pending: outbox.filter((e) => !e.confirmed).length,
      confirmed: outbox.filter((e) => e.confirmed).length,
    }),
    askCodi: (body, signal) => api("/api/codi/chat", body, signal),
    bank: () => api("/api/nessie/account"),
    assignments: () => api("/api/notion/assignments"),
    complete: (id) => api("/api/notion/complete", { id }),
  };
}
