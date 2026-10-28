import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getRestartServiceAvailability,
  parseRestartServiceEnv,
  resolveRestartServiceConfig,
} from "./restart-service.ts";

test("restart-service env parser ignores comments and strips surrounding quotes", () => {
  const config = parseRestartServiceEnv(`
# daemon credentials
RESTART_SERVICE_TOKEN="token-value"

RESTART_SERVICE_PORT="9100"
IGNORED=value
`);

  assert.deepEqual(config, { token: "token-value", port: 9100 });
});

test("restart-service env parser defaults invalid or missing values safely", () => {
  assert.deepEqual(parseRestartServiceEnv("RESTART_SERVICE_PORT=not-a-port\n"), {
    token: null,
    port: 8799,
  });
  assert.deepEqual(parseRestartServiceEnv("RESTART_SERVICE_PORT=123abc\n"), {
    token: null,
    port: 8799,
  });
});

test("restart-service config reads the override file on every call and tolerates a missing file", (t) => {
  const saved = process.env.OMP_RESTART_SERVICE_ENV;
  const dir = mkdtempSync(join(tmpdir(), "omp-web-restart-config-"));
  const path = join(dir, "restart-service.env");
  process.env.OMP_RESTART_SERVICE_ENV = path;
  t.after(() => {
    if (saved === undefined) delete process.env.OMP_RESTART_SERVICE_ENV;
    else process.env.OMP_RESTART_SERVICE_ENV = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(resolveRestartServiceConfig(), { token: null, port: 8799 });
  writeFileSync(path, "RESTART_SERVICE_TOKEN=first\nRESTART_SERVICE_PORT=8801\n");
  assert.deepEqual(resolveRestartServiceConfig(), { token: "first", port: 8801 });
  writeFileSync(path, "RESTART_SERVICE_TOKEN=second\nRESTART_SERVICE_PORT=8802\n");
  assert.deepEqual(resolveRestartServiceConfig(), { token: "second", port: 8802 });
});

test("restart-service health probes time out by destroying the loopback request", async (t) => {
  const server = createServer(() => {});
  const { promise: listening, resolve: resolveListening } = Promise.withResolvers();
  server.listen(0, "127.0.0.1", resolveListening);
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

  const saved = process.env.OMP_RESTART_SERVICE_ENV;
  const dir = mkdtempSync(join(tmpdir(), "omp-web-restart-timeout-"));
  const path = join(dir, "restart-service.env");
  writeFileSync(path, `RESTART_SERVICE_PORT=${address.port}\n`);
  process.env.OMP_RESTART_SERVICE_ENV = path;
  t.after(async () => {
    if (saved === undefined) delete process.env.OMP_RESTART_SERVICE_ENV;
    else process.env.OMP_RESTART_SERVICE_ENV = saved;
    rmSync(dir, { recursive: true, force: true });
    const { promise: closed, resolve: resolveClosed } = Promise.withResolvers();
    server.close(resolveClosed);
    await closed;
  });

  const result = await getRestartServiceAvailability(25);

  assert.equal(result.available, false);
  assert.match(result.reason, /timeout after 25ms/);
});
