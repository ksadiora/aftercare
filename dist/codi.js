// Session-only conversation controller. No transcript is stored on disk or in localStorage.
export function createCodiChat({
  request,
  fallback,
  configured,
  getProgress,
  getTracked,
  changed = () => {},
}) {
  let messages = [],
    history = [],
    pending = false,
    error = "",
    failed = null,
    controller,
    generation = 0;
  let lastProvider = "";
  function notify() {
    changed();
  }
  async function ask(text, retry = false) {
    text = String(text).trim().slice(0, 2000);
    if (!text || pending) return;
    if (!retry) messages.push({ role: "user", text });
    error = "";
    failed = null;
    if (!configured()) {
      messages.push({
        role: "codi",
        text: fallback(text),
        source: "Built-in guide",
      });
      lastProvider = "local";
      messages = messages.slice(-30);
      notify();
      return;
    }
    pending = true;
    controller = new AbortController();
    const token = ++generation;
    notify();
    try {
      const result = await request(
        {
          message: text,
          history,
          progress: getProgress(),
          trackedQuest: getTracked(),
        },
        controller.signal,
      );
      if (token !== generation) return;
      messages.push({
        role: "codi",
        text: result.reply,
        source: "Gemini",
        truncated: result.truncated,
      });
      history.push(
        { role: "user", text },
        { role: "model", text: result.reply },
      );
      while (
        history.length > 8 ||
        history.reduce((n, m) => n + m.text.length, 0) > 12000
      )
        history.splice(0, 2);
      lastProvider = "gemini";
    } catch (e) {
      if (token !== generation) return;
      error = e.message || "Codi could not answer right now.";
      failed = text;
      lastProvider = "error";
    } finally {
      if (token === generation) {
        pending = false;
        controller = null;
        messages = messages.slice(-30);
        notify();
      }
    }
  }
  return {
    send: ask,
    retry: () => (failed ? ask(failed, true) : undefined),
    useGuide() {
      if (!failed || pending) return;
      messages.push({
        role: "codi",
        text: fallback(failed),
        source: "Built-in guide",
      });
      failed = null;
      error = "";
      lastProvider = "local";
      notify();
    },
    reset() {
      generation++;
      controller?.abort();
      controller = null;
      messages = [];
      history = [];
      pending = false;
      error = "";
      failed = null;
      lastProvider = "";
      notify();
    },
    stop() {
      if (!pending) return;
      generation++;
      controller?.abort();
      controller = null;
      pending = false;
      error = "Reply stopped. You can ask again.";
      failed = null;
      lastProvider = "";
      notify();
    },
    snapshot: () => ({
      messages: messages.map((m) => ({ ...m })),
      pending,
      error,
      canRetry: !!failed,
      lastProvider,
    }),
  };
}
