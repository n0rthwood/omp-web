// Guards GET /api/models (#144): every listed model carries its catalog facts,
// and the project-less `?all=1` read that feeds the provider table is served
// instead of being answered with the access check's 403.
// Individually runnable: bun test app/api/models/route.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Hermetic agent dir BEFORE any SDK import: lib/omp-runtime → pi-coding-agent
// default their stores to ~/.omp/agent.
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const base = mkdtempSync(join(tmpdir(), "omp144-models-route-"));
setAgentDir(join(base, "agent"));

const saved = {
  disable: process.env.OMP_WEB_MODELS_HEALTH_DISABLE,
  key: process.env.OPENROUTER_API_KEY,
  runtime: globalThis.__ompRuntimePromise,
  cache: globalThis.__ompModelsCacheState,
  roots: globalThis.__ompAllowedRootsCache,
};
// Never auto-start the process-wide health poller from a test import.
process.env.OMP_WEB_MODELS_HEALTH_DISABLE = "1";
// A catalog provider only lists as available with a concrete key; the value is
// never sent anywhere (no request is made in this test).
process.env.OPENROUTER_API_KEY = "omp144-route-test-key";
globalThis.__ompModelsCacheState = undefined;
// No directory is browsable for this process: a request that resolves a `cwd`
// must be refused, which is exactly what used to happen to the project-less
// `?all=1` call.
globalThis.__ompAllowedRootsCache = { roots: new Set(), expiresAt: Date.now() + 60_000 };

const { AuthStorage, ModelRegistry, Settings } = await import("@oh-my-pi/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

// A real registry over the bundled catalog, with no refresh: nothing here
// reaches the network or ~/.omp.
const authStorage = await AuthStorage.create(join(base, "auth.db"));
const modelRegistry = new ModelRegistry(authStorage);
globalThis.__ompRuntimePromise = Promise.resolve({
  agentDir: join(base, "agent"),
  settings: await Settings.init({ agentDir: join(base, "agent") }),
  authStorage,
  modelRegistry,
});

test.after(() => {
  for (const [key, value] of [["OMP_WEB_MODELS_HEALTH_DISABLE", saved.disable], ["OPENROUTER_API_KEY", saved.key]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__ompRuntimePromise = saved.runtime;
  globalThis.__ompModelsCacheState = saved.cache;
  globalThis.__ompAllowedRootsCache = saved.roots;
  rmSync(base, { recursive: true, force: true });
});

const call = (query) => GET(new Request(`http://localhost/api/models${query}`));

test("?all=1 without a cwd is served instead of falling through to a 403", async () => {
  const res = await call("?all=1");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.modelError, undefined);
  // The provider table reads health from this same response.
  assert.equal(typeof data.modelHealth, "object");
});

test("every listed model carries its catalog facts", async () => {
  const data = await (await call("?all=1")).json();
  const openrouter = data.modelList.filter((model) => model.provider === "openrouter");
  // Not the allow-list's handful: the provider's whole available catalog.
  assert.ok(openrouter.length > 7, `expected the untrimmed list, got ${openrouter.length}`);
  assert.equal(openrouter.length, modelRegistry.getAvailable().filter((model) => model.provider === "openrouter").length);

  const withWindow = openrouter.find((model) => typeof model.contextWindow === "number");
  assert.ok(withWindow, "a bundled openrouter row has a real context window");
  assert.ok(withWindow.contextWindow > 0);
  assert.deepEqual(Object.keys(withWindow.cost).sort(), ["cacheRead", "cacheWrite", "input", "output"]);
  assert.equal(typeof withWindow.cost.input, "number");
  assert.ok(Array.isArray(withWindow.input));
  assert.equal(typeof withWindow.reasoning, "boolean");
  // Supported efforts ride along for the Thinking column.
  assert.ok(Array.isArray(data.thinkingLevels[`${withWindow.provider}:${withWindow.id}`]));
});

test("a null catalog window is left out rather than sent as a number", async () => {
  const data = await (await call("?all=1")).json();
  for (const model of data.modelList) {
    if (model.contextWindow !== undefined) assert.equal(typeof model.contextWindow, "number");
    if (model.maxTokens !== undefined) assert.equal(typeof model.maxTokens, "number");
  }
  // The picker-facing shape is unchanged: id / name / provider lead each row.
  assert.deepEqual(Object.keys(data.modelList[0]).slice(0, 3), ["id", "name", "provider"]);
});

test("a cwd that is given is still access-checked", async () => {
  const project = join(base, "project");
  mkdirSync(project);
  assert.equal((await call(`?all=1&cwd=${encodeURIComponent(project)}`)).status, 403);
  assert.equal((await call(`?cwd=${encodeURIComponent(project)}`)).status, 403);
  assert.equal((await call(`?cwd=${encodeURIComponent(join(base, "missing"))}`)).status, 400);
});

test("the scoped picker call keeps requiring a project directory", async () => {
  // Only the catalog read (`?all=1`) was made project-less (#144).
  assert.equal((await call("")).status, 403);
});
