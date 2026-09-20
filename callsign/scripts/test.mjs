import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? tests(file) : /\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}
const files = ["server/src", "shared/src", "web/src"].flatMap(tests).sort();
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], { stdio: "inherit", env: { ...process.env, ANS_MODE: "local", CALLS_MODE: "mock", LLM_MODE: "mock", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "" } });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
