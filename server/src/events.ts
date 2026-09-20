import { EventEmitter } from "node:events";
import type { WebSocketServer } from "ws";
import type { ServerEvent } from "@callsign/shared";

/**
 * Single process-wide bus. Server modules call `emit(event)`; the WebSocket
 * layer forwards every event to all connected browsers.
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emit(event: ServerEvent) {
  bus.emit("event", event);
}

export function onEvent(fn: (e: ServerEvent) => void) {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}

export function attachWebSocket(wss: WebSocketServer, snapshot: () => ServerEvent) {
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify(snapshot()));
  });
  onEvent((e) => {
    const data = JSON.stringify(e);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });
}

export const nowIso = () => new Date().toISOString();

export function id(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
