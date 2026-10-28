import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const BASE = "http://localhost/api/service/restart";
const SAVED_ENV = process.env.OMP_RESTART_SERVICE_ENV;

const DAEMON_STATUS = {
  run_id: "run-existing",
  pid: 7123,
  running: true,
  exit_code: null,
  started_at: "2026-10-28T01:02:03Z",
  ended_at: null,
  log_path: "/tmp/restart.log",
  log_tail: ["running"],
  mode: "upgrade",
};


function apiRequest(method, body) {
  const headers = { host: "localhost" };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(BASE, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function startServer(handler) {
  const server = createServer(handler);
  const { promise, resolve } = Promise.withResolvers();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return { server, port: address.port };
}

async function stopServer(server) {
  const { promise, resolve } = Promise.withResolvers();
  server.close(resolve);
  await promise;
}

async function unusedLoopbackPort() {
  const { server, port } = await startServer(() => {});
  await stopServer(server);
  return port;
}

function configureDaemon(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-restart-route-"));
  const path = join(dir, "restart-service.env");
  writeFileSync(path, contents);
  process.env.OMP_RESTART_SERVICE_ENV = path;
  t.after(() => {
    if (SAVED_ENV === undefined) delete process.env.OMP_RESTART_SERVICE_ENV;
    else process.env.OMP_RESTART_SERVICE_ENV = SAVED_ENV;
    rmSync(dir, { recursive: true, force: true });
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("GET returns available false when no daemon listens on the configured loopback port", async (t) => {
  const port = await unusedLoopbackPort();
  configureDaemon(t, `RESTART_SERVICE_PORT=${port}\n`);
  const { GET } = await import("./route.ts");

  const response = await GET(apiRequest("GET"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.available, false);
  assert.equal(typeof body.reason, "string");
});

test("GET passes through daemon status after its health probe", async (t) => {
  const { server, port } = await startServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end();
      return;
    }
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(DAEMON_STATUS));
      return;
    }
    res.writeHead(404).end();
  });
  t.after(() => stopServer(server));
  configureDaemon(t, `RESTART_SERVICE_PORT=${port}\n`);
  const { GET } = await import("./route.ts");

  const response = await GET(apiRequest("GET"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: true, status: DAEMON_STATUS });
});

test("POST rejects a missing or invalid mode before contacting the daemon", async (t) => {
  let requests = 0;
  const { server, port } = await startServer((_req, res) => {
    requests += 1;
    res.writeHead(500).end();
  });
  t.after(() => stopServer(server));
  configureDaemon(t, `RESTART_SERVICE_TOKEN=token-for-test\nRESTART_SERVICE_PORT=${port}\n`);
  const { POST } = await import("./route.ts");

  const invalid = await POST(apiRequest("POST", { mode: "other" }));
  const missing = await POST(apiRequest("POST", {}));

  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid mode" });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "invalid mode" });
  assert.equal(requests, 0);
});

test("POST requires a JSON content type before reading the mode", async () => {
  const { POST } = await import("./route.ts");

  const response = await POST(apiRequest("POST"));

  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });
});

test("POST forwards the configured token and restart mode to a successful daemon run", async (t) => {
  let received;
  const { server, port } = await startServer(async (req, res) => {
    received = { token: req.headers["x-restart-token"], body: await readBody(req) };
    res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({
      started: true,
      run_id: "run-new",
      pid: 9012,
    }));
  });
  t.after(() => stopServer(server));
  configureDaemon(t, `RESTART_SERVICE_TOKEN="token-for-test"\nRESTART_SERVICE_PORT=${port}\n`);
  const { POST } = await import("./route.ts");

  const response = await POST(apiRequest("POST", { mode: "restart" }));

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { started: true, run_id: "run-new", pid: 9012 });
  assert.deepEqual(received, { token: "token-for-test", body: '{"mode":"restart"}' });
});

test("POST maps an in-progress daemon run to 409 with its status", async (t) => {
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({
      error: "run already in progress",
      ...DAEMON_STATUS,
    }));
  });
  t.after(() => stopServer(server));
  configureDaemon(t, `RESTART_SERVICE_TOKEN=token-for-test\nRESTART_SERVICE_PORT=${port}\n`);
  const { POST } = await import("./route.ts");

  const response = await POST(apiRequest("POST", { mode: "upgrade" }));

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "run already in progress", status: DAEMON_STATUS });
});

test("POST maps a rejected daemon token to a gateway error", async (t) => {
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(401).end();
  });
  t.after(() => stopServer(server));
  configureDaemon(t, `RESTART_SERVICE_TOKEN=token-for-test\nRESTART_SERVICE_PORT=${port}\n`);
  const { POST } = await import("./route.ts");

  const response = await POST(apiRequest("POST", { mode: "restart" }));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "restart service rejected token" });
});

test("POST maps an unreachable daemon to an unavailable response", async (t) => {
  const port = await unusedLoopbackPort();
  configureDaemon(t, `RESTART_SERVICE_TOKEN=token-for-test\nRESTART_SERVICE_PORT=${port}\n`);
  const { POST } = await import("./route.ts");

  const response = await POST(apiRequest("POST", { mode: "restart" }));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.available, false);
  assert.equal(typeof body.reason, "string");
});

test("POST reports a missing daemon token as not configured", async (t) => {
  configureDaemon(t, "RESTART_SERVICE_PORT=8799\n");
  const { POST } = await import("./route.ts");

  const response = await POST(apiRequest("POST", { mode: "restart" }));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    available: false,
    reason: "restart service not configured",
  });
});

test("service restart is both admin-only and fleet-proxyable for admins", async () => {
  const policy = await import("../../../../lib/admin-api-policy.ts");
  const allowlist = await import("../../../../lib/machines/proxy-allowlist.ts");

  assert.equal(policy.ADMIN_ONLY_API_PREFIXES.includes("/api/service"), true);
  assert.equal(policy.isAdminOnlyLocalApiPath("POST", "/api/service/restart"), true);
  assert.equal(policy.isAdminOnlyRemoteApiPath("/api/service/restart"), true);
  assert.equal(allowlist.isProxyablePath("GET", "/api/service/restart"), true);
  assert.equal(allowlist.isProxyablePath("POST", "/api/service/restart"), true);
});
