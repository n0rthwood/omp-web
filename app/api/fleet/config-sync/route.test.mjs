import assert from "node:assert/strict";
import { createServer } from "node:http";
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
  OMP_WEB_MACHINES_FILE: process.env.OMP_WEB_MACHINES_FILE,
  OMP_WEB_MACHINE_NAME: process.env.OMP_WEB_MACHINE_NAME,
};

// `getAgentDir()` is cached at module load; env vars alone cannot redirect it.
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
  globalThis.__ompWebMachinesCache = undefined;
  globalThis.__ompRuntimePromise = undefined;
  globalThis.__ompModelsCacheState = undefined;
}

function freshStores(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp141-fleet-"));
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  process.env.OMP_WEB_MACHINES_FILE = join(dir, "machines.json");
  process.env.OMP_WEB_MACHINE_NAME = "gateway";
  delete process.env.OMP_WEB_PASSWORD;
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  setAgentDir(agentDir);
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
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

function request(body, { cookie, contentType = "application/json" } = {}) {
  const headers = new Headers({ host: "localhost" });
  if (cookie) headers.set("cookie", cookie);
  if (contentType !== null) headers.set("content-type", contentType);
  return new Request("http://localhost/api/fleet/config-sync", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** A stand-in target: a real second instance's apply route, backed by its own
 *  isolated agent dir, so the push exercises the genuine wire contract. */
async function startTarget(t, { failWith, replyWith } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omp141-target-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), "providers:\n  remote-only:\n    apiKey: REMOTE_KEY\n");
  writeFileSync(join(agentDir, "config.yml"), "modelRoles: {}\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const server = await startServer((req, res) => {
    if (failWith) {
      res.writeHead(failWith.status, { "content-type": "application/json" });
      res.end(JSON.stringify(failWith.body));
      return;
    }
    if (replyWith) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replyWith));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // The target applies through the real library against its own agent dir.
      const deps = {
        agentDir,
        envKeyNames: ["JOYAI_API_KEY"],
        oauthProviderIds: ["anthropic", "openai-codex", "xai-oauth"],
        hasOAuthCredential: () => false,
        now: () => new Date("2026-11-25T12:00:00.000Z"),
      };
      const { applyDeclarationLayer, parseSyncRequest } = targetSubject;
      let payload;
      try {
        payload = applyDeclarationLayer(
          parseSyncRequest({ payload: body.payload, sections: body.sections, dryRun: body.dryRun, prune: body.prune }),
          deps,
        );
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  t.after(() => stopServer(server));
  return { url: serverUrl(server), agentDir };
}

const targetSubject = await jiti.import("@/lib/models-config-sync.ts");

test("gateway config-sync requires an admin and validates the body", async (t) => {
  freshStores(t);
  await seedUsers();
  const { POST } = await jiti.import("./route.ts");

  const anonymous = await POST(request({ targets: [], sections: ["providers"] }));
  assert.equal(anonymous.status, 403);

  const viewer = await POST(request({ targets: [], sections: ["providers"] }, { cookie: await loginAs("viewer") }));
  assert.equal(viewer.status, 403);
  assert.deepEqual(await viewer.json(), { error: "Admin access required" });

  const badSections = await POST(request({ targets: [], sections: [] }, { cookie: await loginAs("root") }));
  assert.equal(badSections.status, 400);

  const badTargets = await POST(request({ targets: [7], sections: ["providers"] }, { cookie: await loginAs("root") }));
  assert.equal(badTargets.status, 400);

  const badType = await POST(request({ targets: [], sections: ["providers"] }, { cookie: await loginAs("root"), contentType: null }));
  assert.equal(badType.status, 415);
});

test("gateway pushes the declaration layer to each target serially and reports per-machine results", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const agentDir = join(dir, "agent");
  writeFileSync(join(agentDir, "models.yml"), [
    "providers:",
    "  zhipu-coding-plan:",
    "    apiKey: ZHIPU_API_KEY",
    "    models:",
    "      - id: glm-5.3",
    "",
  ].join("\n"));
  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: zhipu-coding-plan/glm-5.3\n");
  const target = await startTarget(t);
  const { createMachine } = await jiti.import("@/lib/machines/machine-store.ts");
  const machine = createMachine({ name: "Target Box", baseUrl: target.url, authMode: "none" });
  const { POST } = await jiti.import("./route.ts");
  const cookie = await loginAs("root");

  const dryRun = await POST(request({ targets: [machine.id], sections: ["providers", "roles"], dryRun: true }, { cookie }));
  assert.equal(dryRun.status, 200);
  const dryBody = await dryRun.json();
  assert.equal(dryBody.dryRun, true);
  assert.equal(dryBody.sourceMachine, "gateway");
  assert.equal(dryBody.results.length, 1);
  assert.equal(dryBody.results[0].status, "skipped");
  assert.equal(dryBody.results[0].changed, true);
  // #145: the content diff and the structured findings ride along for the wizard.
  assert.deepEqual(dryBody.results[0].applied.providers.added, ["zhipu-coding-plan"]);
  assert.deepEqual(dryBody.results[0].applied.roles.added, ["default"]);
  assert.deepEqual(dryBody.results[0].issues, [{ kind: "missing_key", provider: "zhipu-coding-plan", envVar: "ZHIPU_API_KEY" }]);
  assert.equal(readFileSync(join(target.agentDir, "models.yml"), "utf8"), "providers:\n  remote-only:\n    apiKey: REMOTE_KEY\n");

  const pushed = await POST(request({ targets: [machine.id], sections: ["providers", "roles"] }, { cookie }));
  const pushBody = await pushed.json();
  assert.equal(pushBody.results[0].status, "applied");
  assert.equal(pushBody.results[0].changed, true);
  assert.ok(pushBody.results[0].backupPaths.length > 0, "the target's backups are reported back");
  const models = readFileSync(join(target.agentDir, "models.yml"), "utf8");
  assert.ok(models.includes("zhipu-coding-plan"), "the payload reached the target's models.yml");
  assert.ok(models.includes("remote-only"), "the target's own provider survives the merge");

  const again = await POST(request({ targets: [machine.id], sections: ["providers", "roles"] }, { cookie }));
  const againBody = await again.json();
  assert.equal(againBody.results[0].status, "skipped", "a second push is a no-op");
  assert.equal(againBody.results[0].changed, false);
});

test("one failing target never blocks the others and local is never a target", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const agentDir = join(dir, "agent");
  writeFileSync(join(agentDir, "models.yml"), "providers:\n  zhipu-coding-plan:\n    apiKey: ZHIPU_API_KEY\n");
  writeFileSync(join(agentDir, "config.yml"), "modelRoles: {}\n");
  const healthy = await startTarget(t);
  const broken = await startTarget(t, { failWith: { status: 500, body: { error: "target exploded" } } });
  const { createMachine } = await jiti.import("@/lib/machines/machine-store.ts");
  const good = createMachine({ name: "Good Box", baseUrl: healthy.url, authMode: "none" });
  const bad = createMachine({ name: "Bad Box", baseUrl: broken.url, authMode: "none" });
  const { POST } = await jiti.import("./route.ts");

  const response = await POST(request({
    targets: ["local", bad.id, good.id],
    sections: ["providers"],
  }, { cookie: await loginAs("root") }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 3);

  const byId = new Map(body.results.map((result) => [result.machineId, result]));
  assert.equal(byId.get("local").status, "skipped");
  assert.equal(byId.get(bad.id).status, "failed");
  assert.equal(byId.get(bad.id).detail, "target exploded");
  assert.equal(byId.get(bad.id).applied, undefined, "a failed target brings no diff");
  assert.equal(byId.get(good.id).status, "applied", "the healthy target is still applied");
  assert.ok(readFileSync(join(healthy.agentDir, "models.yml"), "utf8").includes("zhipu-coding-plan"));
});

test("an unreachable target is reported as failed, not thrown", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const agentDir = join(dir, "agent");
  writeFileSync(join(agentDir, "models.yml"), "providers: {}\n");
  writeFileSync(join(agentDir, "config.yml"), "modelRoles: {}\n");
  const dead = await startServer(() => {});
  const deadUrl = serverUrl(dead);
  await stopServer(dead);
  const { createMachine } = await jiti.import("@/lib/machines/machine-store.ts");
  const machine = createMachine({ name: "Dead Box", baseUrl: deadUrl, authMode: "none" });
  const { POST } = await jiti.import("./route.ts");

  const response = await POST(request({ targets: [machine.id], sections: ["providers"] }, { cookie: await loginAs("root") }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].detail, "Machine unreachable");
});

test("an unknown machine id fails that row without breaking the run", async (t) => {
  freshStores(t);
  await seedUsers();
  const { POST } = await jiti.import("./route.ts");
  const response = await POST(request({ targets: ["no-such-machine"], sections: ["providers"] }, { cookie: await loginAs("root") }));
  const body = await response.json();
  assert.equal(body.results[0].status, "failed");
  assert.equal(body.results[0].detail, "Unknown machine");
});

test("the exported payload never carries a credential value", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const agentDir = join(dir, "agent");
  const secret = "sk-live-DO-NOT-LEAK-141";
  writeFileSync(join(agentDir, ".env"), `JOYAI_API_KEY=${secret}\n`);
  writeFileSync(join(agentDir, "models.yml"), [
    "providers:",
    "  anthropic:",
    "    baseUrl: https://oauth.example",
    "  joyai:",
    "    apiKey: JOYAI_API_KEY",
    "",
  ].join("\n"));
  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: joyai/glm-5.3\n");
  const target = await startTarget(t);
  const { createMachine } = await jiti.import("@/lib/machines/machine-store.ts");
  const machine = createMachine({ name: "Target Box", baseUrl: target.url, authMode: "none" });
  const { POST } = await jiti.import("./route.ts");

  const response = await POST(request({ targets: [machine.id], sections: ["providers", "roles"] }, { cookie: await loginAs("root") }));
  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes(secret), "the credential value must never cross the gateway");
  assert.deepEqual(body.excludedOAuthProviders, ["anthropic"], "the OAuth block is withheld");
});

test("a target answering a malformed diff or unknown findings yields none instead of garbage (issue #145)", async (t) => {
  const dir = freshStores(t);
  await seedUsers();
  const agentDir = join(dir, "agent");
  writeFileSync(join(agentDir, "models.yml"), "providers: {}\n");
  writeFileSync(join(agentDir, "config.yml"), "modelRoles: {}\n");
  const odd = await startTarget(t, {
    replyWith: {
      changed: true,
      applied: { providers: "not-the-documented-shape" },
      issues: [
        { kind: "mystery", provider: "x" },
        { kind: "not_logged_in" },
        { kind: "missing_key", provider: "joyai", envVar: "JOYAI_API_KEY" },
      ],
      warnings: [],
    },
  });
  const { createMachine } = await jiti.import("@/lib/machines/machine-store.ts");
  const machine = createMachine({ name: "Odd Box", baseUrl: odd.url, authMode: "none" });
  const { POST } = await jiti.import("./route.ts");

  const response = await POST(request({ targets: [machine.id], sections: ["providers"] }, { cookie: await loginAs("root") }));
  const { results: [result] } = await response.json();
  assert.equal(result.status, "applied");
  assert.equal(result.applied, undefined, "an unusable diff is dropped, not forwarded");
  assert.deepEqual(result.issues, [{ kind: "missing_key", provider: "joyai", envVar: "JOYAI_API_KEY" }]);
});