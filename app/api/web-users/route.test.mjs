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
};

function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
}

/** Point both stores at a fresh temp dir; auth derives from the file users. */
function freshStores() {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-users-api-"));
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  delete process.env.OMP_WEB_PASSWORD;
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  return dir;
}

async function loadLibs() {
  const users = await jiti.import("../../../lib/web-users.ts");
  const sessions = await jiti.import("../../../lib/web-sessions.ts");
  const authContext = await jiti.import("../../../lib/web-auth-context.ts");
  return { users, sessions, authContext };
}

async function seedUsers() {
  const { users } = await loadLibs();
  users.writeWebUsersConfig({
    users: [
      {
        username: "root",
        role: "admin",
        passwordHash: users.hashWebPassword("root-pass-1"),
        projects: "*",
        tokens: [],
      },
      {
        username: "viewer",
        role: "user",
        passwordHash: users.hashWebPassword("viewer-pass-1"),
        projects: ["/tmp"],
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  return users;
}

async function loadRoutes() {
  const list = await jiti.import("./route.ts");
  const detail = await jiti.import("./[username]/route.ts");
  const tokens = await jiti.import("./[username]/tokens/route.ts");
  const tokenDetail = await jiti.import("./[username]/tokens/[name]/route.ts");
  return { list, detail, tokens, tokenDetail };
}

const BASE = "http://localhost/api/web-users";

function apiRequest(path, { method = "GET", body, cookie, authorization } = {}) {
  const headers = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(value) {
  return { params: Promise.resolve(value) };
}

/** Log in like the login route would: real session cookie for a seeded user. */
async function loginAs(username) {
  const { sessions } = await loadLibs();
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

test("admin CRUD happy path drives the user store end to end", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedUsers();
  const { users } = await loadLibs();
  const { list, detail } = await loadRoutes();
  const admin = await loginAs("root");

  // Create.
  const created = await list.POST(
    apiRequest("", {
      method: "POST",
      cookie: admin,
      body: { username: "alice", password: "alice-pass-1", role: "user", projects: ["/home/alice"] },
    }),
  );
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    user: { username: "alice", role: "user", projects: ["/home/alice"], tokens: [] },
  });

  // List shows all three users.
  const listed = await list.GET(apiRequest("", { cookie: admin }));
  assert.equal(listed.status, 200);
  const { users: listedUsers } = await listed.json();
  assert.deepEqual(
    listedUsers.map((user) => user.username).sort(),
    ["alice", "root", "viewer"],
  );

  // Update role + projects.
  const patched = await detail.PATCH(
    apiRequest("/alice", {
      method: "PATCH",
      cookie: admin,
      body: { role: "admin", projects: ["/srv/data/"] },
    }),
    params({ username: "alice" }),
  );
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json();
  assert.equal(patchedBody.user.role, "admin");
  assert.deepEqual(patchedBody.user.projects, ["/srv/data"]); // trailing slash normalized

  // Update password — re-hashed with scrypt and verifiable.
  const rehashed = await detail.PATCH(
    apiRequest("/alice", {
      method: "PATCH",
      cookie: admin,
      body: { password: "new-pass-2" },
    }),
    params({ username: "alice" }),
  );
  assert.equal(rehashed.status, 200);
  const storedAlice = users.readWebUsersConfig().users.find((user) => user.username === "alice");
  assert.ok(storedAlice.passwordHash.startsWith("scrypt$"));
  assert.ok(users.verifyWebPassword("new-pass-2", storedAlice.passwordHash));
  assert.ok(!users.verifyWebPassword("alice-pass-1", storedAlice.passwordHash));

  // Delete.
  const removed = await detail.DELETE(
    apiRequest("/alice", { method: "DELETE", cookie: admin }),
    params({ username: "alice" }),
  );
  assert.equal(removed.status, 200);
  const afterDelete = await list.GET(apiRequest("", { cookie: admin }));
  const names = (await afterDelete.json()).users.map((user) => user.username);
  assert.deepEqual(names.sort(), ["root", "viewer"]);
});

test("listing and detail responses expose safe fields only — no hashes, no raw tokens", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedUsers();
  const { users } = await loadLibs();
  const { list, detail } = await loadRoutes();
  const admin = await loginAs("root");

  // A stored token whose raw value must never appear in any response.
  const { raw } = users.createWebUserToken("root", "seed-token");
  assert.ok(raw.startsWith("web_"));

  const listed = await list.GET(apiRequest("", { cookie: admin }));
  const listedText = JSON.stringify(await listed.json());
  assert.ok(!listedText.includes("passwordHash"));
  assert.ok(!listedText.includes("tokenHash"));
  assert.ok(!listedText.includes(raw));
  const rootEntry = (await JSON.parse(listedText)).users.find((user) => user.username === "root");
  assert.deepEqual(
    rootEntry.tokens.map((token) => token.name),
    ["seed-token"],
  );
  assert.match(rootEntry.tokens[0].created, /^\d{4}-\d{2}-\d{2}T/);

  const detailResponse = await detail.PATCH(
    apiRequest("/root", { method: "PATCH", cookie: admin, body: {} }),
    params({ username: "root" }),
  );
  const detailText = JSON.stringify(await detailResponse.json());
  assert.ok(!detailText.includes("passwordHash"));
  assert.ok(!detailText.includes("tokenHash"));
  assert.ok(!detailText.includes(raw));
});

test("non-admin and unauthenticated requests get 403 on every route", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedUsers();
  const { list, detail, tokens } = await loadRoutes();
  const viewer = await loginAs("viewer");

  const cases = [
    ["GET list", list.GET(apiRequest("", { cookie: viewer }))],
    ["POST create", list.POST(
      apiRequest("", {
        method: "POST",
        cookie: viewer,
        body: { username: "x", password: "x-pass-123", role: "user", projects: "*" },
      }),
    )],
    ["PATCH detail", detail.PATCH(
      apiRequest("/root", { method: "PATCH", cookie: viewer, body: { role: "user" } }),
      params({ username: "root" }),
    )],
    ["DELETE detail", detail.DELETE(
      apiRequest("/root", { method: "DELETE", cookie: viewer }),
      params({ username: "root" }),
    )],
    ["POST token", tokens.POST(
      apiRequest("/root/tokens", { method: "POST", cookie: viewer, body: { name: "cli" } }),
      params({ username: "root" }),
    )],
    ["no credential", list.GET(apiRequest(""))],
  ];
  for (const [label, response] of cases) {
    const resolved = await response;
    assert.equal(resolved.status, 403, `${label} must be 403`);
    assert.equal((await resolved.json()).error, "Admin access required");
  }
});

test("last admin cannot be demoted or deleted (409)", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { users } = await loadLibs();
  const { list, detail } = await loadRoutes();

  // Single file admin, no env password.
  users.writeWebUsersConfig({
    users: [
      {
        username: "solo",
        role: "admin",
        passwordHash: users.hashWebPassword("solo-pass-1"),
        projects: "*",
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  const solo = await loginAs("solo");

  const demoted = await detail.PATCH(
    apiRequest("/solo", { method: "PATCH", cookie: solo, body: { role: "user" } }),
    params({ username: "solo" }),
  );
  assert.equal(demoted.status, 409);

  const deleted = await detail.DELETE(
    apiRequest("/solo", { method: "DELETE", cookie: solo }),
    params({ username: "solo" }),
  );
  assert.equal(deleted.status, 409);
  assert.equal(users.readWebUsersConfig().users.length, 1, "solo survives");

  // The env-backed migration admin does NOT rescue a non-empty users file.
  process.env.OMP_WEB_PASSWORD = "env-migration-pass";
  globalThis.__ompWebUsersCache = undefined;
  const demotedWithEnv = await detail.PATCH(
    apiRequest("/solo", { method: "PATCH", cookie: solo, body: { role: "user" } }),
    params({ username: "solo" }),
  );
  assert.equal(demotedWithEnv.status, 409, "env admin only counts while the file is empty");
  delete process.env.OMP_WEB_PASSWORD;
  globalThis.__ompWebUsersCache = undefined;

  // With a second admin, demote and delete both succeed.
  const created = await list.POST(
    apiRequest("", {
      method: "POST",
      cookie: solo,
      body: { username: "backup", password: "backup-pass-1", role: "admin", projects: "*" },
    }),
  );
  assert.equal(created.status, 201);
  const demoteOk = await detail.PATCH(
    apiRequest("/solo", { method: "PATCH", cookie: solo, body: { role: "user" } }),
    params({ username: "solo" }),
  );
  assert.equal(demoteOk.status, 200);
  // solo was demoted — their session no longer resolves as admin (role is
  // read live), so the delete must come from the other admin.
  const backup = await loginAs("backup");
  const deleteOk = await detail.DELETE(
    apiRequest("/solo", { method: "DELETE", cookie: backup }),
    params({ username: "solo" }),
  );
  assert.equal(deleteOk.status, 200);
});

test("deleting a user revokes all of their sessions", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { users, sessions } = await loadLibs();
  const { list, detail } = await loadRoutes();

  users.writeWebUsersConfig({
    users: [
      {
        username: "boss",
        role: "admin",
        passwordHash: users.hashWebPassword("boss-pass-1"),
        projects: "*",
        tokens: [],
      },
      {
        username: "temp",
        role: "user",
        passwordHash: users.hashWebPassword("temp-pass-1"),
        projects: "*",
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  const boss = await loginAs("boss");
  const tempCookie = await loginAs("temp");

  // temp's session works before deletion (on a non-admin route it would be
  // 403-for-role, so prove it resolves via the auth context instead).
  const { authContext } = await loadLibs();
  const before = await authContext.getWebUserFromRequest(
    apiRequest("", { cookie: tempCookie }),
  );
  assert.equal(before?.username, "temp");

  const removed = await detail.DELETE(
    apiRequest("/temp", { method: "DELETE", cookie: boss }),
    params({ username: "temp" }),
  );
  assert.equal(removed.status, 200);

  const after = await authContext.getWebUserFromRequest(
    apiRequest("", { cookie: tempCookie }),
  );
  assert.equal(after, null, "temp's session is revoked with the account");
});

test("token lifecycle: raw shown exactly once, usable as bearer, deletable", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedUsers();
  const { list, tokens, tokenDetail } = await loadRoutes();
  const { authContext } = await loadLibs();
  const admin = await loginAs("root");

  const created = await tokens.POST(
    apiRequest("/root/tokens", { method: "POST", cookie: admin, body: { name: "ci" } }),
    params({ username: "root" }),
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.name, "ci");
  assert.match(createdBody.created, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(createdBody.raw.startsWith("web_"), "raw token returned once");

  // Raw token authenticates as its user.
  const bearerUser = await authContext.getWebUserFromRequest(
    apiRequest("", { authorization: `Bearer ${createdBody.raw}` }),
  );
  assert.deepEqual(bearerUser, { username: "root", role: "admin", visibleProjects: "*" });

  // Listing shows the token metadata but never the raw value.
  const listed = await list.GET(apiRequest("", { cookie: admin }));
  const listedText = JSON.stringify(await listed.json());
  assert.ok(listedText.includes("ci"));
  assert.ok(!listedText.includes(createdBody.raw));

  // Duplicate name is rejected.
  const dupe = await tokens.POST(
    apiRequest("/root/tokens", { method: "POST", cookie: admin, body: { name: "ci" } }),
    params({ username: "root" }),
  );
  assert.equal(dupe.status, 409);

  // Delete revokes the bearer token.
  const removed = await tokenDetail.DELETE(
    apiRequest("/root/tokens/ci", { method: "DELETE", cookie: admin }),
    params({ username: "root", name: "ci" }),
  );
  assert.equal(removed.status, 200);
  const afterDelete = await authContext.getWebUserFromRequest(
    apiRequest("", { authorization: `Bearer ${createdBody.raw}` }),
  );
  assert.equal(afterDelete, null);

  // Deleting again → 404.
  const removedAgain = await tokenDetail.DELETE(
    apiRequest("/root/tokens/ci", { method: "DELETE", cookie: admin }),
    params({ username: "root", name: "ci" }),
  );
  assert.equal(removedAgain.status, 404);
});

test("validation rejects bad username, role, projects, dupes, and missing content-type", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedUsers();
  const { list } = await loadRoutes();
  const admin = await loginAs("root");

  const post = (body) =>
    list.POST(apiRequest("", { method: "POST", cookie: admin, body })).then((r) => r.status);

  assert.equal(await post({ username: "Bad Name", password: "x-pass-123", role: "user", projects: "*" }), 400);
  assert.equal(await post({ username: "UPPER", password: "x-pass-123", role: "user", projects: "*" }), 400);
  assert.equal(await post({ username: "ok-user", password: "x-pass-123", role: "superuser", projects: "*" }), 400);
  assert.equal(
    await post({ username: "ok-user", password: "x-pass-123", role: "user", projects: "relative/path" }),
    400,
  );
  assert.equal(await post({ username: "ok-user", password: "x-pass-123", role: "user", projects: 42 }), 400);
  assert.equal(await post({ username: "ok-user", role: "user", projects: "*" }), 400, "missing password");
  assert.equal(await post({ username: "root", password: "x-pass-123", role: "user", projects: "*" }), 400, "dupe username");

  // PATCH with garbage role.
  const { detail } = await loadRoutes();
  const patched = await detail.PATCH(
    apiRequest("/viewer", { method: "PATCH", cookie: admin, body: { role: "root" } }),
    params({ username: "viewer" }),
  );
  assert.equal(patched.status, 400);

  // POST without a JSON content-type → 415 (repo idiom).
  const noContentType = list.POST(
    new Request(BASE, {
      method: "POST",
      headers: { host: "localhost", cookie: admin },
      body: JSON.stringify({ username: "ok-user", password: "x-pass-123", role: "user", projects: "*" }),
    }),
  );
  assert.equal((await noContentType).status, 415);
});

test("unknown users and unknown tokens return 404", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seedUsers();
  const { detail, tokens, tokenDetail } = await loadRoutes();
  const admin = await loginAs("root");

  const cases = [
    ["PATCH ghost", detail.PATCH(
      apiRequest("/ghost", { method: "PATCH", cookie: admin, body: { role: "user" } }),
      params({ username: "ghost" }),
    )],
    ["DELETE ghost", detail.DELETE(
      apiRequest("/ghost", { method: "DELETE", cookie: admin }),
      params({ username: "ghost" }),
    )],
    ["POST ghost token", tokens.POST(
      apiRequest("/ghost/tokens", { method: "POST", cookie: admin, body: { name: "x" } }),
      params({ username: "ghost" }),
    )],
    ["DELETE unknown token", tokenDetail.DELETE(
      apiRequest("/root/tokens/nope", { method: "DELETE", cookie: admin }),
      params({ username: "root", name: "nope" }),
    )],
  ];
  for (const [label, response] of cases) {
    const resolved = await response;
    assert.equal(resolved.status, 404, `${label} must be 404`);
  }
});
