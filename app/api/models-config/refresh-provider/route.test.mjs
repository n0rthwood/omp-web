import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "bun:sqlite";
import { AuthStorage, ModelRegistry, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { loadModelsWithCache } = await jiti.import("../../../../lib/models-cache.ts");
const users = await jiti.import("../../../../lib/web-users.ts");
const sessions = await jiti.import("../../../../lib/web-sessions.ts");

function fixture(t, modelRegistry) {
  const dir = mkdtempSync(join(tmpdir(), "omp-provider-refresh-"));
  const keys = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];
  const environment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previous = {
    runtime: globalThis.__ompRuntimePromise,
    modelsCache: globalThis.__ompModelsCacheState,
    users: globalThis.__ompWebUsersCache,
    sessions: globalThis.__ompWebSessions,
  };
  delete process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompModelsCacheState = undefined;
  const runtime = Promise.resolve({ modelRegistry });
  globalThis.__ompRuntimePromise = runtime;
  t.after(() => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.__ompRuntimePromise = previous.runtime;
    globalThis.__ompModelsCacheState = previous.modelsCache;
    globalThis.__ompWebUsersCache = previous.users;
    globalThis.__ompWebSessions = previous.sessions;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, runtime };
}

function request(body, options = {}) {
  const headers = new Headers({ host: options.host ?? "localhost" });
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  return new Request("http://localhost/api/models-config/refresh-provider", {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

function fakeRegistry(overrides = {}) {
  return {
    hasProvider: (name) => name === "test-provider",
    refreshProvider: async () => {},
    getProviderDiscoveryState: () => ({ status: "ok", stale: false }),
    getError: () => undefined,
    ...overrides,
  };
}

function data(label) {
  return {
    models: { "test-provider:model": label },
    modelList: [{ id: label, name: label, provider: "test-provider" }],
    defaultModel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
    thinkingLevelPins: {},
    roles: [],
  };
}

function cookieFor(username) {
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

test("rejects untrusted requests, non-JSON and invalid bodies before refreshing", async (t) => {
  let calls = 0;
  fixture(t, fakeRegistry({ refreshProvider: async () => { calls += 1; } }));

  assert.equal((await POST(request({ providerName: "test-provider" }, { host: "evil.invalid" }))).status, 403);
  assert.equal((await POST(request({ providerName: "test-provider" }, { origin: "http://evil.invalid" }))).status, 403);
  assert.equal((await POST(request({}, { contentType: null }))).status, 415);
  assert.equal((await POST(request(undefined, { raw: "{" }))).status, 400);
  for (const body of [null, [], "test-provider", {}, { providerName: "  " }, { providerName: 12 }]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "providerName is required" });
  }
  assert.equal(calls, 0);
});

test("requires an administrator even if the route is called directly", async (t) => {
  let calls = 0;
  fixture(t, fakeRegistry({ refreshProvider: async () => { calls += 1; } }));
  users.writeWebUsersConfig({
    users: [
      { username: "root", role: "admin", passwordHash: users.hashWebPassword("root-pass-1"), projects: "*", machines: "*", tokens: [] },
      { username: "viewer", role: "user", passwordHash: users.hashWebPassword("viewer-pass-1"), projects: "*", machines: "*", tokens: [] },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });

  const unauthenticated = await POST(request({ providerName: "test-provider" }));
  const denied = await POST(request({ providerName: "test-provider" }, { cookie: cookieFor("viewer") }));
  assert.equal(unauthenticated.status, 403);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Admin access required" });
  assert.equal(calls, 0);

  const allowed = await POST(request({ providerName: "test-provider" }, { cookie: cookieFor("root") }));
  assert.equal(allowed.status, 200);
  assert.equal(calls, 1);
});

test("refreshes the shared registry online, forces command credentials, and expires model caches", async (t) => {
  let version = "old";
  let loads = 0;
  let args;
  const registry = fakeRegistry({ refreshProvider: async (...received) => { args = received; version = "new"; } });
  const { runtime } = fixture(t, registry);
  const loader = async () => { loads += 1; return data(version); };
  await loadModelsWithCache("/first", loader);
  await loadModelsWithCache("/second", loader);

  const response = await POST(request({ providerName: "  test-provider  " }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, discoveryStatus: "ok" });
  assert.deepEqual(args, ["test-provider", "online", { refreshCommandCredentials: true }]);
  assert.strictEqual(globalThis.__ompRuntimePromise, runtime);
  assert.strictEqual((await runtime).modelRegistry, registry);
  assert.equal((await loadModelsWithCache("/first", loader)).modelList[0].id, "new");
  assert.equal((await loadModelsWithCache("/second", loader)).modelList[0].id, "new");
  assert.equal(loads, 4);
});

test("unknown providers are rejected before refresh", async (t) => {
  let calls = 0;
  fixture(t, fakeRegistry({ refreshProvider: async () => { calls += 1; } }));
  const response = await POST(request({ providerName: "not-configured" }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Unknown provider: not-configured" });
  assert.equal(calls, 0);
});

test("reports discovery and config failures, invalidating the cache even after partial mutation", async (t) => {
  let version = "old";
  let behavior = "";
  const registry = fakeRegistry({
    refreshProvider: async () => {
      version = behavior;
      if (behavior === "throw") throw new Error("partial refresh failed");
    },
    getError: () => behavior === "config" ? { message: "invalid model configuration" }
      : behavior === "config-empty" ? { message: "" } : undefined,
    getProviderDiscoveryState: () => {
      if (behavior === "cached-error") return { status: "cached", stale: false, error: "upstream failed" };
      if (behavior === "cached") return { status: "cached", stale: true };
      if (behavior === "stale") return { status: "ok", stale: true };
      return { status: behavior, stale: false };
    },
  });
  const { runtime } = fixture(t, registry);
  const loader = async () => data(version);
  for (const failure of ["throw", "config", "config-empty", "unavailable", "unauthenticated", "idle", "cached-error", "cached", "stale"]) {
    version = "old";
    await loadModelsWithCache(`/failure-${failure}`, loader);
    behavior = failure;
    const response = await POST(request({ providerName: "test-provider" }));
    const body = await response.json();
    assert.equal(response.status, 502, failure);
    assert.equal(typeof body.error, "string", failure);
    assert.ok(body.error.length > 0 && body.error.length <= 500, failure);
    assert.equal(body.success, undefined, failure);
    assert.equal((await loadModelsWithCache(`/failure-${failure}`, loader)).modelList[0].id, failure);
    assert.strictEqual(globalThis.__ompRuntimePromise, runtime);
  }
});

test("distinguishes empty and static/no-status providers without inventing discovery", async (t) => {
  let state;
  fixture(t, fakeRegistry({ getProviderDiscoveryState: () => state }));
  state = { status: "empty", stale: false };
  const emptyResponse = await POST(request({ providerName: "test-provider" }));
  const emptyBody = await emptyResponse.json();
  assert.equal(emptyResponse.status, 200);
  assert.equal(emptyBody.success, true);
  assert.equal(emptyBody.discoveryStatus, "empty");
  assert.equal(typeof emptyBody.warning, "string");
  state = undefined;
  const response = await POST(request({ providerName: "test-provider" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.discoveryStatus, undefined);
  assert.match(body.warning, /no online discovery status/i);
});

test("real SDK discovery updates the same registry and reports a cached upstream failure", async (t) => {
  const { dir, runtime } = fixture(t, undefined);
  const modelsPath = join(dir, "models.yml");
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      "fixture-provider": {
        api: "openai-completions",
        baseUrl: "http://provider.invalid/v1",
        auth: "none",
        discovery: { type: "openai-models-list" },
      },
    },
  }));
  const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
  t.after(() => auth.close());
  let offline = false;
  let calls = 0;
  const registry = new ModelRegistry(auth, modelsPath, {
    cacheDbPath: join(dir, "models.db"),
    fetch: async () => {
      calls += 1;
      if (offline) throw new Error("fixture upstream offline");
      return Response.json({ object: "list", data: [{ id: "fresh-model", object: "model" }] });
    },
  });
  // Replace only the object held by the existing runtime promise; a live
  // session would retain this same registry reference across both requests.
  (await runtime).modelRegistry = registry;
  assert.equal(registry.hasProvider("fixture-provider"), true);

  const success = await POST(request({ providerName: "fixture-provider" }));
  assert.equal(success.status, 200);
  assert.equal((await success.json()).discoveryStatus, "ok");
  assert.equal(registry.find("fixture-provider", "fresh-model")?.id, "fresh-model");
  assert.strictEqual((await runtime).modelRegistry, registry);

  offline = true;
  const failed = await POST(request({ providerName: "fixture-provider" }));
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /fixture upstream offline/);
  assert.equal(registry.getProviderDiscoveryState("fixture-provider")?.status, "cached");
  assert.equal(registry.find("fixture-provider", "fresh-model")?.id, "fresh-model");
  assert.equal(calls, 2);
});
