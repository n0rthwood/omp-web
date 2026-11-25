// GET /api/models/health stamps a live credential's "last refresh" from the
// provider-status poller (issue #145). Fully hermetic: both pollers are
// disabled and their snapshots are injected, so no SDK store is ever opened.
// Individually runnable: bun test app/api/models/health/route.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });

const SAVED = {
  OMP_WEB_PROVIDER_POLL_DISABLE: process.env.OMP_WEB_PROVIDER_POLL_DISABLE,
  OMP_WEB_MODELS_HEALTH_DISABLE: process.env.OMP_WEB_MODELS_HEALTH_DISABLE,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
process.env.OMP_WEB_PROVIDER_POLL_DISABLE = "1";
process.env.OMP_WEB_MODELS_HEALTH_DISABLE = "1";
const base = mkdtempSync(join(tmpdir(), "omp145-health-route-"));
process.env.PI_CODING_AGENT_DIR = join(base, "agent");

const { GET } = await jiti.import("./route.ts");
const { stampKeepaliveTime } = await jiti.import("@/lib/provider-status.ts");

after(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__ompProviderStatusPoller = undefined;
  globalThis.__ompModelsHealthPoller = undefined;
  rmSync(base, { recursive: true, force: true });
});

const KEEPALIVE = new Map([
  ["anthropic", 9_000],
  ["openai-codex", 8_000],
  ["xai-oauth", 7_000],
  ["joyai", 6_000],
]);

test("a live credential takes the keepalive time; a disabled one keeps its own", () => {
  const stamped = stampKeepaliveTime({
    anthropic: { state: "ok" },
    "openai-codex": { state: "expiring", expiresAt: 99_000 },
    "xai-oauth": { state: "disabled", cause: "invalid_grant", lastRefreshAt: 1_000 },
    // No login and no successful probe: nothing may be invented.
    "bailian-token-plan": { state: "ok" },
  }, KEEPALIVE);
  assert.deepEqual(stamped.anthropic, { state: "ok", lastRefreshAt: 9_000 });
  assert.deepEqual(stamped["openai-codex"], { state: "expiring", expiresAt: 99_000, lastRefreshAt: 8_000 });
  assert.equal(stamped["xai-oauth"].lastRefreshAt, 1_000, "the failed refresh is not overwritten by an older probe");
  assert.deepEqual(stamped["bailian-token-plan"], { state: "ok" });
});

test("the route serves the scanned snapshot with the keepalive time merged in", async () => {
  globalThis.__ompModelsHealthPoller = {
    snapshot: {
      scannedAt: 50_000,
      providers: { anthropic: { state: "ok" }, "xai-oauth": { state: "disabled", cause: "boom", lastRefreshAt: 1_000 } },
      availableModelCount: 12,
      disabledModelCount: 3,
      modelHealth: {},
    },
    signature: "",
    timer: undefined,
    cycle: null,
    started: true,
  };
  globalThis.__ompProviderStatusPoller = {
    snapshot: { fetchedAt: 40_000, nextPollAt: null, providers: [{ id: "anthropic", displayName: "Anthropic", kind: "oauth-usage", status: "ok", windows: [], refreshedAt: 39_000 }] },
    timer: undefined,
    cycle: null,
    started: true,
  };

  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    scannedAt: 50_000,
    providers: { anthropic: { state: "ok", lastRefreshAt: 39_000 }, "xai-oauth": { state: "disabled", cause: "boom", lastRefreshAt: 1_000 } },
    availableModelCount: 12,
    disabledModelCount: 3,
  });
});

test("a failed scan is still a 503, not an empty body", async () => {
  globalThis.__ompModelsHealthPoller = { snapshot: null, signature: "", timer: undefined, cycle: null, started: true };
  const response = await GET();
  assert.equal(response.status, 503);
});
