import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  OMP_WEB_MACHINE_NAME: process.env.OMP_WEB_MACHINE_NAME,
};

// `getAgentDir()` is resolved once at module load, so env vars alone cannot
// redirect it: the resolver must be rebuilt through `setAgentDir`. Without this
// the apply tests would rewrite the live ~/.omp/agent declaration layer.
const { getAgentDir, setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const savedAgentDir = getAgentDir();

function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setAgentDir(savedAgentDir);
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompRuntimePromise = undefined;
  globalThis.__ompModelsCacheState = undefined;
}

function freshStores(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp141-sync-route-"));
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  delete process.env.OMP_WEB_PASSWORD;
  process.env.OMP_WEB_MACHINE_NAME = "gateway";
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  setAgentDir(agentDir);
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompRuntimePromise = undefined;
  globalThis.__ompModelsCacheState = undefined;
  t.after(() => {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function loadLibs() {
  const users = await jiti.import("@/lib/web-users.ts");
  const sessions = await jiti.import("@/lib/web-sessions.ts");
  return { users, sessions };
}

async function loginAs(username) {
  const { sessions } = await loadLibs();
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

async function seedUsers() {
  const { users } = await loadLibs();
  users.writeWebUsersConfig({
    users: [
      { username: "root", role: "admin", passwordHash: users.hashWebPassword("root-pass-1"), projects: "*", machines: "*", tokens: [] },
      { username: "viewer", role: "user", passwordHash: users.hashWebPassword("viewer-pass-1"), projects: "*", machines: "*", tokens: [] },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
}

function request(path, { method = "GET", body, cookie, contentType = "application/json" } = {}) {
  const headers = new Headers({ host: "localhost" });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined && contentType !== null) headers.set("content-type", contentType);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const EXPORT_PATH = "/api/models-config/sync/export";
const APPLY_PATH = "/api/models-config/sync/apply";

function exportPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    exportedAt: "2026-11-25T11:00:00.000Z",
    sourceMachine: "gateway",
    providers: { "zhipu-coding-plan": { apiKey: "ZHIPU_API_KEY" } },
    roles: { default: "zhipu-coding-plan/glm-5.3" },
    enabledModels: ["zhipu-coding-plan/*"],
    fallbackChains: {},
    excludedOAuthProviders: [],
    ...overrides,
  };
}

test("sync export and apply both require an administrator", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const { GET } = await jiti.import("./export/route.ts");
  const { POST } = await jiti.import("./apply/route.ts");

  const anonymousExport = await GET(request(EXPORT_PATH));
  const viewerExport = await GET(request(EXPORT_PATH, { cookie: await loginAs("viewer") }));
  assert.equal(anonymousExport.status, 403);
  assert.equal(viewerExport.status, 403);
  assert.deepEqual(await viewerExport.json(), { error: "Admin access required" });

  const viewerApply = await POST(request(APPLY_PATH, {
    method: "POST",
    cookie: await loginAs("viewer"),
    body: { payload: exportPayload(), sections: ["providers"] },
  }));
  assert.equal(viewerApply.status, 403);
  assert.deepEqual(await viewerApply.json(), { error: "Admin access required" });

  const adminExport = await GET(request(EXPORT_PATH, { cookie: await loginAs("root") }));
  assert.equal(adminExport.status, 200);
  const exported = await adminExport.json();
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.sourceMachine, "gateway");
  assert.deepEqual(exported.excludedOAuthProviders, []);
  assert.ok(!JSON.stringify(exported).includes("root-pass-1"), "no credential material in the export");
  assert.ok(dir.length > 0);
});

test("sync apply validates the body, writes atomically with a backup, and is idempotent", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const agentDir = join(dir, "agent");
  writeFileSync(join(agentDir, "models.yml"), "providers: {}\n");
  writeFileSync(join(agentDir, "config.yml"), "modelRoles: {}\n");
  const { POST } = await jiti.import("./apply/route.ts");
  const cookie = await loginAs("root");

  const badType = await POST(request(APPLY_PATH, { method: "POST", cookie, body: { payload: exportPayload(), sections: ["providers"] }, contentType: null }));
  assert.equal(badType.status, 415);

  const badSchema = await POST(request(APPLY_PATH, {
    method: "POST",
    cookie,
    body: { payload: exportPayload({ schemaVersion: 42 }), sections: ["providers"] },
  }));
  assert.equal(badSchema.status, 400);
  assert.match((await badSchema.json()).error, /schemaVersion/);

  const badSections = await POST(request(APPLY_PATH, {
    method: "POST",
    cookie,
    body: { payload: exportPayload(), sections: [] },
  }));
  assert.equal(badSections.status, 400);

  const first = await POST(request(APPLY_PATH, {
    method: "POST",
    cookie,
    body: { payload: exportPayload(), sections: ["providers", "roles", "enabledModels"] },
  }));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.changed, true);
  assert.deepEqual(firstBody.applied.providers.added, ["zhipu-coding-plan"]);
  assert.equal(firstBody.backupPaths.length, 2);

  const second = await POST(request(APPLY_PATH, {
    method: "POST",
    cookie,
    body: { payload: exportPayload(), sections: ["providers", "roles", "enabledModels"] },
  }));
  const secondBody = await second.json();
  assert.equal(secondBody.changed, false, "the same payload twice is a no-op");
  assert.deepEqual(secondBody.backupPaths, []);

  const models = readFileSync(join(agentDir, "models.yml"), "utf8");
  assert.ok(models.includes("zhipu-coding-plan"));
  assert.ok(models.includes("ZHIPU_API_KEY"), "the env-var name is synced, never a value");
});

test("sync apply dryRun reports the diff and warnings without writing", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const agentDir = join(dir, "agent");
  writeFileSync(join(agentDir, "models.yml"), "providers: {}\n");
  writeFileSync(join(agentDir, "config.yml"), "modelRoles: {}\n");
  const before = readFileSync(join(agentDir, "models.yml"), "utf8");
  const { POST } = await jiti.import("./apply/route.ts");

  const response = await POST(request(APPLY_PATH, {
    method: "POST",
    cookie: await loginAs("root"),
    body: {
      payload: exportPayload({
        providers: { "omp141-missing": { apiKey: "OMP141_TEST_MISSING_KEY" } },
        roles: { slow: "anthropic/claude-opus-5" },
        enabledModels: ["anthropic/claude-opus-5*"],
      }),
      sections: ["providers", "roles", "enabledModels"],
      dryRun: true,
    },
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.changed, true);
  assert.deepEqual(body.backupPaths, []);
  assert.ok(body.warnings.some((warning) => warning.includes("OMP141_TEST_MISSING_KEY missing")));
  assert.ok(body.warnings.some((warning) => warning.startsWith("anthropic not logged in")));
  assert.equal(readFileSync(join(agentDir, "models.yml"), "utf8"), before);
  assert.ok(dir.length > 0);
});