import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const SAVED_ENV = {
  OMP_WEB_PASSWORD: process.env.OMP_WEB_PASSWORD,
  OMP_WEB_USERS_FILE: process.env.OMP_WEB_USERS_FILE,
  OMP_WEB_SESSIONS_FILE: process.env.OMP_WEB_SESSIONS_FILE,
  OMP_WEB_MACHINES_FILE: process.env.OMP_WEB_MACHINES_FILE,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
}

function freshStores() {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-machine-proxy-"));
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  process.env.OMP_WEB_MACHINES_FILE = join(dir, "machines.json");
  delete process.env.OMP_WEB_PASSWORD;
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
  return dir;
}

async function loadLibs() {
  const users = await jiti.import("../../../../lib/web-users.ts");
  const sessions = await jiti.import("../../../../lib/web-sessions.ts");
  const machineStore = await jiti.import("../../../../lib/machines/machine-store.ts");
  return { users, sessions, machineStore };
}

async function loadRoute() {
  return jiti.import("./[...path]/route.ts");
}

async function loginAs(username) {
  const { sessions } = await loadLibs();
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

async function seed() {
  const { users, machineStore } = await loadLibs();
  users.writeWebUsersConfig({
    users: [
      {
        username: "root",
        role: "admin",
        passwordHash: users.hashWebPassword("root-pass-1"),
        projects: "*",
        machines: "*",
        tokens: [],
      },
      {
        username: "granted",
        role: "user",
        passwordHash: users.hashWebPassword("granted-pass-1"),
        projects: "*",
        machines: ["gpu-1"],
        tokens: [],
      },
      {
        username: "outsider",
        role: "user",
        passwordHash: users.hashWebPassword("outsider-pass-1"),
        projects: "*",
        machines: [],
        tokens: [],
      },
      {
        username: "limited",
        role: "user",
        passwordHash: users.hashWebPassword("limited-pass-1"),
        projects: ["/opt/granted/a", "/opt/granted/b"],
        machines: ["gpu-1"],
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  machineStore.createMachine({ id: "gpu-1", name: "GPU 1", baseUrl: "http://gpu-1.local", authMode: "none" });
}

function apiRequest(path, { method = "GET", cookie } = {}) {
  const headers = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, { method, headers });
}

function params(value) {
  return { params: Promise.resolve(value) };
}

/** Stub global fetch so a "forwarded" assertion never touches the network. */
async function withStubbedFetch(body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Stub global fetch so a "forwarded" assertion never touches the network, with a caller-supplied JSON payload. */
async function withStubbedSessionList(payload, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Stub global fetch with a raw caller-built Response (non-JSON / error-status cases). */
async function withStubbedRawResponse(response, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return response;
  };
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const REMOTE_SESSIONS = {
  sessions: [
    { id: "s-granted", cwd: "/opt/granted/a", projectRoot: "/opt/granted/a", name: "granted one" },
    { id: "s-other", cwd: "/opt/other/wsc_dev", projectRoot: "/opt/other/wsc_dev", name: "wsc dev" },
    { id: "s-worktree", cwd: "/opt/granted/b-wt", projectRoot: "/opt/granted/b", name: "worktree" },
  ],
  runningSessionIds: ["s-granted", "s-other"],
};

test("granted user + non-admin inner path is forwarded to the machine", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const { GET } = await loadRoute();

  const { result, calls } = await withStubbedFetch(() =>
    GET(apiRequest("/api/machines/gpu-1/api/health", { cookie }), params({ machineId: "gpu-1", path: ["api", "health"] })),
  );
  assert.equal(calls.length, 1, "the request must reach the stubbed remote transport");
  assert.equal(calls[0].url, "http://gpu-1.local/api/health");
  assert.equal(result.status, 200);
});

test("ungranted user on an existing machine -> 403 No permission", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("outsider");
  const { GET } = await loadRoute();

  const response = await GET(
    apiRequest("/api/machines/gpu-1/api/health", { cookie }),
    params({ machineId: "gpu-1", path: ["api", "health"] }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "No permission for this machine" });
});

test("unknown machine -> 404 Machine not found, distinct from the 403 above", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const { GET } = await loadRoute();

  const response = await GET(
    apiRequest("/api/machines/does-not-exist/api/health", { cookie }),
    params({ machineId: "does-not-exist", path: ["api", "health"] }),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Machine not found" });
});

test("granted user on an inner admin-only surface -> 403 Admin access required", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const { PUT } = await loadRoute();

  const { result, calls } = await withStubbedFetch(() =>
    PUT(
      apiRequest("/api/machines/gpu-1/api/models-config", { method: "PUT", cookie }),
      params({ machineId: "gpu-1", path: ["api", "models-config"] }),
    ),
  );
  assert.equal(result.status, 403);
  assert.deepEqual(await result.json(), { error: "Admin access required" });
  assert.equal(calls.length, 0, "an inner admin surface must never reach the remote");
});

test("granted user cannot install or update skills through the proxy", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const { POST } = await loadRoute();

  const { result, calls } = await withStubbedFetch(() =>
    POST(
      apiRequest("/api/machines/gpu-1/api/skills/install", { method: "POST", cookie }),
      params({ machineId: "gpu-1", path: ["api", "skills", "install"] }),
    ),
  );
  assert.equal(result.status, 403);
  assert.deepEqual(await result.json(), { error: "Admin access required" });
  assert.equal(calls.length, 0, "skill installs must never reach the remote for a non-admin");
});

test("inner /api/machines and /api/web-users surfaces are admin-only at the guard layer itself", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const { GET, POST } = await loadRoute();

  // Even if the transport allow-list were ever widened, the grant guard must
  // independently refuse fleet-management surfaces on the remote (two-layer
  // discipline). Nested fleet-in-fleet is the shape that reaches these.
  const nested = params({ machineId: "gpu-1", path: ["api", "machines", "other", "api", "web-users"] });
  const { result, calls } = await withStubbedFetch(() =>
    GET(apiRequest("/api/machines/gpu-1/api/machines/other/api/web-users", { cookie }), nested),
  );
  assert.equal(result.status, 403);
  assert.deepEqual(await result.json(), { error: "Admin access required" });
  assert.equal(calls.length, 0);

  const innerUsers = params({ machineId: "gpu-1", path: ["api", "web-users"] });
  const response = await POST(
    apiRequest("/api/machines/gpu-1/api/web-users", { method: "POST", cookie }),
    innerUsers,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Admin access required" });
});

test("admin passes through an inner admin-only surface unchanged", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("root");
  const { PUT } = await loadRoute();

  const { result, calls } = await withStubbedFetch(() =>
    PUT(
      apiRequest("/api/machines/gpu-1/api/models-config", { method: "PUT", cookie }),
      params({ machineId: "gpu-1", path: ["api", "models-config"] }),
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(result.status, 200);
});

test("proxying to \"local\" -> 400, for both admin and granted users", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { GET } = await loadRoute();

  const asAdmin = await GET(
    apiRequest("/api/machines/local/api/health", { cookie: await loginAs("root") }),
    params({ machineId: "local", path: ["api", "health"] }),
  );
  assert.equal(asAdmin.status, 400);

  const asGranted = await GET(
    apiRequest("/api/machines/local/api/health", { cookie: await loginAs("granted") }),
    params({ machineId: "local", path: ["api", "health"] }),
  );
  assert.equal(asGranted.status, 400);
});

test("a non-allow-listed remote path -> 403 Proxy path not allowed", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const { GET } = await loadRoute();

  const response = await GET(
    apiRequest("/api/machines/gpu-1/api/definitely-not-a-real-route", { cookie }),
    params({ machineId: "gpu-1", path: ["api", "definitely-not-a-real-route"] }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Proxy path not allowed" });
});

test("limited granted user's proxied session list drops non-granted sessions", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { GET } = await loadRoute();

  const { result } = await withStubbedSessionList(REMOTE_SESSIONS, () =>
    GET(apiRequest("/api/machines/gpu-1/api/sessions", { cookie }), params({ machineId: "gpu-1", path: ["api", "sessions"] })),
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "application/json");
  const body = await result.json();
  const ids = body.sessions.map((s) => s.id);
  assert.deepEqual(ids.sort(), ["s-granted", "s-worktree"]);
  assert.deepEqual(body.runningSessionIds, ["s-granted"]);
});

test("admin's proxied session list is byte-identical to the remote payload", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("root");
  const { GET } = await loadRoute();

  const { result } = await withStubbedSessionList(REMOTE_SESSIONS, () =>
    GET(apiRequest("/api/machines/gpu-1/api/sessions", { cookie }), params({ machineId: "gpu-1", path: ["api", "sessions"] })),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), REMOTE_SESSIONS);
});

test("a user with projects: \"*\" sees the proxied session list unchanged", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const { GET } = await loadRoute();

  const { result } = await withStubbedSessionList(REMOTE_SESSIONS, () =>
    GET(apiRequest("/api/machines/gpu-1/api/sessions", { cookie }), params({ machineId: "gpu-1", path: ["api", "sessions"] })),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), REMOTE_SESSIONS);
});

test("an SSE session-list response passes through untouched", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { GET } = await loadRoute();

  const streamed = "event: sessions\ndata: {\"sessions\":[]}\n\n";
  const stub = new Response(streamed, { status: 200, headers: { "content-type": "text/event-stream" } });
  const { result } = await withStubbedRawResponse(stub, () =>
    GET(apiRequest("/api/machines/gpu-1/api/sessions", { cookie }), params({ machineId: "gpu-1", path: ["api", "sessions"] })),
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.equal(await result.text(), streamed);
});

test("a 502 session-list error response passes through unchanged", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { GET } = await loadRoute();

  const errorBody = JSON.stringify({ error: "bad gateway" });
  const stub = new Response(errorBody, { status: 502, headers: { "content-type": "application/json" } });
  const { result } = await withStubbedRawResponse(stub, () =>
    GET(apiRequest("/api/machines/gpu-1/api/sessions", { cookie }), params({ machineId: "gpu-1", path: ["api", "sessions"] })),
  );
  assert.equal(result.status, 502);
  assert.equal(await result.text(), errorBody);
});

test("the session-detail proxy path is not filtered", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { GET } = await loadRoute();

  const { result } = await withStubbedSessionList(REMOTE_SESSIONS, () =>
    GET(
      apiRequest("/api/machines/gpu-1/api/sessions/some-id", { cookie }),
      params({ machineId: "gpu-1", path: ["api", "sessions", "some-id"] }),
    ),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), REMOTE_SESSIONS);
});

test("?force=1 on the session-list route is still filtered", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { GET } = await loadRoute();

  const { result } = await withStubbedSessionList(REMOTE_SESSIONS, () =>
    GET(
      apiRequest("/api/machines/gpu-1/api/sessions?force=1", { cookie }),
      params({ machineId: "gpu-1", path: ["api", "sessions"] }),
    ),
  );
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(
    body.sessions.map((s) => s.id).sort(),
    ["s-granted", "s-worktree"],
  );
});

test("provider refresh forwards the JSON body for admins but denies granted non-admins", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const admin = await loginAs("root");
  const granted = await loginAs("granted");
  const { POST } = await loadRoute();
  const path = "/api/machines/gpu-1/api/models-config/refresh-provider";
  const context = params({ machineId: "gpu-1", path: ["api", "models-config", "refresh-provider"] });
  const request = (cookie) => new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify({ providerName: "my-provider" }),
  });

  const denied = await withStubbedFetch(() => POST(request(granted), context));
  assert.equal(denied.result.status, 403);
  assert.deepEqual(await denied.result.json(), { error: "Admin access required" });
  assert.equal(denied.calls.length, 0);

  const forwarded = await withStubbedFetch(() => POST(request(admin), context));
  assert.equal(forwarded.result.status, 200);
  assert.equal(forwarded.calls.length, 1);
  assert.equal(forwarded.calls[0].url, "http://gpu-1.local/api/models-config/refresh-provider");
  assert.equal(forwarded.calls[0].init.method, "POST");
  assert.equal(forwarded.calls[0].init.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(await new Response(forwarded.calls[0].init.body).text()), { providerName: "my-provider" });
});

const REMOTE_STATIC_LIST = {
  machineId: "gpu-1",
  mappings: [
    { id: "m-visible", projectRoot: "/opt/granted/a", publicPath: "/static/gpu-1/m-visible/index.html" },
    { id: "m-hidden", projectRoot: "/opt/other", publicPath: "/static/gpu-1/m-hidden/index.html" },
    { id: "m-legacy", publicPath: "/static/gpu-1/m-legacy/index.html" },
  ],
};

test("limited user's proxied static list drops hidden and legacy rows without forwarding browser credentials", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { GET } = await loadRoute();

  const { result, calls } = await withStubbedSessionList(REMOTE_STATIC_LIST, () =>
    GET(apiRequest("/api/machines/gpu-1/api/static-mappings", { cookie }), params({ machineId: "gpu-1", path: ["api", "static-mappings"] })),
  );
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.mappings.map((m) => m.id), ["m-visible"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gpu-1.local/api/static-mappings");
  const outbound = new Headers(calls[0].init.headers);
  assert.equal(outbound.get("cookie"), null);
  assert.equal(outbound.get("authorization"), null);
});

test("admin's proxied static list is byte-identical; '*' user keeps rooted rows but not legacy", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { GET } = await loadRoute();
  const context = params({ machineId: "gpu-1", path: ["api", "static-mappings"] });
  const rootCookie = await loginAs("root");
  const admin = await withStubbedSessionList(REMOTE_STATIC_LIST, () =>
    GET(apiRequest("/api/machines/gpu-1/api/static-mappings", { cookie: rootCookie }), context),
  );
  assert.deepEqual((await admin.result.json()).mappings.map((m) => m.id), ["m-visible", "m-hidden", "m-legacy"]);

  const starCookie = await loginAs("granted");
  const star = await withStubbedSessionList(REMOTE_STATIC_LIST, () =>
    GET(apiRequest("/api/machines/gpu-1/api/static-mappings", { cookie: starCookie }), context),
  );
  assert.deepEqual((await star.result.json()).mappings.map((m) => m.id), ["m-visible", "m-hidden"]);
});

test("proxied static item read hides non-granted rows as 404 for limited users", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { GET } = await loadRoute();
  const context = params({ machineId: "gpu-1", path: ["api", "static-mappings", "m-hidden"] });

  const hidden = await withStubbedSessionList({ mapping: { id: "m-hidden", projectRoot: "/opt/other" } }, () =>
    GET(apiRequest("/api/machines/gpu-1/api/static-mappings/m-hidden", { cookie }), context),
  );
  assert.equal(hidden.result.status, 404);

  const visible = await withStubbedSessionList({ mapping: { id: "m-visible", projectRoot: "/opt/granted/a" } }, () =>
    GET(apiRequest("/api/machines/gpu-1/api/static-mappings/m-visible", { cookie }), params({ machineId: "gpu-1", path: ["api", "static-mappings", "m-visible"] })),
  );
  assert.equal(visible.result.status, 200);
});

test("proxied static PATCH is project-gated before forwarding; hidden rows never reach the remote mutation", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { PATCH } = await loadRoute();
  const context = params({ machineId: "gpu-1", path: ["api", "static-mappings", "m-hidden"] });
  const patchRequest = new Request("http://localhost/api/machines/gpu-1/api/static-mappings/m-hidden", {
    method: "PATCH",
    headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "nope" }),
  });

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === "GET") {
      return new Response(JSON.stringify({ mapping: { id: "m-hidden", projectRoot: "/opt/other" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const denied = await PATCH(patchRequest, context);
    assert.equal(denied.status, 404);
    assert.equal(calls.length, 1, "only the read probe runs; the mutation is never forwarded");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].url, "http://gpu-1.local/api/static-mappings/m-hidden");
    const outbound = new Headers(calls[0].init.headers);
    assert.equal(outbound.get("cookie"), null);
    assert.equal(outbound.get("authorization"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("proxied static PATCH for a visible row probes then forwards; admin skips the probe", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { PATCH } = await loadRoute();
  const context = params({ machineId: "gpu-1", path: ["api", "static-mappings", "m-visible"] });
  const makeRequest = (cookie) => new Request("http://localhost/api/machines/gpu-1/api/static-mappings/m-visible", {
    method: "PATCH",
    headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify({ label: "ok" }),
  });

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === "GET") {
      return new Response(JSON.stringify({ mapping: { id: "m-visible", projectRoot: "/opt/granted/a" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ mapping: { id: "m-visible", label: "ok" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const limited = await PATCH(makeRequest(await loginAs("limited")), context);
    assert.equal(limited.status, 200);
    assert.deepEqual(calls.map((call) => call.init.method), ["GET", "PATCH"]);

    calls.length = 0;
    const admin = await PATCH(makeRequest(await loginAs("root")), context);
    assert.equal(admin.status, 200);
    assert.deepEqual(calls.map((call) => call.init.method), ["PATCH"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("proxied static create is project-gated before forwarding; invisible root never reaches the remote", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { POST } = await loadRoute();
  const context = params({ machineId: "gpu-1", path: ["api", "static-mappings"] });
  const makeRequest = (projectRoot) => new Request("http://localhost/api/machines/gpu-1/api/static-mappings", {
    method: "POST",
    headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "m-new", persistent: true, projectRoot }),
  });

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ mapping: { id: "m-new" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    // Invisible root: rejected before any upstream fetch.
    const denied = await POST(makeRequest("/opt/other"), context);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).field, "projectRoot");
    assert.equal(calls.length, 0, "invisible root is rejected before forwarding");

    // Visible root with a messy form: normalized and forwarded, no browser creds.
    const ok = await POST(makeRequest("/opt//granted/./a/"), context);
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://gpu-1.local/api/static-mappings");
    const outbound = new Headers(calls[0].init.headers);
    assert.equal(outbound.get("cookie"), null);
    assert.equal(outbound.get("authorization"), null);
    const forwarded = JSON.parse(await new Response(calls[0].init.body).text());
    assert.equal(forwarded.projectRoot, "/opt/granted/a");

    // Admin forwards unchanged (no gate, no rewrite).
    calls.length = 0;
    const adminCookie = await loginAs("root");
    const adminReq = new Request("http://localhost/api/machines/gpu-1/api/static-mappings", {
      method: "POST",
      headers: { host: "localhost", cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "m-admin", persistent: true, projectRoot: "/opt/elsewhere" }),
    });
    const admin = await POST(adminReq, context);
    assert.equal(admin.status, 200);
    assert.equal(calls.length, 1);
    const adminForwarded = JSON.parse(await new Response(calls[0].init.body).text());
    assert.equal(adminForwarded.projectRoot, "/opt/elsewhere");
  } finally {
    globalThis.fetch = original;
  }
});

test("proxied static create rejects a malformed projectRoot before forwarding", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("limited");
  const { POST } = await loadRoute();
  const context = params({ machineId: "gpu-1", path: ["api", "static-mappings"] });
  const request = new Request("http://localhost/api/machines/gpu-1/api/static-mappings", {
    method: "POST",
    headers: { host: "localhost", cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "m-bad", persistent: true, projectRoot: "relative/path" }),
  });

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const denied = await POST(request, context);
    assert.equal(denied.status, 400);
    assert.equal((await denied.json()).field, "projectRoot");
    assert.equal(calls.length, 0, "malformed root never reaches the remote");
  } finally {
    globalThis.fetch = original;
  }
});
