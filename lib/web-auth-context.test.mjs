import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadAuthContext() {
  return import("./web-auth-context.ts");
}

async function loadVisibility() {
  return import("./web-visibility.ts");
}

async function loadUsers() {
  return import("./web-users.ts");
}

async function loadSessions() {
  return import("./web-sessions.ts");
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.__ompWebUsersCache = undefined;
    globalThis.__ompWebSessions = undefined;
  }
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "web-auth-context-"));
  return {
    dir,
    usersFile: join(dir, "omp-web-users.yml"),
    sessionsFile: join(dir, "omp-web-sessions.json"),
  };
}

function requestWithHeaders(headers) {
  return new Request("http://localhost/api/auth/web-me", { headers });
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function writeUser(user) {
  const { writeWebUsersConfig, hashWebPassword } = await loadUsers();
  writeWebUsersConfig({
    users: [{ ...user, passwordHash: hashWebPassword("pw"), tokens: [] }],
    sessions: { secret: "", ttlDays: 30 },
  });
}

const ALICE = { username: "alice", role: "user", projects: ["/home/alice"] };

// --- identity resolution -------------------------------------------------------

test("resolves a user from a valid session cookie", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(
    { OMP_WEB_USERS_FILE: store.usersFile, OMP_WEB_SESSIONS_FILE: store.sessionsFile },
    async () => {
      await writeUser(ALICE);
      const { createWebSession, WEB_SESSION_COOKIE } = await loadSessions();
      const { raw } = createWebSession("alice");
      const { getWebUserFromRequest } = await loadAuthContext();

      const user = await getWebUserFromRequest(
        requestWithHeaders({
          cookie: `other=1; ${WEB_SESSION_COOKIE}=${raw}; trailing=2`,
        }),
      );
      assert.deepEqual(user, {
        username: "alice",
        role: "user",
        visibleProjects: ["/home/alice"],
      });
    },
  );
});

test("resolves a stored user (with visibleProjects) from a Bearer token", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(
    { OMP_WEB_USERS_FILE: store.usersFile, OMP_WEB_SESSIONS_FILE: store.sessionsFile },
    async () => {
      await writeUser(ALICE);
      const { createWebUserToken } = await loadUsers();
      const { raw } = createWebUserToken("alice", "cli");
      const { getWebUserFromRequest } = await loadAuthContext();

      const user = await getWebUserFromRequest(
        requestWithHeaders({ authorization: `Bearer ${raw}` }),
      );
      assert.deepEqual(user, {
        username: "alice",
        role: "user",
        visibleProjects: ["/home/alice"],
      });
    },
  );
});

test("resolves the env-backed admin via legacy Basic while the env password is set", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(
    {
      OMP_WEB_USERS_FILE: store.usersFile,
      OMP_WEB_SESSIONS_FILE: store.sessionsFile,
      OMP_WEB_PASSWORD: "envpw",
    },
    async () => {
      const { getWebUserFromRequest } = await loadAuthContext();
      const user = await getWebUserFromRequest(
        requestWithHeaders({ authorization: basicAuthorization("omp", "envpw") }),
      );
      assert.deepEqual(user, { username: "omp", role: "admin", visibleProjects: "*" });
    },
  );
});

test("returns null when auth is enabled and no valid credential is present", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(
    {
      OMP_WEB_USERS_FILE: store.usersFile,
      OMP_WEB_SESSIONS_FILE: store.sessionsFile,
      OMP_WEB_PASSWORD: "envpw",
    },
    async () => {
      const { getWebUserFromRequest } = await loadAuthContext();
      assert.equal(await getWebUserFromRequest(requestWithHeaders({})), null);
      assert.equal(
        await getWebUserFromRequest(
          requestWithHeaders({ cookie: "omp-web-session=not-a-session" }),
        ),
        null,
      );
      assert.equal(
        await getWebUserFromRequest(requestWithHeaders({ authorization: "Bearer web_invalid" })),
        null,
      );
      assert.equal(
        await getWebUserFromRequest(
          requestWithHeaders({ authorization: basicAuthorization("omp", "wrong") }),
        ),
        null,
      );
    },
  );
});

test("synthetic __anonymous admin when auth is disabled", async (t) => {
  const store = tempStore();
  t.after(() => rmSync(store.dir, { recursive: true, force: true }));
  await withEnv(
    {
      OMP_WEB_USERS_FILE: store.usersFile,
      OMP_WEB_SESSIONS_FILE: store.sessionsFile,
      OMP_WEB_PASSWORD: undefined,
    },
    async () => {
      const { getWebUserOrSynthetic, getWebUserFromRequest } = await loadAuthContext();
      assert.deepEqual(await getWebUserOrSynthetic(requestWithHeaders({})), {
        username: "__anonymous",
        role: "admin",
        visibleProjects: "*",
      });
      // Raw resolution still yields null — there is no credential.
      assert.equal(await getWebUserFromRequest(requestWithHeaders({})), null);
    },
  );
});

// --- visibility ----------------------------------------------------------------

test("isPathVisible: '*' sees everything; prefix match is slash-terminated", async () => {
  const { isPathVisible } = await loadVisibility();
  const star = { username: "admin", role: "admin", visibleProjects: "*" };
  assert.equal(isPathVisible(star, "/anything/at/all"), true);

  const user = { username: "alice", role: "user", visibleProjects: ["/home/a"] };
  assert.equal(isPathVisible(user, "/home/a"), true);
  assert.equal(isPathVisible(user, "/home/a/"), true);
  assert.equal(isPathVisible(user, "/home/a/b"), true);
  assert.equal(isPathVisible(user, "/home/a/b/deep/file.ts"), true);
  assert.equal(isPathVisible(user, "/home/abc"), false);
  assert.equal(isPathVisible(user, "/home"), false);
  assert.equal(isPathVisible(user, "/home/a/b/../c"), true); // pure string prefix: no realpath resolution
});

test("isPathVisible: root with trailing slash still matches nested paths", async () => {
  const { isPathVisible } = await loadVisibility();
  const user = { username: "alice", role: "user", visibleProjects: ["/home/a/"] };
  assert.equal(isPathVisible(user, "/home/a"), true);
  assert.equal(isPathVisible(user, "/home/a/b"), true);
  assert.equal(isPathVisible(user, "/home/ab"), false);
});

test("filterVisibleSessions keeps sessions whose projectRoot ?? cwd is visible", async () => {
  const { filterVisibleSessions } = await loadVisibility();
  const user = { username: "alice", role: "user", visibleProjects: ["/home/alice"] };
  const sessions = [
    { id: "1", cwd: "/home/alice/proj" },
    { id: "2", cwd: "/nowhere/relevant", projectRoot: "/home/alice/work" },
    { id: "3", cwd: "/home/alicia/trap" },
    { id: "4", cwd: "/hidden", projectRoot: "/home/bob" },
    { id: "5", cwd: "/home/alice", projectRoot: "/home/bob" }, // hidden: projectRoot wins over cwd
  ];
  assert.deepEqual(
    filterVisibleSessions(user, sessions).map((s) => s.id),
    ["1", "2"],
  );

  const admin = { username: "admin", role: "admin", visibleProjects: "*" };
  assert.deepEqual(
    filterVisibleSessions(admin, sessions).map((s) => s.id),
    ["1", "2", "3", "4", "5"],
  );
});

test("visibleRootsForUser: admin keeps all; user intersects", async () => {
  const { visibleRootsForUser } = await loadVisibility();
  const allRoots = new Set(["/home/alice", "/srv", "/tmp/x"]);

  const admin = { username: "admin", role: "admin", visibleProjects: "*" };
  assert.deepEqual(new Set(visibleRootsForUser(admin, allRoots)), allRoots);

  const user = { username: "alice", role: "user", visibleProjects: ["/home/alice", "/unused"] };
  assert.deepEqual(visibleRootsForUser(user, allRoots), ["/home/alice"]);

  // Admin with an explicit project list still keeps every root.
  const scopedAdmin = { username: "root", role: "admin", visibleProjects: ["/home/alice"] };
  assert.deepEqual(new Set(visibleRootsForUser(scopedAdmin, allRoots)), allRoots);
});

test("isAdmin reflects the role", async () => {
  const { isAdmin } = await loadVisibility();
  assert.equal(isAdmin({ username: "a", role: "admin", visibleProjects: "*" }), true);
  assert.equal(isAdmin({ username: "a", role: "user", visibleProjects: "*" }), false);
});
