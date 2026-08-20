import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const onAuthSource = source.slice(
  source.indexOf("onAuth: (info: OAuthAuthInfo)"),
  source.indexOf("onProgress:"),
);

test("auth SSE event forwards the real provider authorization URL, never the SDK loopback launchUrl", () => {
  // Regression for #26: a remote browser can never reach this server's own
  // localhost callback listener, so `info.launchUrl` (an SDK-hosted loopback
  // shortcut) must never become the browser-facing `url`. Given both an
  // `info.launchUrl` (e.g. "http://localhost:1455/auth/callback") and a real
  // `info.url` (e.g. "https://console.anthropic.com/oauth/authorize?..."),
  // the payload sent to the browser must resolve to `info.url`.
  assert.match(onAuthSource, /url:\s*info\.url,/);
  assert.doesNotMatch(onAuthSource, /info\.launchUrl/);
  assert.doesNotMatch(onAuthSource, /fullUrl/);
});
