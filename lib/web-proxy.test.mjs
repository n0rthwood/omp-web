import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The middleware under test. Dynamic import keeps the heavier module graph
// (next/server + user store) out of every unrelated test file's startup.
async function loadProxy() {
  return import("../proxy.ts");
}

async function loadUsers() {
  return import("./web-users.ts");
}

async function loadSessions() {
  return import("./web-sessions.ts");
}

const ENV_KEYS = [
  "OMP_WEB_PASSWORD",
  "OMP_WEB_HOSTNAME",
  "OMP_WEB_ALLOWED_HOSTS",
  "OMP_WEB_USERS_FILE",
  "OMP_WEB_SESSIONS_FILE",
];

/**
 * Run `fn` with the full OMP_WEB_* surface pinned (missing keys deleted), so
 * tests never inherit the host process's deployment env, restoring after.
 * User-store/session caches are cleared on both sides of the boundary.
 */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.__ompWebUsersCache = undefined;
    globalThis.__ompWebSessions = undefined;
  }
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "web-proxy-"));
  return {
    dir,
    usersFile: join(dir, "omp-web-users.yml"),
    sessionsFile: join(dir, "omp-web-sessions.json"),
  };
}

async function makeNextRequest() {
  const { NextRequest } = await import("next/server");
  return (path, { headers = {}, method = "GET" } = {}) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: { host: "localhost", ...headers },
    });
}

function isNextResponse(response) {
  return response.headers.get("x-middleware-next") === "1";
}

async function writeUsers(store, users) {
  const { writeWebUsersConfig, hashWebPassword } = await loadUsers();
  writeWebUsersConfig({
    users: users.map((user) => ({
      projects: "*",
      tokens: [],
      ...user,
      passwordHash: hashWebPassword("pw"),
    })),
    sessions: { secret: "", ttlDays: 30 },
  });
}

const ADMIN = { username: "root", role: "admin" };
const USER = { username: "alice", role: "user", projects: ["/home/alice"] };

async function sessionCookie(store, username) {
  const { createWebSession, WEB_SESSION_COOKIE } = await loadSessions();
  const { raw } = createWebSession(username);
  return `${WEB_SESSION_COOKIE}=${raw}`;
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

const storeEnv = (store, extra = {}) => ({
  OMP_WEB_USERS_FILE: store.usersFile,
  OMP_WEB_SESSIONS_FILE: store.sessionsFile,
  ...extra,
});

// --- unauthenticated -----------------------------------------------------------

test("unauthenticated API request -> 401 JSON with no-store and no Basic challenge without the env bridge", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/api/sessions"));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("www-authenticate"), null);
  });
});

test("401 carries WWW-Authenticate Basic only while the env password bridge is set", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store, { OMP_WEB_PASSWORD: "a-long-random-password" }), async () => {
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/api/sessions"));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /^Basic realm="omp-web"/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("unauthenticated page request -> 302 /login with the original path in next", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/"));
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), "/");
  });
});

test("the login redirect preserves the search string in next", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/?tab=chat&x=1"));
    const location = new URL(response.headers.get("location"));
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), "/?tab=chat&x=1");
  });
});

// --- authenticated passthrough -------------------------------------------------

test("valid session cookie -> next()", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const cookie = await sessionCookie(store, "alice");
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/api/sessions", { headers: { cookie } }));
    assert.ok(isNextResponse(response));
  });
});

test("valid Bearer token -> next()", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const { createWebUserToken } = await loadUsers();
    const { raw } = createWebUserToken("alice", "cli");
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(
      request("/api/sessions", { headers: { authorization: `Bearer ${raw}` } }),
    );
    assert.ok(isNextResponse(response));
  });
});

test("valid legacy Basic credentials (env bridge) still pass", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store, { OMP_WEB_PASSWORD: "a-long-random-password" }), async () => {
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(
      request("/api/sessions", {
        headers: { authorization: basicAuthorization("omp", "a-long-random-password") },
      }),
    );
    assert.ok(isNextResponse(response));
  });
});

// --- admin-only prefixes ---------------------------------------------------------

test("user role on an admin-only prefix -> 403", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const cookie = await sessionCookie(store, "alice");
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/api/plugins", { headers: { cookie } }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Admin access required" });
  });
});

test("admin-only prefixes also cover their subpaths", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const cookie = await sessionCookie(store, "alice");
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/api/git/status", { headers: { cookie } }));
    assert.equal(response.status, 403);
  });
});

test("admin passes admin-only prefixes -> next()", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [ADMIN, USER]);
    const cookie = await sessionCookie(store, "root");
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const response = await proxy(request("/api/plugins", { headers: { cookie } }));
    assert.ok(isNextResponse(response));
  });
});

// --- auth disabled (backward compat) ---------------------------------------------

test("auth fully disabled -> next() without any credential", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    // No users file, no env password: previous no-auth installs keep working.
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    assert.ok(isNextResponse(await proxy(request("/"))));
    assert.ok(isNextResponse(await proxy(request("/api/sessions"))));
    // Admin-only prefixes must stay open too: a no-auth install has no roles.
    assert.ok(isNextResponse(await proxy(request("/api/models-config"))));
    assert.ok(isNextResponse(await proxy(request("/api/web-users"))));
  });
});

// --- trust gate ordering -----------------------------------------------------------

test("untrusted host is rejected before any authentication check", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    const api = await proxy(
      request("/api/sessions", { headers: { host: "evil.example" } }),
    );
    assert.equal(api.status, 403);
    assert.deepEqual(await api.json(), { error: "Untrusted API request" });

    const page = await proxy(request("/", { headers: { host: "evil.example" } }));
    assert.equal(page.status, 403);
    assert.equal(await page.text(), "Untrusted request");
  });
});

// --- auth endpoint exemptions --------------------------------------------------------

test("/api/auth/web-login and /api/auth/web-me skip authentication", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(storeEnv(store), async () => {
    await writeUsers(store, [USER]);
    const request = await makeNextRequest();
    const { proxy } = await loadProxy();

    assert.ok(isNextResponse(
      await proxy(request("/api/auth/web-login", { method: "POST" })),
    ));
    assert.ok(isNextResponse(await proxy(request("/api/auth/web-me"))));
  });
});
