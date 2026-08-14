import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];

const storeDir = mkdtempSync(join(tmpdir(), "omp-web-cwd-gate-"));
const usersFile = join(storeDir, "users.yml");
const sessionsFile = join(storeDir, "sessions.json");

// Real project directories on disk: proj-a is alice's only visible root.
const fsRoot = mkdtempSync(join(tmpdir(), "omp-web-cwd-fs-"));
const projA = join(fsRoot, "proj-a");
const projB = join(fsRoot, "proj-b");
mkdirSync(join(projA, "sub"), { recursive: true });
mkdirSync(projB, { recursive: true });

async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withStore(extraEnv, fn) {
  if (typeof fn !== "function") {
    fn = extraEnv;
    extraEnv = {};
  }
  await withEnv(
    { OMP_WEB_USERS_FILE: usersFile, OMP_WEB_SESSIONS_FILE: sessionsFile, ...extraEnv },
    async () => {
      globalThis.__ompAllowedRootsCache = undefined;
      globalThis.__ompAdditionalAllowedRoots = new Set();
      globalThis.__ompWebUsersCache = undefined;
      globalThis.__ompWebSessions = undefined;
      await fn();
    },
  );
}

async function seedUsers(users) {
  const { hashWebPassword, writeWebUsersConfig } = await import("./web-users.ts");
  writeWebUsersConfig({
    users: users.map(({ username, role, password, projects }) => ({
      username,
      role,
      passwordHash: hashWebPassword(password ?? "pw-123456"),
      projects: projects ?? "*",
      tokens: [],
    })),
    sessions: { secret: "", ttlDays: 30 },
  });
}

/** Live session cookie header for a seeded user. */
async function sessionCookie(username) {
  const { createWebSession, WEB_SESSION_COOKIE } = await import("./web-sessions.ts");
  const { raw } = createWebSession(username);
  return `${WEB_SESSION_COOKIE}=${raw}`;
}

async function makeRequest(pathname, init = {}, host = "localhost:3000") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://${host}${pathname}`, {
    ...init,
    headers: { host, ...(init.headers ?? {}) },
  });
}

const loadBrowse = () => import("../app/api/cwd/browse/route.ts");
const loadValidate = () => import("../app/api/cwd/validate/route.ts");
const loadDefaultCwd = () => import("../app/api/default-cwd/route.ts");
const loadAgentNew = () => import("../app/api/agent/new/route.ts");

test("browse: user role starts at the first visible root and lists only its children", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", password: "hunter2", projects: [projA] },
    ]);
    const cookie = await sessionCookie("alice");
    const { GET } = await loadBrowse();

    const res = await GET(await makeRequest("/api/cwd/browse", { headers: { cookie } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, projA);
    for (const dir of body.directories) {
      assert.ok(
        dir.path === projA || dir.path.startsWith(`${projA}/`),
        `listed directory outside visible root: ${dir.path}`,
      );
    }
    assert.ok(body.directories.some((d) => d.name === "sub"));

    // Browsing an explicit subdirectory of a visible root still works.
    const sub = await GET(await makeRequest(`/api/cwd/browse?path=${encodeURIComponent(join(projA, "sub"))}`, { headers: { cookie } }));
    assert.equal(sub.status, 200);
    assert.equal((await sub.json()).path, join(projA, "sub"));
  });
});

test("browse: user role explicit path outside visible roots is 403", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", password: "hunter2", projects: [projA] },
    ]);
    const cookie = await sessionCookie("alice");
    const { GET } = await loadBrowse();

    for (const outside of [projB, homedir()]) {
      const res = await GET(await makeRequest(`/api/cwd/browse?path=${encodeURIComponent(outside)}`, { headers: { cookie } }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: "Access denied" });
    }
  });
});

test("browse: admin and auth-disabled behavior unchanged", async () => {
  const { GET } = await loadBrowse();

  await withStore(async () => {
    await seedUsers([{ username: "bob", role: "admin", password: "hunter2" }]);
    const cookie = await sessionCookie("bob");

    // Default start remains the server home directory for admins.
    const home = await GET(await makeRequest("/api/cwd/browse", { headers: { cookie } }));
    assert.equal(home.status, 200);
    assert.equal((await home.json()).path, homedir());

    // Any directory is browsable for admins.
    const anywhere = await GET(await makeRequest(`/api/cwd/browse?path=${encodeURIComponent(projB)}`, { headers: { cookie } }));
    assert.equal(anywhere.status, 200);
    assert.equal((await anywhere.json()).path, projB);
  });

  // Auth disabled entirely (no users, no env password): anonymous admin,
  // previous behavior. Clear the shared store file first.
  await withStore({ OMP_WEB_PASSWORD: undefined }, async () => {
    rmSync(usersFile, { force: true });
    globalThis.__ompWebUsersCache = undefined;
    const home = await GET(await makeRequest("/api/cwd/browse"));
    assert.equal(home.status, 200);
    assert.equal((await home.json()).path, homedir());
  });
});

test("validate: user role outside visible roots is 403 and allowFileRoot is not called", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", password: "hunter2", projects: [projA] },
    ]);
    const cookie = await sessionCookie("alice");
    const { POST } = await loadValidate();
    const { getAdditionalAllowedRoots } = await import("./allowed-roots.ts");

    const before = new Set(getAdditionalAllowedRoots());
    const res = await POST(await makeRequest("/api/cwd/validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ cwd: projB }),
    }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Access denied" });

    const after = getAdditionalAllowedRoots();
    assert.equal(after.size, before.size, "hidden cwd must not be added to allowed roots");
    for (const root of after) {
      assert.ok(!root.includes("proj-b"), `unexpected allowed root: ${root}`);
    }

    // A visible root validates and becomes allowed as before.
    const ok = await POST(await makeRequest("/api/cwd/validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ cwd: projA }),
    }));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.success, true);
    assert.equal(body.cwd, projA);
    assert.ok(getAdditionalAllowedRoots().has(projA));
  });
});

test("validate: admin can validate any directory", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "bob", role: "admin", password: "hunter2" }]);
    const cookie = await sessionCookie("bob");
    const { POST } = await loadValidate();

    const res = await POST(await makeRequest("/api/cwd/validate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ cwd: projB }),
    }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).cwd, projB);
  });
});

test("default-cwd: user role gets 403 admin-only; admin still creates the scratch dir", async () => {
  const { POST } = await loadDefaultCwd();

  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", password: "hunter2", projects: [projA] },
    ]);
    const cookie = await sessionCookie("alice");
    const res = await POST(await makeRequest("/api/default-cwd", {
      method: "POST",
      headers: { cookie },
    }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Admin access required" });
  });

  await withStore(async () => {
    await seedUsers([{ username: "bob", role: "admin", password: "hunter2" }]);
    const cookie = await sessionCookie("bob");
    const res = await POST(await makeRequest("/api/default-cwd", {
      method: "POST",
      headers: { cookie },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    assert.equal(body.cwd, join(homedir(), `omp-cwd-${date}`));
    assert.ok(existsSync(body.cwd));
  });
});

test("agent/new: user role with hidden cwd is rejected 403 before session creation", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", password: "hunter2", projects: [projA] },
    ]);
    const cookie = await sessionCookie("alice");
    const { allowFileRoot } = await import("./allowed-roots.ts");
    const { POST } = await loadAgentNew();

    // Simulate projB being browsable server-side (e.g. another user's session
    // cwd) so the existing allowed-roots check passes; the visibility gate must
    // still reject it. The gate sits BEFORE startRpcSession in the route, so no
    // session layer is ever reached (nothing to stub for the 403 path).
    allowFileRoot(projB);
    globalThis.__ompAllowedRootsCache = undefined;

    const res = await POST(await makeRequest("/api/agent/new", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ cwd: projB, type: "prompt", message: "hello" }),
    }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Access denied" });
  });
});

test("agent/new: cwd outside allowed roots still 403 (existing check intact)", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", password: "hunter2", projects: [projA] },
    ]);
    const cookie = await sessionCookie("alice");
    const { POST } = await loadAgentNew();

    const res = await POST(await makeRequest("/api/agent/new", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ cwd: projB, type: "prompt", message: "hello" }),
    }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Access denied" });
  });
});

test("cleanup: remove temp store files", () => {
  rmSync(storeDir, { recursive: true, force: true });
  rmSync(fsRoot, { recursive: true, force: true });
});
