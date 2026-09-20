#!/usr/bin/env node
/**
 * Public HTTPS URL for the phone page, for when the laptop and the phone
 * cannot see each other (venue Wi-Fi isolation, firewall, no hotspot).
 *
 *   npm run tunnel
 *
 * Starts a Cloudflare quick tunnel to the Vite dev server, waits for the
 * https://*.trycloudflare.com URL, and posts it to the local server so the
 * console's QR code points at it. No account needed. Ctrl+C stops it and
 * clears the override. Requires cloudflared (winget install Cloudflare.cloudflared).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PHONE_PORT = process.env.PHONE_PORT || "5173";
const API = process.env.CALLSIGN_API || `http://localhost:${process.env.PORT || 8787}`;

function findCloudflared() {
  const candidates = ["cloudflared", "cloudflared.exe"];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const pkgs = join(local, "Microsoft", "WinGet", "Packages");
    if (existsSync(pkgs)) {
      for (const d of readdirSync(pkgs)) {
        if (d.startsWith("Cloudflare.cloudflared")) {
          const exe = join(pkgs, d, "cloudflared.exe");
          if (existsSync(exe)) candidates.unshift(exe);
        }
      }
    }
    const link = join(local, "Microsoft", "WinGet", "Links", "cloudflared.exe");
    if (existsSync(link)) candidates.unshift(link);
  }
  return candidates;
}

async function schemeUp(scheme) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1000);
    await fetch(`${scheme}://127.0.0.1:${PHONE_PORT}/phone`, { signal: ctrl.signal });
    return true;
  } catch (e) {
    const m = String(e?.cause ?? e?.message ?? e);
    return scheme === "https" && /certificate|self[- ]signed|SSL|TLS|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(m);
  }
}

async function setUrl(url) {
  try {
    await fetch(`${API}/api/phone/url`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
  } catch {
    console.warn(`  (could not reach ${API}; is the server running? The QR will not update, but the URL above still works.)`);
  }
}

const scheme = (await schemeUp("https")) ? "https" : (await schemeUp("http")) ? "http" : null;
if (!scheme) {
  console.error(`\n  Nothing is listening on port ${PHONE_PORT}. Start the app first: npm run dev\n`);
  process.exit(1);
}

const args = ["tunnel", "--url", `${scheme}://localhost:${PHONE_PORT}`, "--no-tls-verify", "--loglevel", "info"];
let child;
for (const exe of findCloudflared()) {
  try {
    child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((res, rej) => { child.once("spawn", res); child.once("error", rej); });
    break;
  } catch { child = undefined; }
}
if (!child) {
  console.error("\n  cloudflared not found. Install it:  winget install Cloudflare.cloudflared\n");
  process.exit(1);
}

console.log(`\n  Opening a public tunnel to ${scheme}://localhost:${PHONE_PORT} …`);
let url;
const onLine = async (line) => {
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !url) {
    url = `${m[0]}/phone`;
    console.log(`\n  Phone URL:  ${url}`);
    console.log(`  Console:    ${m[0]}/   (works from anywhere too)`);
    console.log(`\n  The console's QR now points at this URL. Ctrl+C to stop.\n`);
    await setUrl(url);
  }
};
for (const stream of [child.stdout, child.stderr]) {
  let buf = "";
  stream.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
}
const stop = async () => { await setUrl(""); child.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => { console.log(`\n  tunnel exited (${code})`); process.exit(code ?? 0); });
