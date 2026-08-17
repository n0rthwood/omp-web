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
  const dir = mkdtempSync(join(tmpdir(), "omp-web-machines-api-"));
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
  const users = await jiti.import("../../../lib/web-users.ts");
  const sessions = await jiti.import("../../../lib/web-sessions.ts");
  const machineStore = await jiti.import("../../../lib/machines/machine-store.ts");
  return { users, sessions, machineStore };
}

async function loadRoute() {
  return jiti.import("./route.ts");
}

const BASE = "http://localhost/api/machines";

function apiRequest(path, { method = "GET", body, cookie } = {}) {
  const headers = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function loginAs(username) {
  const { sessions } = await loadLibs();
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

async function seed(machineIds) {
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
        username: "viewer",
        role: "user",
        passwordHash: users.hashWebPassword("viewer-pass-1"),
        projects: ["/tmp"],
        machines: [machineIds[0]],
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  for (const id of machineIds) {
    machineStore.createMachine({ id, name: `Machine ${id}`, baseUrl: `http://${id}.local`, authMode: "none" });
  }
}

test("admin GET /api/machines sees the full registry with credentials-safe fields", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed(["gpu-1", "gpu-2"]);
  const admin = await loginAs("root");
  const { GET } = await loadRoute();

  const response = await GET(apiRequest("", { cookie: admin }));
  assert.equal(response.status, 200);
  const { machines } = await response.json();
  assert.deepEqual(machines.map((m) => m.id), ["local", "gpu-1", "gpu-2"]);
  assert.ok("baseUrl" in machines[1]);
  assert.ok("headerNames" in machines[1]);
});

test("user-role GET /api/machines is filtered to grants (+local) and slimmed of baseUrl/headerNames", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed(["gpu-1", "gpu-2"]);
  const viewer = await loginAs("viewer");
  const { GET } = await loadRoute();

  const response = await GET(apiRequest("", { cookie: viewer }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.machines.map((m) => m.id).sort(), ["gpu-1", "local"]);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("baseUrl"));
  assert.ok(!text.includes("headerNames"));
});

test("user-role POST /api/machines -> 403 (fleet mutation stays admin-only)", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed(["gpu-1"]);
  const viewer = await loginAs("viewer");
  const { POST } = await loadRoute();

  const response = await POST(
    apiRequest("", {
      method: "POST",
      cookie: viewer,
      body: { name: "x", baseUrl: "http://x", authMode: "none" },
    }),
  );
  assert.equal(response.status, 403);
});

test("unauthenticated GET /api/machines with auth enabled -> 401", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed(["gpu-1"]);
  const { GET } = await loadRoute();

  const response = await GET(apiRequest(""));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});
