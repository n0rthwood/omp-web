// Guards the runtime usage-provider registry (issue #148):
//   T1 the Zhipu adapter rewrites the provider id to the SDK's `zai` and
//      defaults the base URL to the domestic origin (raw key, no Bearer).
//   T2 an explicitly configured base URL is honoured, not replaced by the default.
//   T3 the real domestic quota payload parses into the expected windows.
//   T4 installUsageProviderOverrides registers the probe on a real AuthStorage.
//   T5 a shadowing source (models.yml apiKey pin / runtime / config) makes the
//      probe use the credential inference would use, not the stored row.
//   T6 non-shadowing sources keep the SDK's per-credential behaviour.
//   T7 a shadowing source with no resolvable key keeps the original credential.
//   T8 the Bailian probe maps `bl`'s flat payload (fractions, not percents)
//      and falls back to the SDK probe whenever `bl` cannot answer (#150).
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

const {
  zhipuCodingPlanUsageProvider,
  installUsageProviderOverrides,
  followsInferenceCredential,
  createBailianTokenPlanUsageProvider,
  BAILIAN_TOKEN_PLAN_PROVIDER,
  ZHIPU_PROVIDER,
} = await import("./usage-providers.ts");
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

  // Limit ids/labels come from the SDK (kept verbatim — no parser copy).
  const byId = new Map(report.limits.map((limit) => [limit.id, limit]));
  assert.deepEqual(
    [...byId.keys()].sort(),
    ["zai:features:zread:1mo", "zai:tokens:1w", "zai:tokens:5h"],
  );
  assert.equal(byId.get("zai:tokens:5h").label, "ZAI 5 Hours Token Quota");
  assert.equal(byId.get("zai:tokens:1w").label, "ZAI Weekly Token Quota");
  assert.equal(byId.get("zai:features:zread:1mo").label, "ZAI Zread Quota");

  // The strip representation (lib/provider-status.ts toStatusWindow).
  const windows = report.limits.map(toStatusWindow);
  assert.equal(windows.length, 3);

  const byWindow = new Map(windows.map((window) => [window.windowId, window]));
  const fiveHour = byWindow.get("5h");
  assert.ok(fiveHour, "5h token window");
  assert.equal(fiveHour.id, "zai:tokens:5h");
  assert.equal(fiveHour.label, "ZAI 5 Hours Token Quota");
  assert.equal(fiveHour.usedPercent, 62);
  assert.equal(fiveHour.resetsAt, 1795693919172);
  assert.equal(fiveHour.unit, "tokens");

  const weekly = byWindow.get("1w");
  assert.ok(weekly, "weekly token window");
  assert.equal(weekly.id, "zai:tokens:1w");
  assert.equal(weekly.label, "ZAI Weekly Token Quota");
  assert.equal(weekly.usedPercent, 24);
  assert.equal(weekly.resetsAt, 1796138941984);

  const monthly = byWindow.get("1mo");
  assert.ok(monthly, "monthly request window");
  assert.equal(monthly.id, "zai:features:zread:1mo");
  assert.equal(monthly.label, "ZAI Zread Quota");
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

  // The registry entry is the adapter wrapped for inference-following, so
  // assert on identity + behaviour rather than object equality.
  const installed = authStorage.usage.providerFor(ZHIPU_PROVIDER);
  assert.ok(installed, "the override is registered");
  assert.equal(installed.id, ZHIPU_PROVIDER);
  assert.equal(installed.supports?.(params(undefined)), true);

  // No stored rows in this hermetic store → nothing shadows the credential, so
  // the probe uses the credential it is handed.
  const { fetchImpl, calls } = recordingFetch(LIVE_PAYLOAD);
  const report = await installed.fetchUsage(params(undefined), { fetch: fetchImpl });
  const quota = calls.find((call) => call.url.includes(QUOTA_PATH));
  assert.equal(quota.headers.Authorization, API_KEY);
  assert.ok(report);

  // Installing twice is harmless (runtime overrides are keyed by provider id).
  installUsageProviderOverrides(authStorage);
  assert.equal(authStorage.usage.providerFor(ZHIPU_PROVIDER)?.id, ZHIPU_PROVIDER);
  // The SDK's own zai probe is untouched.
  assert.notEqual(authStorage.usage.providerFor("zai")?.id, ZHIPU_PROVIDER);
});

// ── T5 shadowing source: the probe uses the inference key ──────────────────

/** Stub `authStorage.keys`: a `source` kind plus a counted `peek`. */
function stubKeys(kind, apiKey) {
  const state = { peekCalls: 0 };
  return {
    state,
    source: () => (kind === undefined ? undefined : { kind }),
    peek: async () => {
      state.peekCalls += 1;
      return apiKey;
    },
  };
}

test("a shadowing source makes the installed probe use the inference credential", async () => {
  const { fetchImpl, calls } = recordingFetch(LIVE_PAYLOAD);
  const wrapped = followsInferenceCredential(
    zhipuCodingPlanUsageProvider,
    stubKeys("config", "inference-key"),
  );
  const report = await wrapped.fetchUsage(
    { provider: ZHIPU_PROVIDER, credential: { type: "api_key", apiKey: "stale-row-key" } },
    { fetch: fetchImpl },
  );

  const quota = calls.find((call) => call.url.includes(QUOTA_PATH));
  assert.equal(quota.headers.Authorization, "inference-key");
  assert.ok(!String(quota.headers.Authorization).includes("stale-row-key"));
  assert.ok(report, "the report is still returned");
  assert.equal(report.provider, ZHIPU_PROVIDER);
});

// ── T6 non-shadowing sources keep per-credential behaviour ────────────────

test("a login/pool source probes the stored credential key by key", async () => {
  for (const kind of ["api_key", undefined]) {
    const { fetchImpl, calls } = recordingFetch(LIVE_PAYLOAD);
    const keys = stubKeys(kind, "inference-key");
    const wrapped = followsInferenceCredential(zhipuCodingPlanUsageProvider, keys);
    const report = await wrapped.fetchUsage(
      { provider: ZHIPU_PROVIDER, credential: { type: "api_key", apiKey: "pool-key-1" } },
      { fetch: fetchImpl },
    );

    const quota = calls.find((call) => call.url.includes(QUOTA_PATH));
    assert.equal(quota.headers.Authorization, "pool-key-1");
    assert.equal(keys.state.peekCalls, 0, "peek must not run for a non-shadowing source");
    assert.ok(report);
  }
});

// ── T7 shadowing source without a resolvable inference key ────────────────

test("a shadowing source with no inference key keeps the original credential", async () => {
  const { fetchImpl, calls } = recordingFetch(LIVE_PAYLOAD);
  const keys = stubKeys("config", undefined);
  const wrapped = followsInferenceCredential(zhipuCodingPlanUsageProvider, keys);
  const report = await wrapped.fetchUsage(
    { provider: ZHIPU_PROVIDER, credential: { type: "api_key", apiKey: "pool-key-1" } },
    { fetch: fetchImpl },
  );

  const quota = calls.find((call) => call.url.includes(QUOTA_PATH));
  assert.equal(keys.state.peekCalls, 1);
  assert.equal(quota.headers.Authorization, "pool-key-1");
  assert.ok(report);
});

// ── T8 Bailian Token Plan through the local `bl` CLI (#150) ────────────────

// Verbatim stdout of `bl usage token-plan --output json` on the fleet
// (2026-11-26): pretty-printed quota object plus a second update-notice value.
const BL_STDOUT = `{
  "per1MonthPercentage": 1,
  "per1MonthResetTime": 1797523200000,
  "hasQuotaData": true
}
{"warning":{"message":"Update available: 2.10.1 → 2.12.0. Run bl update to upgrade.","code":"UPDATE_AVAILABLE"}}
`;

const FALLBACK_REPORT = { provider: BAILIAN_TOKEN_PLAN_PROVIDER, fetchedAt: 1, limits: [] };

/** A fallback probe that records how often the adapter delegated to it. */
function countingFallback() {
  const state = { calls: 0 };
  return {
    state,
    provider: {
      id: BAILIAN_TOKEN_PLAN_PROVIDER,
      async fetchUsage() {
        state.calls++;
        return FALLBACK_REPORT;
      },
    },
  };
}

const bailianParams = {
  provider: BAILIAN_TOKEN_PLAN_PROVIDER,
  credential: { type: "api_key", apiKey: "sk-sp-example" },
};

test("bl's pretty-printed payload becomes an exhausted monthly window", async () => {
  const fallback = countingFallback();
  const provider = createBailianTokenPlanUsageProvider({
    run: async () => ({ ok: true, stdout: BL_STDOUT }),
    fallback: fallback.provider,
  });

  const report = await provider.fetchUsage(bailianParams, {});
  assert.equal(fallback.state.calls, 0);
  assert.equal(report.provider, BAILIAN_TOKEN_PLAN_PROVIDER);
  assert.equal(report.limits.length, 1);

  const [monthly] = report.limits;
  assert.equal(monthly.id, "credits:1mo");
  assert.equal(monthly.label, "Monthly quota");
  assert.equal(monthly.scope.provider, BAILIAN_TOKEN_PLAN_PROVIDER);
  assert.equal(monthly.window.resetsAt, 1797523200000);
  // `percentage: 1` is a FRACTION: the plan is spent, not 1% used.
  assert.equal(monthly.amount.usedFraction, 1);
  assert.equal(monthly.status, "exhausted");

  const statusWindow = toStatusWindow(monthly);
  assert.equal(statusWindow.usedPercent, 100);
  assert.equal(statusWindow.windowId, "1mo");
});

test("every window maps, shortest first, and unusable fields are skipped", async () => {
  const provider = createBailianTokenPlanUsageProvider({
    run: async () => ({
      ok: true,
      stdout: JSON.stringify({
        per1MonthPercentage: 0.3,
        per1MonthResetTime: 1797523200000,
        per5HourPercentage: 0.95,
        per5HourResetTime: "not-a-number",
        per7DayPercentage: null,
        hasQuotaData: true,
      }),
    }),
    fallback: countingFallback().provider,
  });

  const report = await provider.fetchUsage(bailianParams, {});
  assert.deepEqual(
    report.limits.map((limit) => [limit.id, limit.amount.usedFraction, limit.status]),
    [
      ["credits:5h", 0.95, "warning"],
      ["credits:1mo", 0.3, "ok"],
    ],
  );
  // A non-numeric reset time is dropped, never rendered as NaN or "Invalid Date".
  assert.equal(report.limits[0].window.resetsAt, undefined);
  // per7Day carried no usable percentage, so it produced no window at all.
  assert.ok(!report.limits.some((limit) => limit.id === "credits:7d"));
});

test("the SDK probe answers whenever bl cannot", async () => {
  const cases = [
    ["binary missing / non-zero exit", async () => ({ ok: false, stdout: "" })],
    ["account without a Token Plan", async () => ({ ok: true, stdout: '{"hasQuotaData":false}' })],
    ["unparsable stdout", async () => ({ ok: true, stdout: "bl: command not found" })],
    ["runner throws (timeout/kill)", async () => { throw new Error("ETIMEDOUT"); }],
  ];
  for (const [name, run] of cases) {
    const fallback = countingFallback();
    const provider = createBailianTokenPlanUsageProvider({ run, fallback: fallback.provider });
    const report = await provider.fetchUsage(bailianParams, {});
    assert.equal(fallback.state.calls, 1, name);
    assert.equal(report, FALLBACK_REPORT, name);
  }
});

test("the registry installs the Bailian probe alongside Zhipu", async () => {
  const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
  const authStorage = await discoverAuthStorage(join(base, "agent"));
  installUsageProviderOverrides(authStorage);

  const installed = authStorage.usage.providerFor(BAILIAN_TOKEN_PLAN_PROVIDER);
  assert.equal(installed?.id, BAILIAN_TOKEN_PLAN_PROVIDER);
  assert.equal(installed?.supports?.(bailianParams), true);
  assert.equal(installed?.supports?.({ ...bailianParams, provider: "zai" }), false);
});