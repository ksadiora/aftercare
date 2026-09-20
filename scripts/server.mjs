import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createGemini } from "./gemini.mjs";
import { ServiceError } from "./services.mjs";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};
function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
async function readJson(req, limit = 4096) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new ServiceError("Send JSON.", 415, "invalid_content_type");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit)
      throw new ServiceError("Request too large.", 413, "invalid_input");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("Invalid JSON.", 400, "invalid_input");
  }
}
export function createAppServer({
  services,
  codi = createGemini({}),
  root = resolve("dist"),
}) {
  const server = createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host))
      return json(res, 403, {
        error: "Use the local game address.",
        code: "invalid_host",
      });
    let path;
    try {
      path = decodeURIComponent(
        new URL(req.url, `http://${req.headers.host}`).pathname,
      );
    } catch {
      return json(res, 400, { error: "Invalid URL.", code: "invalid_input" });
    }
    if (path.startsWith("/api/")) {
      try {
        const origin = req.headers.origin;
        if (
          (origin && origin !== `http://${req.headers.host}`) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          throw new ServiceError(
            "Open services from the local game.",
            403,
            "invalid_origin",
          );
        if (req.method === "POST" && req.headers["x-cove-client"] !== "game")
          throw new ServiceError(
            "Missing game request header.",
            403,
            "invalid_client",
          );
        let data;
        if (req.method === "GET" && path === "/api/services")
          data = { ...services.status(), gemini: codi.status() };
        else if (req.method === "POST" && path === "/api/codi/chat") {
          const input = await readJson(req, 65536);
          const controller = new AbortController();
          const disconnect = () => {
            if (!res.writableEnded) controller.abort();
          };
          res.on("close", disconnect);
          try {
            data = await codi.chat(input, { signal: controller.signal });
          } finally {
            res.off("close", disconnect);
          }
        } else if (req.method === "GET" && path === "/api/nessie/account")
          data = await services.bank();
        else if (req.method === "POST" && path === "/api/nessie/deposits")
          data = await services.deposit(await readJson(req));
        else if (req.method === "GET" && path === "/api/notion/assignments")
          data = await services.assignments();
        else if (req.method === "POST" && path === "/api/notion/complete") {
          const body = await readJson(req);
          data = await services.completeAssignment(body?.id);
        } else throw new ServiceError("API route not found.", 404, "not_found");
        json(res, 200, data);
      } catch (error) {
        json(res, error instanceof ServiceError ? error.status : 500, {
          error:
            error instanceof ServiceError
              ? error.message
              : "The service could not finish this request.",
          code: error instanceof ServiceError ? error.code : "internal_error",
        });
      }
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) return res.writeHead(405).end();
    try {
      if (path.split("/").some((p) => p.startsWith(".")))
        return res.writeHead(403).end("Forbidden");
      let file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      if (!file.startsWith(root + sep))
        return res.writeHead(403).end("Forbidden");
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
