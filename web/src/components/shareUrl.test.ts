import assert from "node:assert/strict";
import { test } from "node:test";
import { shareUrl } from "./shareUrl.ts";

test("localhost proof QR uses a LAN host with the port and protocol actually serving the app", () => {
  assert.equal(shareUrl("/proof/req-demo", ["https://192.168.1.12:5173/phone"], "http://localhost:8787"), "http://192.168.1.12:8787/proof/req-demo");
  assert.equal(shareUrl("/phone", ["http://192.168.1.12:8787/phone"], "https://localhost:5173"), "https://192.168.1.12:5173/phone");
});

test("phone and proof QR preserve an advertised public HTTPS tunnel", () => {
  const urls = ["https://demo.example.com/phone", "http://192.168.1.12:5173/phone"];
  assert.equal(shareUrl("/phone", urls, "http://localhost:5173"), "https://demo.example.com/phone");
  assert.equal(shareUrl("/proof/req-demo", urls, "http://localhost:5173"), "https://demo.example.com/proof/req-demo");
});

test("a phone already visiting a reachable origin keeps that origin", () => {
  assert.equal(shareUrl("/proof/req-demo", ["http://192.168.1.12:5173/phone"], "http://192.168.1.12:8787"), "http://192.168.1.12:8787/proof/req-demo");
});

test("a secondary VPN interface does not replace the primary Wi-Fi address", () => {
  assert.equal(shareUrl("/phone", ["https://192.168.1.12:5173/phone", "https://100.64.1.2:5173/phone"], "http://localhost:8787"), "http://192.168.1.12:8787/phone");
});

test("invalid and non-web advertised URLs cannot become clickable evidence URLs", () => {
  assert.equal(shareUrl("/phone", ["invalid", "javascript:alert(1)", "http://localhost:5173/phone"], "https://demo.example.com"), "https://demo.example.com/phone");
});
