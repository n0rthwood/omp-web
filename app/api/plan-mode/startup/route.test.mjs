// Issue #161: `GET /api/plan-mode/startup` is the only pre-session answer to
// "which mode will this new chat start in?" — the composer reads it before the
// first prompt exists. Contract: `{enabled, planFilePath?, available}` derived
// from `plan.defaultOnStartup` gated by `plan.enabled`, `available` defaulting
// to true when the key is absent.
// Individually runnable: bun test app/api/plan-mode/startup/route.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const ENV_KEYS = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];
const base = mkdtempSync(join(tmpdir(), "omp161-startup-route-"));

const { Settings } = await import("@oh-my-pi/pi-coding-agent");
const { GET } = await import("./route.ts");

const savedRuntime = globalThis.__ompRuntimePromise;

after(() => {
  globalThis.__ompRuntimePromise = savedRuntime;
  for (const key of ENV_KEYS) delete process.env[key];
  globalThis.__ompWebUsersCache = undefined;
  rmSync(base, { recursive: true, force: true });
});

/**
 * Serve the route against a hermetic `Settings.isolated` runtime.
 *
 * `Settings.init` is unusable here: it returns the live global singleton (or
 * the real `~/.omp/agent` when the options are not exactly right), so a test
 * built on it would read — and could rewrite — the developer's own config.
 */
async function withSettings(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_USERS_FILE = join(base, "absent-users.yml");
  delete process.env.OMP_WEB_SESSIONS_FILE;
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompRuntimePromise = Promise.resolve({
    agentDir: base,
    settings: Settings.isolated(overrides, { storage: null }),
    authStorage: {},
    modelRegistry: {},
  });
  try {
    return await fn();
  } finally {
    globalThis.__ompRuntimePromise = savedRuntime;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.__ompWebUsersCache = undefined;
  }
}

function get(query = "") {
  return new Request(`http://localhost/api/plan-mode/startup${query}`, { headers: { host: "localhost" } });
}

async function json(res) {
  return { status: res.status, body: await res.json() };
}

// The gateway can only answer for a new chat's mode if the fleet proxy is
// allowed to forward this route; a missing allow-list row would 404 there.
const { isProxyablePath } = await import("@/lib/machines/proxy-allowlist");

test("startup route is proxyable through the fleet allow-list", () => {
  assert.equal(isProxyablePath("GET", "/api/plan-mode/startup"), true);
  assert.equal(isProxyablePath("POST", "/api/plan-mode/startup"), false);
});

test("startup route: defaultOnStartup on + plan enabled → plan mode with the default plan file", async () => {
  await withSettings({ "plan.defaultOnStartup": true, "plan.enabled": true }, async () => {
    const { status, body } = await json(await GET(get()));
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: true, planFilePath: "local://PLAN.md", available: true });
  });
});

test("startup route: defaultOnStartup off → execute, no plan file", async () => {
  await withSettings({ "plan.defaultOnStartup": false, "plan.enabled": true }, async () => {
    const { status, body } = await json(await GET(get()));
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false, available: true });
  });
});

test("startup route: plan.enabled=false forces execute even with defaultOnStartup on", async () => {
  await withSettings({ "plan.defaultOnStartup": true, "plan.enabled": false }, async () => {
    const { status, body } = await json(await GET(get()));
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false, available: false });
  });
});

test("startup route: an absent plan.enabled key counts as available", async () => {
  await withSettings({ "plan.defaultOnStartup": true }, async () => {
    const { status, body } = await json(await GET(get()));
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: true, planFilePath: "local://PLAN.md", available: true });
  });
});

test("startup route: a cwd is accepted and answered from the same settings", async () => {
  const project = join(base, "proj-161");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });
  await withSettings({ "plan.defaultOnStartup": true }, async () => {
    const { status, body } = await json(await GET(get(`?cwd=${encodeURIComponent(project)}`)));
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: true, planFilePath: "local://PLAN.md", available: true });
  });
});