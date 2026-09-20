import { loadConfig } from "./config.mjs";
import { createGemini } from "./gemini.mjs";
const codi = createGemini(await loadConfig());
if (!codi.status().configured) {
  console.log(
    "Gemini needs setup: add GEMINI_API_KEY to .env. No API call made.",
  );
  process.exitCode = 1;
} else {
  try {
    const result = await codi.chat({
      message: "Introduce yourself as Codi in one short sentence.",
      history: [],
    });
    console.log(
      `Gemini connected (${result.model}). One test request completed.`,
    );
    console.log(result.reply);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
