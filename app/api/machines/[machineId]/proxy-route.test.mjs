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
