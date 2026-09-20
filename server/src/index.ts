import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { config, effectiveModes } from "./config.ts";
import { attachWebSocket } from "./events.ts";
import { snapshot } from "./store.ts";
import { a2a, api } from "./routes.ts";
import { webhooksRouter } from "./call/webhooks.ts";
import { localRegistryRouter } from "./verify/local-registry.ts";
import { twilioVoiceRouter } from "./call/twilio.ts";
import { phoneRouter } from "./call/app.ts";
import { workbenchRouter } from "./workbench.ts";
import { callerRouter } from "./call/caller.ts";
import { deskRouter } from "./desk.ts";

const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "1mb",
    // Keep the raw bytes so webhook signature checks (ElevenLabs HMAC) can verify exactly what was sent.
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

app.use((req, _res, next) => {
  if (!req.path.startsWith("/api/state")) console.log(`${req.method} ${req.path}`);
  next();
});

app.use("/", a2a);
app.use("/api/desk", deskRouter);
app.use("/api", api);
app.use("/api/webhooks", webhooksRouter);
app.use("/api/phone", phoneRouter); // the in-browser phone (CALLS_PROVIDER=app)
app.use("/api/workbench", workbenchRouter); // the judge composes and sends their own requests
app.use("/api/caller", callerRouter); // a human plays the caller; relay to the doctor's phone
app.use("/api/twilio/voice", twilioVoiceRouter); // TwiML conversation for CALLS_PROVIDER=twilio
app.use("/ans", localRegistryRouter); // self-hosted ANS-shaped registry used in ANS_MODE=local
app.get("/healthz", (_req, res) => res.json({ ok: true, mode: effectiveModes() }));

// Serve the built web app in production (npm run build && npm start)
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");
app.use(express.static(webDist));
app.get(/^\/(?!api|reach|healthz|\.well-known).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, "index.html"), (err) => (err ? next() : undefined));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
attachWebSocket(wss, () => ({ type: "snapshot", snapshot: snapshot() }));


server.listen(config.port, () => {
  const m = effectiveModes();
  console.log(`\nCallsign agent for ${config.hcpAgentName}`);
  console.log(`  http://localhost:${config.port}   ws: /ws`);
  console.log(`  modes  ans=${m.ans}  calls=${m.calls}  llm=${m.llm}\n`);
});
