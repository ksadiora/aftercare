import { readFile } from "node:fs/promises";

// Small .env reader: known integration keys only, no expansion or code execution.
export async function loadConfig(file = ".env", env = process.env) {
  const values = {};
  try {
    const source = await readFile(file, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !/^(NESSIE_|NOTION_|GEMINI_)/.test(match[1])) continue;
      let value = match[2];
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "").trim();
      values[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const get = (key, fallback = "") => env[key] ?? values[key] ?? fallback;
  return {
    geminiKey: get("GEMINI_API_KEY"),
    geminiModel: get("GEMINI_MODEL", "gemini-3.8-flash"),
    nessieKey: get("NESSIE_API_KEY"),
    nessieAccount: get("NESSIE_ACCOUNT_ID"),
    notionToken: get("NOTION_TOKEN"),
    notionSource: get("NOTION_DATA_SOURCE_ID"),
    notionDatabase: get("NOTION_DATABASE_ID"),
    notionDone: get("NOTION_DONE_PROPERTY", "Done"),
    notionQuest: get("NOTION_QUEST_PROPERTY", "Quest"),
    notionNotes: get("NOTION_NOTES_PROPERTY", "Instructions"),
  };
}
