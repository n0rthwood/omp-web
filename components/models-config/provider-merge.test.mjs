import assert from "node:assert/strict";
import test from "node:test";

import { mergeProviderRows, providerLoggedOut, providerRowGroup } from "./provider-merge.ts";

const oauth = (id, overrides = {}) => ({ id, name: id, usesCallbackServer: false, loggedIn: true, ...overrides });
const apiKey = (id, overrides = {}) => ({ id, displayName: id, configured: true, modelCount: 3, ...overrides });

test("a provider defined in both the catalog and models.yml renders once, as an override", () => {
  const rows = mergeProviderRows(
    [oauth("anthropic", { loggedIn: false })],
    [apiKey("zhipu-coding-plan", { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", envVar: "ZHIPU_API_KEY" })],
    { "zhipu-coding-plan": { models: [{ id: "glm-5.3" }] } },
  );

  const zhipu = rows.filter((row) => row.id === "zhipu-coding-plan");
  assert.equal(zhipu.length, 1);
  assert.equal(zhipu[0].tag, "override");
  assert.deepEqual(zhipu[0].sources, ["api_key", "config"]);
  assert.equal(providerRowGroup(zhipu[0]), "config");
});

test("a models.yml-only provider is tagged custom and grouped under the config file", () => {
  const rows = mergeProviderRows([], [], { joyai: { models: [{ id: "deepseek-chat" }] } });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].tag, "custom");
  assert.equal(providerRowGroup(rows[0]), "config");
});

test("a catalog provider whose key came from models.yml is not listed as an API-key row", () => {
  // `collectProviderListingInputs` already drops config-source providers from
  // the API-key listing; a row that still arrives here must not be grouped as
  // an API key either, because models.yml owns it.
  const rows = mergeProviderRows([], [apiKey("bailian-token-plan")], { "bailian-token-plan": { apiKey: "BAILIAN_API_KEY" } });

  assert.equal(rows.length, 1);
  assert.equal(providerRowGroup(rows[0]), "config");
});

test("a logged-in subscription is grouped under OAuth, a stored key under API key", () => {
  const rows = mergeProviderRows(
    [oauth("openai-codex", { name: "ChatGPT Plus/Pro" }), oauth("xai-oauth", { loggedIn: false })],
    [apiKey("google"), apiKey("xai", { configured: false })],
    {},
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(providerRowGroup(byId.get("openai-codex")), "oauth");
  assert.equal(providerRowGroup(byId.get("google")), "api_key");
  // Not configured anywhere: reachable from "+ Add provider", not listed.
  assert.equal(byId.has("xai"), false);
  assert.equal(byId.has("xai-oauth"), false);
});

test("an OAuth provider that also has a models.yml entry keeps both sources on one row", () => {
  const rows = mergeProviderRows([oauth("anthropic")], [], { anthropic: { baseUrl: "https://api.anthropic.com" } });

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].sources, ["oauth", "config"]);
  assert.equal(providerRowGroup(rows[0]), "config");
});

test("an OAuth-capable provider running on its API key is not logged out", () => {
  // OpenRouter, xAI and Zhipu sit in the OAuth listing while they run on a key.
  const [row] = mergeProviderRows([oauth("openrouter", { loggedIn: false })], [apiKey("openrouter")], {});
  assert.equal(providerLoggedOut(row, { state: "ok" }), false);
});

test("a key declared in models.yml is a credential even though the row is not `configured`", () => {
  const [row] = mergeProviderRows(
    [oauth("alibaba-token-plan", { loggedIn: false })],
    [],
    { "alibaba-token-plan": { baseUrl: "https://dashscope.aliyuncs.com", api: "openai-completions" } },
  );

  assert.equal(row.configured, false);
  assert.equal(providerLoggedOut(row, { state: "ok" }), false);
});

test("an OAuth provider with no login and no key is logged out", () => {
  const [row] = mergeProviderRows(
    [oauth("anthropic", { loggedIn: false })],
    [],
    { anthropic: { baseUrl: "https://api.anthropic.com" } },
  );

  assert.equal(providerLoggedOut(row, { state: "missing", cause: "No credentials configured" }), true);
});

test("a failed login or a pending scan does not grey the table", () => {
  const [row] = mergeProviderRows(
    [oauth("anthropic", { loggedIn: false })],
    [],
    { anthropic: { baseUrl: "https://api.anthropic.com" } },
  );

  // A tombstone is the red "credential invalid" badge, not a dimmed table.
  assert.equal(providerLoggedOut(row, { state: "disabled", cause: "oauth refresh failed" }), false);
  // Before the first scan nothing is known; dimming everything would flash.
  assert.equal(providerLoggedOut(row, undefined), false);
});

test("an OAuth provider left with only a disabled credential stays listed, with the logins", () => {
  // An expired subscription must stay reachable: its card is where the login is redone.
  const [row] = mergeProviderRows([oauth("xai-oauth", { loggedIn: false, hasCredentialHistory: true })], [], {});

  assert.equal(row.id, "xai-oauth");
  assert.equal(providerRowGroup(row), "oauth");
});

test("a catalog provider that never held a credential is still not listed", () => {
  const rows = mergeProviderRows([oauth("xai-oauth", { loggedIn: false })], [], {});

  assert.equal(rows.length, 0);
});

test("a provider running on its API key stays under API key despite an old failed login", () => {
  const [row] = mergeProviderRows(
    [oauth("openrouter", { loggedIn: false, hasCredentialHistory: true })],
    [apiKey("openrouter")],
    {},
  );

  assert.equal(providerRowGroup(row), "api_key");
});