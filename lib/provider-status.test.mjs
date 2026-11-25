// Guards the provider-status poller/aggregation (issue #134):
//   T1 cycle delay = base + uniform [0, 300s) jitter, env-overridable base.
//   T2 OpenRouter account dedup (sibling keys count once) + multi-account sum.
//   T3 presence-only providers make ZERO upstream requests.
//   T4 snapshot is secret-free (labels/counts only) and maps SDK windows.
// Individually runnable: bun test lib/provider-status.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Hermetic agent dir BEFORE any SDK import: the poller module pulls in
// lib/omp-runtime → pi-coding-agent, whose stores default to ~/.omp/agent.
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const base = mkdtempSync(join(tmpdir(), "omp134-provider-status-"));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
setAgentDir(join(base, "agent"));
// Never auto-start the process-wide poller from a test import.
const savedDisable = process.env.OMP_WEB_PROVIDER_POLL_DISABLE;
process.env.OMP_WEB_PROVIDER_POLL_DISABLE = "1";
const savedPollMs = process.env.OMP_WEB_PROVIDER_POLL_MS;
delete process.env.OMP_WEB_PROVIDER_POLL_MS;

const {
  PROVIDER_POLL_BASE_MS,
  PROVIDER_POLL_JITTER_MS,
  nextCycleDelayMs,
  fetchOpenRouterStatus,
  collectProviderStatus,
  toStatusWindow,
} = await import("./provider-status.ts");

after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else setAgentDir(savedAgentDir);
  if (savedDisable === undefined) delete process.env.OMP_WEB_PROVIDER_POLL_DISABLE;
  else process.env.OMP_WEB_PROVIDER_POLL_DISABLE = savedDisable;
  if (savedPollMs === undefined) delete process.env.OMP_WEB_PROVIDER_POLL_MS;
  else process.env.OMP_WEB_PROVIDER_POLL_MS = savedPollMs;
  rmSync(base, { recursive: true, force: true });
});

// ── T1 jitter bounds ─────────────────────────────────────────────────────────

test("cycle delay is base + uniform [0, 300s) jitter, recomputed per call", () => {
  assert.equal(PROVIDER_POLL_BASE_MS, 30 * 60 * 1000);
  assert.equal(PROVIDER_POLL_JITTER_MS, 300 * 1000);
  assert.equal(nextCycleDelayMs(() => 0), PROVIDER_POLL_BASE_MS);
  assert.equal(nextCycleDelayMs(() => 0.5), PROVIDER_POLL_BASE_MS + 150_000);
  const nearMax = nextCycleDelayMs(() => 0.999999);
  assert.ok(nearMax >= PROVIDER_POLL_BASE_MS && nearMax < PROVIDER_POLL_BASE_MS + PROVIDER_POLL_JITTER_MS);
  // Non-constant: distinct RNG draws give distinct delays.
  assert.notEqual(nextCycleDelayMs(() => 0.1), nextCycleDelayMs(() => 0.9));
});

test("OMP_WEB_PROVIDER_POLL_MS overrides the base interval", () => {
  process.env.OMP_WEB_PROVIDER_POLL_MS = "1000";
  try {
    assert.equal(nextCycleDelayMs(() => 0), 1000);
    assert.ok(nextCycleDelayMs(() => 0.5) >= 1000);
    assert.ok(nextCycleDelayMs(() => 0.5) < 1000 + PROVIDER_POLL_JITTER_MS);
  } finally {
    delete process.env.OMP_WEB_PROVIDER_POLL_MS;
  }
  // Garbage values fall back to the 30min base.
  process.env.OMP_WEB_PROVIDER_POLL_MS = "not-a-number";
  try {
    assert.equal(nextCycleDelayMs(() => 0), PROVIDER_POLL_BASE_MS);
  } finally {
    delete process.env.OMP_WEB_PROVIDER_POLL_MS;
  }
});

// ── T2 OpenRouter aggregation ────────────────────────────────────────────────

/** Mock fetch keyed by the Bearer token; records every URL it was asked for. */
function openRouterFetch(accounts) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push(url);
    const key = options.headers.Authorization.replace("Bearer ", "");
    const account = accounts[key];
    if (!account) return { ok: false, status: 401, json: async () => ({}) };
    if (url.endsWith("/api/v1/key")) {
      if (account.keyError) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            label: account.label,
            is_free_tier: true,
            free_model_daily_requests: { used: account.used, limit: account.limit, remaining: account.limit - account.used },
          },
        }),
      };
    }
    if (url.endsWith("/api/v1/credits")) {
      if (account.creditsError) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { total_credits: account.credits, total_usage: account.usage } }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { impl, calls };
}

test("two keys of one account count once; two accounts sum", async () => {
  const { impl } = openRouterFetch({
    "key-a1": { label: "a1", credits: 10, usage: 3, used: 900, limit: 1000 },
    "key-a2": { label: "a2", credits: 10, usage: 3, used: 900, limit: 1000 },
    "key-b1": { label: "b1", credits: 20, usage: 1, used: 500, limit: 2000 },
  });
  const entry = await fetchOpenRouterStatus(["key-a1", "key-a2", "key-b1"], impl);
  assert.equal(entry.kind, "openrouter");
  assert.equal(entry.keyCount, 3);
  assert.equal(entry.accountCount, 2);
  assert.equal(entry.windows.length, 1);
  assert.equal(entry.windows[0].used, 1400);
  assert.equal(entry.windows[0].limit, 3000);
  assert.equal(entry.windows[0].unit, "requests");
  assert.equal(entry.status, "ok");
  assert.deepEqual(entry.keys.map((k) => k.label), ["a1", "a2", "b1"]);
});

test("sibling keys sharing one counter are not double-counted", async () => {
  const { impl } = openRouterFetch({
    "key-1": { label: "one", credits: 5, usage: 2, used: 2700, limit: 3000 },
    "key-2": { label: "two", credits: 5, usage: 2, used: 2700, limit: 3000 },
  });
  const entry = await fetchOpenRouterStatus(["key-1", "key-2"], impl);
  assert.equal(entry.accountCount, 1);
  assert.equal(entry.windows[0].used, 2700);
  assert.equal(entry.windows[0].limit, 3000);
  // 90% used → warning per the shared usageStatus thresholds.
  assert.equal(entry.status, "warning");
});

test("credits-probe failure keeps a key as its own account (conservative)", async () => {
  const { impl } = openRouterFetch({
    "key-1": { label: "one", credits: 5, usage: 2, used: 100, limit: 1000 },
    "key-2": { label: "two", creditsError: true, used: 100, limit: 1000 },
  });
  const entry = await fetchOpenRouterStatus(["key-1", "key-2"], impl);
  assert.equal(entry.accountCount, 2);
  assert.equal(entry.windows[0].used, 200);
});

test("all key probes failing yields an error entry, never a throw", async () => {
  const { impl } = openRouterFetch({
    "key-1": { keyError: true, creditsError: true },
  });
  const entry = await fetchOpenRouterStatus(["key-1"], impl);
  assert.equal(entry.status, "error");
  assert.equal(entry.windows.length, 0);
  assert.ok(entry.error);
  assert.equal(entry.keys[0].error, "HTTP 500");
});

test("no keys → absent entry with zero requests", async () => {
  const { impl, calls } = openRouterFetch({});
  const entry = await fetchOpenRouterStatus([], impl);
  assert.equal(entry.status, "absent");
  assert.equal(calls.length, 0);
});

// ── T3 presence-only providers: zero upstream requests ──────────────────────

function presenceDeps(overrides = {}) {
  return {
    fetchReports: async () => [],
    listCredentials: (provider) =>
      provider === "zhipu-coding-plan" || provider === "alibaba-coding-plan"
        ? [{ type: "api_key", key: `secret-${provider}` }]
        : [],
    configuredProviders: () => ["zhipu-coding-plan", "alibaba-coding-plan"],
    hasUsageProvider: () => false,
    displayName: (provider) => provider,
    fetchImpl: async () => {
      throw new Error("presence-only providers must never fetch");
    },
    ...overrides,
  };
}

test("zhipu/bailian render presence dots with zero upstream requests", async () => {
  let reportCalls = 0;
  const deps = presenceDeps({
    fetchReports: async () => {
      reportCalls += 1;
      return [];
    },
  });
  const entries = await collectProviderStatus(deps);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.kind, "presence");
    assert.equal(entry.status, "ok");
    assert.deepEqual(entry.windows, []);
    assert.equal(entry.keyCount, 1);
  }
  // The SDK reports call is the only upstream surface; presence rows add none.
  assert.equal(reportCalls, 1);
});

test("env-only presence provider (no stored rows) still renders green", async () => {
  // Fleet plain keys live in ~/.omp/agent/.env: configuredProviders lists the
  // provider via keys.source().concrete even with zero credential rows.
  const entries = await collectProviderStatus(presenceDeps({ listCredentials: () => [] }));
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.status, "ok");
    assert.equal(entry.keyCount, 0);
    assert.deepEqual(entry.windows, []);
  }
});

test("env-key provider WITH a usage provider but no stored rows stays presence-green", async () => {
  // alibaba-token-plan's usage probe needs a stored console-cookie credential;
  // a fleet .env API key can never yield windows. It must render a green
  // presence dot, not a red "no usage data" error (gateway verify 2026-11-25).
  const entries = await collectProviderStatus(presenceDeps({
    configuredProviders: () => ["alibaba-token-plan"],
    listCredentials: () => [],
    hasUsageProvider: (provider) => provider === "alibaba-token-plan",
  }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "presence");
  assert.equal(entries[0].status, "ok");
  assert.deepEqual(entries[0].windows, []);
});

// ── T4 snapshot shape: secret-free, SDK windows mapped ──────────────────────

function anthropicReport() {
  return {
    provider: "anthropic",
    fetchedAt: Date.now(),
    limits: [
      {
        id: "anthropic:7d",
        label: "Claude 7 Day",
        scope: { provider: "anthropic", accountId: "acct-secret-123", shared: true },
        window: { id: "7d", label: "7 Day", resetsAt: 1_800_000_000_000 },
        amount: { used: 60, unit: "percent" },
      },
      {
        id: "anthropic:7d:fable",
        label: "Claude 7 Day (Fable)",
        scope: { provider: "anthropic", tier: "fable" },
        window: { id: "7d", label: "7 Day", resetsAt: 1_800_000_000_000 },
        amount: { usedFraction: 0.5, unit: "percent" },
      },
    ],
    metadata: { email: "private@example.com" },
    raw: { secret: "raw-payload-secret" },
  };
}

test("usage windows map to percent + resetsAt; worst status rolls up", async () => {
  const entries = await collectProviderStatus({
    fetchReports: async () => [anthropicReport()],
    listCredentials: (provider) => (provider === "anthropic" ? [{ type: "oauth" }] : []),
    configuredProviders: () => ["anthropic"],
    hasUsageProvider: () => true,
    displayName: (provider) => provider,
  });
  const anthropic = entries.find((entry) => entry.id === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic.kind, "oauth-usage");
  assert.equal(anthropic.status, "ok");
  const overall = anthropic.windows.find((w) => w.id === "anthropic:7d");
  assert.equal(overall.usedPercent, 60);
  assert.equal(overall.resetsAt, 1_800_000_000_000);
  const fable = anthropic.windows.find((w) => w.id === "anthropic:7d:fable");
  assert.equal(fable.usedPercent, 50);
});

test("exhausted window dominates the provider rollup", () => {
  const ok = toStatusWindow({
    id: "x:ok", label: "ok", scope: { provider: "x" },
    amount: { usedFraction: 0.2, unit: "percent" },
  });
  const exhausted = toStatusWindow({
    id: "x:full", label: "full", scope: { provider: "x" },
    amount: { usedFraction: 1, unit: "percent" },
  });
  assert.equal(ok.status, "ok");
  assert.equal(exhausted.status, "exhausted");
  assert.equal(exhausted.usedPercent, 100);
});

test("snapshot never contains key material or account identity", async () => {
  const SECRET = "sk-or-v1-DO-NOT-LEAK-0123456789";
  const { impl } = openRouterFetch({
    [SECRET]: { label: "my-key", credits: 10, usage: 3, used: 900, limit: 1000 },
  });
  const entries = await collectProviderStatus({
    fetchReports: async () => [anthropicReport()],
    listCredentials: (provider) => {
      if (provider === "openrouter") return [{ type: "api_key", key: SECRET }];
      if (provider === "anthropic") return [{ type: "oauth" }];
      if (provider === "zhipu-coding-plan") return [{ type: "api_key", key: "zhipu-secret-key" }];
      return [];
    },
    configuredProviders: () => ["anthropic", "openrouter", "zhipu-coding-plan"],
    hasUsageProvider: (provider) => provider === "anthropic",
    displayName: (provider) => provider,
    fetchImpl: impl,
  });
  const serialized = JSON.stringify({ fetchedAt: Date.now(), nextPollAt: Date.now(), providers: entries });
  assert.ok(!serialized.includes(SECRET), "OpenRouter key leaked");
  assert.ok(!serialized.includes("zhipu-secret-key"), "Zhipu key leaked");
  assert.ok(!serialized.includes("acct-secret-123"), "account id leaked");
  assert.ok(!serialized.includes("private@example.com"), "email leaked");
  assert.ok(!serialized.includes("raw-payload-secret"), "raw payload leaked");
  // Labels and counts ARE present.
  assert.ok(serialized.includes("my-key"));
  const openrouter = entries.find((entry) => entry.id === "openrouter");
  assert.equal(openrouter.keyCount, 1);
  assert.equal(openrouter.accountCount, 1);
});

test("usage-capable provider with credentials but no report answers error", async () => {
  const entries = await collectProviderStatus({
    fetchReports: async () => [],
    listCredentials: () => [{ type: "oauth" }],
    configuredProviders: () => ["anthropic"],
    hasUsageProvider: () => true,
    displayName: (provider) => provider,
  });
  assert.equal(entries[0].status, "error");
  assert.equal(entries[0].error, "no usage data");
});

test("reports() rejection surfaces as error rows, not a thrown cycle", async () => {
  const entries = await collectProviderStatus({
    fetchReports: async () => {
      throw new Error("upstream exploded");
    },
    listCredentials: () => [{ type: "oauth" }],
    configuredProviders: () => ["anthropic"],
    hasUsageProvider: () => true,
    displayName: (provider) => provider,
  });
  assert.equal(entries[0].status, "error");
  assert.equal(entries[0].error, "upstream exploded");
});

// ── T5 data time + window id (issue #145) ───────────────────────────────────

test("a window carries the SDK window id so the strip can name it compactly", () => {
  const window = toStatusWindow({
    id: "openai-codex:primary",
    label: "5 hours",
    scope: { provider: "openai-codex" },
    window: { id: "5h", label: "5 Hour" },
    amount: { usedFraction: 0.12, unit: "percent" },
  });
  assert.equal(window.windowId, "5h");
  assert.equal(
    "windowId" in toStatusWindow({ id: "x", label: "x", scope: { provider: "x" }, amount: { unit: "percent" } }),
    false,
  );
});

test("a report-backed entry records when its numbers were measured and when the keepalive last touched it", async () => {
  const limit = (id) => ({ id, label: id, scope: { provider: "anthropic" }, amount: { usedFraction: 0.5, unit: "percent" } });
  const entries = await collectProviderStatus({
    fetchReports: async () => [
      { provider: "anthropic", fetchedAt: 5_000, limits: [limit("anthropic:7d")] },
      { provider: "anthropic", fetchedAt: 1_000, limits: [limit("anthropic:5h")] },
      // A probe that answered without limits proves liveness but measures nothing.
      { provider: "anthropic", fetchedAt: 9_000, limits: [] },
    ],
    listCredentials: () => [{ type: "oauth" }, { type: "oauth" }, { type: "oauth" }],
    configuredProviders: () => ["anthropic"],
    hasUsageProvider: () => true,
    displayName: (provider) => provider,
  });
  assert.equal(entries[0].recordedAt, 1_000, "as-of is the oldest limit-bearing report");
  assert.equal(entries[0].refreshedAt, 9_000, "keepalive is the newest successful probe");
});

test("presence rows carry no measurement time of their own", async () => {
  const entries = await collectProviderStatus(presenceDeps());
  for (const entry of entries) {
    assert.equal("recordedAt" in entry, false);
    assert.equal("refreshedAt" in entry, false);
  }
});
