import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * Plain http by default: the laptop console does not need TLS, and the phone
 * gets real HTTPS through `npm run tunnel`. For a LAN-only setup with no
 * internet, `npm run dev:ssl` serves a self-signed certificate so a phone on
 * the same Wi-Fi can use its microphone (accept the warning once).
 */
const ssl = process.env.VITE_SSL === "1";
// VITE_API_PORT points a second Vite at a second server (PORT=8791 npm run start -w server).
const apiPort = process.env.VITE_API_PORT?.trim() || "8787";
const api = `http://localhost:${apiPort}`;
const port = Number(process.env.VITE_PORT?.trim() || 5173);

export default defineConfig({
  plugins: [react(), ...(ssl ? [basicSsl()] : [])],
  server: {
    port,
    strictPort: true,
    host: true, // listen on all interfaces so the phone can reach it
    allowedHosts: true, // a cloudflared/ngrok hostname from `npm run tunnel` must be accepted
    proxy: {
      "/api": api,
      "/reach": api,
      "/healthz": api,
      "/.well-known": api,
      "/ans": api,
      "/ws": { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
});
