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
  globalThis.__ompMachineHealthProbe = undefined;
}

function freshStores() {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-machines-health-api-"));
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  process.env.OMP_WEB_MACHINES_FILE = join(dir, "machines.json");
  delete process.env.OMP_WEB_PASSWORD;
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
  globalThis.__ompMachineHealthProbe = undefined;
  return dir;
}

async function loadLibs() {
  const users = await jiti.import("../../../../lib/web-users.ts");
  const sessions = await jiti.import("../../../../lib/web-sessions.ts");
  const machineStore = await jiti.import("../../../../lib/machines/machine-store.ts");
  const healthProbe = await jiti.import("../../../../lib/machines/health-probe.ts");
  return { users, sessions, machineStore, healthProbe };
}

function loadRoute() {
  return jiti.import("./route.ts");
}

const BASE = "http://localhost/api/machines/health";

function apiRequest({ method = "GET", cookie } = {}) {
  const headers = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(BASE, { method, headers });
}

async function seed(machineDefs) {
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
        machines: [machineDefs[0].id],
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  for (const def of machineDefs) {
    machineStore.createMachine(def);
  }
}

async function loginAs(username) {
  const { sessions } = await loadLibs();
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

/** A controllable remote /api/health upstream. */
function startStub() {
  const state = { status: 500, body: { ok: false, error: "boom" } };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(state.body, { status: state.status }),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    setState: (status, body) => {
      state.status = status;
      state.body = body;
    },
    stop: () => server.stop(true),
  };
}

/** Short-TTL shared probe so route-level TTL behaviour is testable in ms. */
async function installCountingProbe(ttlMs) {
  const { healthProbe } = await loadLibs();
  let upstreamCalls = 0;
  globalThis.__ompMachineHealthProbe = healthProbe.createMachineHealthProbe({
    ttlMs,
    probeRemote: (machine) => {
      upstreamCalls += 1;
      return healthProbe.probeRemoteViaProxy(machine);
    },
  });
  return { count: () => upstreamCalls };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("unauthenticated GET with auth enabled -> 401", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed([{ id: "gpu-1", name: "GPU 1", baseUrl: "http://127.0.0.1:9", authMode: "none" }]);
  const { GET } = await loadRoute();

  const response = await GET(apiRequest());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});

test("user role sees granted machines only, local always online without a probe", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = startStub();
  t.after(() => stub.stop());
  stub.setState(200, { ok: true });
  await seed([
    { id: "gpu-1", name: "GPU 1", baseUrl: stub.url, authMode: "none" },
    { id: "gpu-2", name: "GPU 2", baseUrl: stub.url, authMode: "none" },
  ]);
  await installCountingProbe(60);
  const viewer = await loginAs("viewer");
  const { GET } = await loadRoute();

  const response = await GET(apiRequest({ cookie: viewer }));
  assert.equal(response.status, 200);
  const { machines } = await response.json();
  assert.deepEqual(machines, [{ id: "local", state: "online" }, { id: "gpu-1", state: "online" }]);
});

test("a remote flipping from 500 to 200 flips the verdict after the TTL", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = startStub();
  t.after(() => stub.stop());
  stub.setState(500, { ok: false, error: "boom" });
  await seed([{ id: "gpu-1", name: "GPU 1", baseUrl: stub.url, authMode: "none" }]);
  const { count } = await installCountingProbe(80);
  const admin = await loginAs("root");
  const { GET } = await loadRoute();

  const first = await GET(apiRequest({ cookie: admin }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    machines: [{ id: "local", state: "online" }, { id: "gpu-1", state: "offline", reason: "boom" }],
  });
  assert.equal(count(), 1);

  // Inside the TTL the settled verdict is served without a new upstream probe.
  const cached = await GET(apiRequest({ cookie: admin }));
  const cachedBody = await cached.json();
  assert.equal(cachedBody.machines[1].state, "offline");
  assert.equal(count(), 1);

  stub.setState(200, { ok: true });
  await sleep(120);
  const recovered = await GET(apiRequest({ cookie: admin }));
  assert.deepEqual(await recovered.json(), {
    machines: [{ id: "local", state: "online" }, { id: "gpu-1", state: "online" }],
  });
  assert.equal(count(), 2);
});

test("a 401 from the remote maps to unauthorized", async (t) => {
  t.after(restoreEnv);
  const dir = freshStores();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = startStub();
  t.after(() => stub.stop());
  stub.setState(401, { error: "Authentication required" });
  await seed([{ id: "gpu-1", name: "GPU 1", baseUrl: stub.url, authMode: "none" }]);
  await installCountingProbe(60);
  const admin = await loginAs("root");
  const { GET } = await loadRoute();

  const response = await GET(apiRequest({ cookie: admin }));
  const { machines } = await response.json();
  assert.deepEqual(machines[1], { id: "gpu-1", state: "unauthorized", reason: "Authentication required" });
});
