import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const ENV_KEYS = [
  "OMP_WEB_PASSWORD",
  "OMP_WEB_USERS_FILE",
  "OMP_WEB_SESSIONS_FILE",
  "OMP_WEB_MACHINES_FILE",
  "OMP_WEB_STATIC_MAPPINGS_FILE",
  "OMP_WEB_STATIC_ROOT",
  "OMP_WEB_MACHINE_ID",
];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
  globalThis.__ompStaticMappingsCache = undefined;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omp-static-mgmt-"));
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  process.env.OMP_WEB_MACHINES_FILE = join(dir, "machines.json");
  process.env.OMP_WEB_STATIC_MAPPINGS_FILE = join(dir, "mappings.json");
  process.env.OMP_WEB_STATIC_ROOT = join(dir, "static");
  process.env.OMP_WEB_MACHINE_ID = "joysort187";
  delete process.env.OMP_WEB_PASSWORD;
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
  globalThis.__ompStaticMappingsCache = undefined;
  return dir;
}

async function loadLibs() {
  const users = await jiti.import("../../../lib/web-users.ts");
  const sessions = await jiti.import("../../../lib/web-sessions.ts");
  const mappings = await jiti.import("../../../lib/static-mapping-store.ts");
  return { users, sessions, mappings };
}

async function seed() {
  const { users } = await loadLibs();
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
        username: "alice",
        role: "user",
        passwordHash: users.hashWebPassword("alice-pass-1"),
        projects: ["/opt/granted/a"],
        machines: [],
        tokens: [],
      },
      {
        username: "star",
        role: "user",
        passwordHash: users.hashWebPassword("star-pass-1"),
        projects: "*",
        machines: [],
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
}

async function loginAs(username) {
  const { sessions } = await loadLibs();
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

function request(path, { method = "GET", cookie, body } = {}) {
  const headers = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params(value) {
  return { params: Promise.resolve(value) };
}

/** Seed one visible row, one hidden row, and one legacy row (no projectRoot). */
async function seedRows(mappings) {
  const visible = mappings.createStaticMapping({ id: "visible-row", persistent: true, projectRoot: "/opt/granted/a" });
  const hidden = mappings.createStaticMapping({ id: "hidden-row", persistent: true, projectRoot: "/opt/elsewhere" });
  const now = new Date().toISOString();
  const file = process.env.OMP_WEB_STATIC_MAPPINGS_FILE;
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.mappings.push({
    id: "legacy-row",
    label: "legacy-row",
    lifecycle: "persistent",
    state: "active",
    entryFile: "index.html",
    createdAt: now,
    updatedAt: now,
    contentRetained: true,
  });
  mkdirSync(join(process.env.OMP_WEB_STATIC_ROOT, "legacy-row"), { recursive: true });
  writeFileSync(file, JSON.stringify(stored));
  globalThis.__ompStaticMappingsCache = undefined;
  return { visible, hidden };
}

test("GET list filters non-admins by project; admins keep legacy rows", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  await seedRows(mappings);
  const route = await jiti.import("./route.ts");

  const alice = await route.GET(request("/api/static-mappings", { cookie: await loginAs("alice") }));
  assert.equal(alice.status, 200);
  const aliceBody = await alice.json();
  assert.deepEqual(aliceBody.mappings.map((mapping) => mapping.id), ["visible-row"]);
  assert.equal(aliceBody.machineId, "joysort187");

  // '*' visibility still excludes legacy rows — those are admin-only.
  const star = await route.GET(request("/api/static-mappings", { cookie: await loginAs("star") }));
  assert.deepEqual((await star.json()).mappings.map((mapping) => mapping.id), ["hidden-row", "visible-row"]);

  const root = await route.GET(request("/api/static-mappings", { cookie: await loginAs("root") }));
  assert.deepEqual((await root.json()).mappings.map((mapping) => mapping.id), ["legacy-row", "hidden-row", "visible-row"]);
});

test("POST create requires projectRoot and rejects non-admins outside their grants", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const route = await jiti.import("./route.ts");
  const alice = await loginAs("alice");
  const root = await loginAs("root");

  const missing = await route.POST(request("/api/static-mappings", { method: "POST", cookie: root, body: { id: "no-root", persistent: true } }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).field, "projectRoot");

  const malformed = await route.POST(request("/api/static-mappings", { method: "POST", cookie: root, body: { id: "bad-root", persistent: true, projectRoot: "relative/path" } }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).field, "projectRoot");

  const denied = await route.POST(request("/api/static-mappings", { method: "POST", cookie: alice, body: { id: "hidden-new", persistent: true, projectRoot: "/opt/elsewhere" } }));
  assert.equal(denied.status, 403);

  const created = await route.POST(request("/api/static-mappings", { method: "POST", cookie: alice, body: { id: "alice-new", persistent: true, projectRoot: "/opt/granted/a" } }));
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.mapping.projectRoot, "/opt/granted/a");
  assert.equal(createdBody.publicPath, "/static/joysort187/alice-new/index.html");

  const { mappings } = await loadLibs();
  assert.equal(mappings.getStaticMapping("hidden-new"), null);
  assert.equal(mappings.getStaticMapping("no-root"), null);
});

test("item GET/PATCH/DELETE require project visibility for non-admins; admins retain full access", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  await seedRows(mappings);
  const item = await jiti.import("./[id]/route.ts");
  const alice = await loginAs("alice");
  const star = await loginAs("star");
  const root = await loginAs("root");

  // Hidden and legacy rows read as 404 for non-admins — existence is not confirmed.
  for (const id of ["hidden-row", "legacy-row"]) {
    const denied = await item.GET(request(`/api/static-mappings/${id}`, { cookie: alice }), params({ id }));
    assert.equal(denied.status, 404, id);
  }
  // '*' visibility does not unlock legacy management either.
  const starLegacy = await item.GET(request("/api/static-mappings/legacy-row", { cookie: star }), params({ id: "legacy-row" }));
  assert.equal(starLegacy.status, 404);

  const visible = await item.GET(request("/api/static-mappings/visible-row", { cookie: alice }), params({ id: "visible-row" }));
  assert.equal(visible.status, 200);
  assert.equal((await visible.json()).mapping.projectRoot, "/opt/granted/a");

  const patchDenied = await item.PATCH(
    request("/api/static-mappings/hidden-row", { method: "PATCH", cookie: alice, body: { label: "nope" } }),
    params({ id: "hidden-row" }),
  );
  assert.equal(patchDenied.status, 404);
  assert.equal(mappings.getStaticMapping("hidden-row").label, "hidden-row");

  const deleteDenied = await item.DELETE(
    request("/api/static-mappings/hidden-row?content=delete", { method: "DELETE", cookie: alice }),
    params({ id: "hidden-row" }),
  );
  assert.equal(deleteDenied.status, 404);
  assert.ok(mappings.getStaticMapping("hidden-row"));

  const patchOk = await item.PATCH(
    request("/api/static-mappings/visible-row", { method: "PATCH", cookie: alice, body: { label: "renamed" } }),
    params({ id: "visible-row" }),
  );
  assert.equal(patchOk.status, 200);
  assert.equal((await patchOk.json()).mapping.label, "renamed");

  // Admins manage hidden and legacy rows as before.
  const adminPatch = await item.PATCH(
    request("/api/static-mappings/hidden-row", { method: "PATCH", cookie: root, body: { label: "admin-renamed" } }),
    params({ id: "hidden-row" }),
  );
  assert.equal(adminPatch.status, 200);
  const adminDelete = await item.DELETE(
    request("/api/static-mappings/legacy-row?content=delete", { method: "DELETE", cookie: root }),
    params({ id: "legacy-row" }),
  );
  assert.equal(adminDelete.status, 200);
  assert.equal((await adminDelete.json()).contentDeleted, true);
  assert.equal(mappings.getStaticMapping("legacy-row"), null);
});

test("POST normalizes the project root and collapses worktrees to the main checkout before the grant gate", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const route = await jiti.import("./route.ts");
  const { mappings } = await loadLibs();
  const alice = await loginAs("alice");

  // Duplicate separators / dot segments / trailing slash normalize to the granted root.
  const normalized = await route.POST(request("/api/static-mappings", {
    method: "POST", cookie: alice,
    body: { id: "normalized-root", persistent: true, projectRoot: "/opt//granted/./a/" },
  }));
  assert.equal(normalized.status, 201);
  assert.equal((await normalized.json()).mapping.projectRoot, "/opt/granted/a");

  // A real linked worktree of a granted main repo must pass the gate via its main root.
  const repo = mkdtempSync(join(tmpdir(), "omp-static-http-repo-"));
  const worktree = join(`${repo}-worktrees`, "feature-x");
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(repo, "README.md"), "main");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    mkdirSync(`${repo}-worktrees`, { recursive: true });
    git("worktree", "add", "-q", worktree, "-b", "feature-x");

    const { users } = await loadLibs();
    users.writeWebUsersConfig({
      users: [
        { username: "alice", role: "user", passwordHash: users.hashWebPassword("alice-pass-1"), projects: [repo], machines: [], tokens: [] },
      ],
      sessions: { secret: "", ttlDays: 30 },
    });
    globalThis.__ompWebUsersCache = undefined;
    globalThis.__ompWebSessions = undefined;
    const repoCookie = await loginAs("alice");

    const created = await route.POST(request("/api/static-mappings", {
      method: "POST", cookie: repoCookie,
      body: { id: "wt-http", persistent: true, projectRoot: worktree },
    }));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).mapping.projectRoot, repo);
    assert.equal(mappings.getStaticMapping("wt-http").projectRoot, repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}-worktrees`, { recursive: true, force: true });
  }
});

test("GET list orders rows by createdAt descending with malformed dates last", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  mappings.createStaticMapping({ id: "row-old", persistent: true, projectRoot: "/opt/granted/a" });
  mappings.createStaticMapping({ id: "row-new", persistent: true, projectRoot: "/opt/granted/a" });
  mappings.createStaticMapping({ id: "row-bad-date", persistent: true, projectRoot: "/opt/granted/a" });
  const file = process.env.OMP_WEB_STATIC_MAPPINGS_FILE;
  const stored = JSON.parse(readFileSync(file, "utf8"));
  const stamps = { "row-old": "2026-11-25T09:00:00.000Z", "row-new": "2026-11-25T13:00:00.000Z", "row-bad-date": "not-a-date" };
  stored.mappings = stored.mappings.map((row) => ({ ...row, createdAt: stamps[row.id] ?? row.createdAt }));
  writeFileSync(file, JSON.stringify(stored));
  globalThis.__ompStaticMappingsCache = undefined;

  const route = await jiti.import("./route.ts");
  const response = await route.GET(request("/api/static-mappings", { cookie: await loginAs("alice") }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).mappings.map((m) => m.id), ["row-new", "row-old", "row-bad-date"]);
});
