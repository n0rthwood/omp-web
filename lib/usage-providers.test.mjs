// Guards the runtime usage-provider registry (issue #148):
//   T1 the Zhipu adapter rewrites the provider id to the SDK's `zai` and
//      defaults the base URL to the domestic origin (raw key, no Bearer).
//   T2 an explicitly configured base URL is honoured, not replaced by the default.
//   T3 the real domestic quota payload parses into the expected windows.
//   T4 installUsageProviderOverrides registers the probe on a real AuthStorage.
// Individually runnable: bun test lib/usage-providers.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Hermetic agent dir BEFORE any SDK import: the modules under test pull in
// lib/omp-runtime → pi-coding-agent, whose stores default to ~/.omp/agent.
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const base = mkdtempSync(join(tmpdir(), "omp148-usage-providers-"));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
setAgentDir(join(base, "agent"));
// Never auto-start the process-wide poller from a test import.
const savedDisable = process.env.OMP_WEB_PROVIDER_POLL_DISABLE;
process.env.OMP_WEB_PROVIDER_POLL_DISABLE = "1";

const { zhipuCodingPlanUsageProvider, installUsageProviderOverrides, ZHIPU_PROVIDER } = await import(
  "./usage-providers.ts"
);
const { toStatusWindow } = await import("./provider-status.ts");

after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else setAgentDir(savedAgentDir);
  if (savedDisable === undefined) delete process.env.OMP_WEB_PROVIDER_POLL_DISABLE;
  else process.env.OMP_WEB_PROVIDER_POLL_DISABLE = savedDisable;
  rmSync(base, { recursive: true, force: true });
});

// The monitor endpoint the SDK builds from the base URL origin.
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const API_KEY = "id.secret-hermetic";

/** A fetch that records every call and answers the quota probe with `payload`. */
function recordingFetch(payload) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    if (String(url).includes(QUOTA_PATH)) {
      return { ok: true, status: 200, json: async () => payload };
    }
    // The SDK's secondary model-usage probe: nothing to assert here.
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

const params = (baseUrl) => ({
  provider: ZHIPU_PROVIDER,
  credential: { type: "api_key", apiKey: API_KEY },
  ...(baseUrl === undefined ? {} : { baseUrl }),
});

// ── T1 provider rewrite + domestic base URL default ──────────────────────────

test("adapter probes the SDK's zai endpoint at the domestic origin by default", async () => {
  const { calls, fetchImpl } = recordingFetch({ success: true, data: { limits: [] } });
  const report = await zhipuCodingPlanUsageProvider.fetchUsage(params(undefined), { fetch: fetchImpl });

  const quota = calls.find((call) => call.url.includes(QUOTA_PATH));
  assert.ok(quota, "the quota endpoint must be probed");
  assert.equal(quota.url, `https://open.bigmodel.cn${QUOTA_PATH}`);
  // Domestic GLM keys are sent verbatim in Authorization, with no Bearer prefix.
  assert.equal(quota.headers.Authorization, API_KEY);
  assert.ok(!String(quota.headers.Authorization).startsWith("Bearer "));
  // No windows in this payload → no report.
  assert.equal(report, null);
});

test("adapter accepts the zhipu provider id and rejects foreign ones", () => {
  assert.equal(zhipuCodingPlanUsageProvider.id, ZHIPU_PROVIDER);
  assert.equal(zhipuCodingPlanUsageProvider.supports?.(params(undefined)), true);
  assert.equal(zhipuCodingPlanUsageProvider.supports?.({ ...params(undefined), provider: "zai" }), false);
  assert.equal(
    zhipuCodingPlanUsageProvider.supports?.({ ...params(undefined), credential: { type: "api_key" } }),
    false,
  );
});

// ── T2 explicit base URL is preserved ───────────────────────────────────────

test("an explicitly configured base URL is used as-is (origin only)", async () => {
  const { calls, fetchImpl } = recordingFetch({ success: true, data: { limits: [] } });
  await zhipuCodingPlanUsageProvider.fetchUsage(params("https://open.bigmodel.cn/api/coding/paas/v4"), {
    fetch: fetchImpl,
  });
  const quota = calls.find((call) => call.url.includes(QUOTA_PATH));
  assert.equal(quota.url, `https://open.bigmodel.cn${QUOTA_PATH}`);
});

test("a non-default base URL is honoured instead of the domestic default", async () => {
  const { calls, fetchImpl } = recordingFetch({ success: true, data: { limits: [] } });
  await zhipuCodingPlanUsageProvider.fetchUsage(params("https://api.z.ai"), { fetch: fetchImpl });
  const quota = calls.find((call) => call.url.includes(QUOTA_PATH));
  assert.equal(quota.url, `https://api.z.ai${QUOTA_PATH}`);
});

// ── T3 real domestic payload → windows ──────────────────────────────────────

// Captured live from GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
// with the fleet's ZHIPU_API_KEY (2026-11-26): 5h tokens 62%, weekly tokens 24%,
// monthly requests 0%.
const LIVE_PAYLOAD = {
  code: 200,
  msg: "操作成功",
  data: {
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 0,
        remaining: 4000,
        percentage: 0,
        nextResetTime: 1797002941999,
        usageDetails: [
          { modelCode: "search-prime", usage: 0 },
          { modelCode: "web-reader", usage: 0 },
          { modelCode: "zread", usage: 0 },
        ],
      },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 62, nextResetTime: 1795693919172 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 24, nextResetTime: 1796138941984 },
    ],
    level: "max",
  },
  success: true,
};

test("the live domestic payload parses into 5h / weekly / monthly windows", async () => {
  const { fetchImpl } = recordingFetch(LIVE_PAYLOAD);
  const report = await zhipuCodingPlanUsageProvider.fetchUsage(params(undefined), { fetch: fetchImpl });

  assert.ok(report, "a report is expected");
  // Re-attributed to the configured provider id, so the poller files it under
  // zhipu-coding-plan rather than the SDK's internal `zai`.
  assert.equal(report.provider, ZHIPU_PROVIDER);
  assert.equal(report.metadata?.planType, "max");
  assert.ok(report.limits.every((limit) => limit.scope.provider === ZHIPU_PROVIDER));

  const windows = report.limits.map(toStatusWindow);
  assert.equal(windows.length, 3);

  const byWindow = new Map(windows.map((window) => [window.windowId, window]));
  const fiveHour = byWindow.get("5h");
  assert.ok(fiveHour, "5h token window");
  assert.equal(fiveHour.usedPercent, 62);
  assert.equal(fiveHour.resetsAt, 1795693919172);
  assert.equal(fiveHour.unit, "tokens");

  const weekly = byWindow.get("1w");
  assert.ok(weekly, "weekly token window");
  assert.equal(weekly.usedPercent, 24);
  assert.equal(weekly.resetsAt, 1796138941984);

  const monthly = byWindow.get("1mo");
  assert.ok(monthly, "monthly request window");
  assert.equal(monthly.usedPercent, 0);
  assert.equal(monthly.resetsAt, 1797002941999);
  assert.equal(monthly.unit, "requests");
});

// ── T4 install registers the override on a real AuthStorage ────────────────

test("installUsageProviderOverrides makes providerFor(zhipu-coding-plan) resolve", async () => {
  const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
  const authStorage = await discoverAuthStorage(join(base, "agent"));

  assert.equal(authStorage.usage.providerFor(ZHIPU_PROVIDER), undefined);
  installUsageProviderOverrides(authStorage);

  assert.equal(authStorage.usage.providerFor(ZHIPU_PROVIDER), zhipuCodingPlanUsageProvider);
  // Installing twice is harmless (runtime overrides are keyed by provider id).
  installUsageProviderOverrides(authStorage);
  assert.equal(authStorage.usage.providerFor(ZHIPU_PROVIDER), zhipuCodingPlanUsageProvider);
  // The SDK's own zai probe is untouched.
  assert.notEqual(authStorage.usage.providerFor("zai"), zhipuCodingPlanUsageProvider);
});