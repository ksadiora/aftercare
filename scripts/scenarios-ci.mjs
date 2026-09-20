import { spawn } from "node:child_process";
import { once } from "node:events";

const port = process.env.PORT || "8787";
const env = { ...process.env, PORT: port, ANS_MODE: "local", CALLS_MODE: "mock", CALLS_PROVIDER: "app", LLM_MODE: "mock", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", TARGET: `http://127.0.0.1:${port}` };
const server = spawn(process.execPath, ["--import", "tsx", "server/src/index.ts"], { env, stdio: ["ignore", "pipe", "inherit"] });
let runner;
const stop = () => { runner?.kill("SIGTERM"); server.kill("SIGTERM"); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Scenario server did not start within 30 seconds")), 30_000);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Scenario server exited (${code})`)); });
    server.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      // Only our child's readiness message is accepted; never reuse an unrelated listener.
      if (chunk.toString().includes(`http://localhost:${port}   ws: /ws`)) { clearTimeout(timer); resolve(); }
    });
  });
  runner = spawn(process.execPath, ["--import", "tsx", "server/src/scripts/scenarios.ts"], { env, stdio: "inherit" });
  const [code] = await once(runner, "exit");
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  stop();
  if (server.exitCode === null && server.signalCode === null) await once(server, "exit");
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
