import { loadConfig } from "./config.mjs";
import { createServices } from "./services.mjs";
import { createAppServer } from "./server.mjs";
import { createGemini } from "./gemini.mjs";
const config = await loadConfig();
const services = createServices(config);
const port = Number(process.env.PORT || 4173);
const server = createAppServer({ services, codi: createGemini(config) });
server.listen(port, "127.0.0.1", () => {
  console.log(`Codi’s Cove is running at http://127.0.0.1:${port}`);
  console.log(`Gemini: ${config.geminiKey ? "configured" : "needs setup"}`);
  console.log(
    `Nessie: ${services.status().nessie.configured ? "configured" : "needs setup"} · Notion: ${services.status().notion.configured ? "configured" : "needs setup"}`,
  );
});
