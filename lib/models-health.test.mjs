// Guards the model freshness + health scan (issue #139):
//   T1 interval policy: default 60s, OMP_WEB_MODELS_HEALTH_MS override.
//   T2 provider classification: active / expiring OAuth / disabled tombstone /
//      keyless / env-concrete / missing.
//   T3 per-model health mapping + counts (ok/disabled/unverified).
//   T4 signature change invalidates the models cache; a stable scan does not.
//   T5 real SDK credential pool: an EXTERNAL sqlite disabled_cause is visible
//      on the next scan (reload path), with no restart.
// Individually runnable: bun test lib/models-health.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// Hermetic agent dir BEFORE any SDK import: lib/models-health pulls in
// lib/omp-runtime → pi-coding-agent, whose stores default to ~/.omp/agent.
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const base = mkdtempSync(join(tmpdir(), "omp139-models-health-"));
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
setAgentDir(join(base, "agent"));
// Never auto-start the process-wide poller from a test import.
const savedDisable = process.env.OMP_WEB_MODELS_HEALTH_DISABLE;
process.env.OMP_WEB_MODELS_HEALTH_DISABLE = "1";
const savedScanMs = process.env.OMP_WEB_MODELS_HEALTH_MS;
delete process.env.OMP_WEB_MODELS_HEALTH_MS;

const {
  MODELS_HEALTH_SCAN_BASE_MS,
  modelsHealthScanIntervalMs,
  collectModelsHealth,
  modelsHealthSignature,
  modelHealthForProvider,
  refreshModelsFreshness,
} = await import("./models-health.ts");

after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedDisable === undefined) delete process.env.OMP_WEB_MODELS_HEALTH_DISABLE;
  else process.env.OMP_WEB_MODELS_HEALTH_DISABLE = savedDisable;
  if (savedScanMs === undefined) delete process.env.OMP_WEB_MODELS_HEALTH_MS;
  else process.env.OMP_WEB_MODELS_HEALTH_MS = savedScanMs;
  rmSync(base, { recursive: true, force: true });
});

// ── T1 interval policy ───────────────────────────────────────────────────────

test("scan interval defaults to 60s and OMP_WEB_MODELS_HEALTH_MS overrides it", () => {
  assert.equal(MODELS_HEALTH_SCAN_BASE_MS, 60_000);
  assert.equal(modelsHealthScanIntervalMs({}), 60_000);
  assert.equal(modelsHealthScanIntervalMs({ OMP_WEB_MODELS_HEALTH_MS: "5000" }), 5000);
  // Garbage / absurd values fall back instead of arming a 0ms timer.
  assert.equal(modelsHealthScanIntervalMs({ OMP_WEB_MODELS_HEALTH_MS: "nope" }), 60_000);
  assert.equal(modelsHealthScanIntervalMs({ OMP_WEB_MODELS_HEALTH_MS: "5" }), 60_000);
});

// ── T2/T3 classification ─────────────────────────────────────────────────────

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function oauthCredential(expires, extra = {}) {
  return { type: "oauth", refresh: "r", access: "a", expires, ...extra };
}

/** Full deps object; tests override only what they exercise. */
function deps(overrides = {}) {
  const state = {
    invalidated: 0,
    reloaded: 0,
    refreshed: 0,
    ...(overrides.state ?? {}),
  };
  return {
    state,
    value: {
      reloadCredentials: async () => {
        state.reloaded += 1;
      },
      refreshRegistry: async () => {
        state.refreshed += 1;
        return false;
      },
      listCredentials: () => [],
      listDisabled: async () => [],
      hasConcreteSource: () => false,
      keyless: () => false,
      availableModels: () => [],
      providerIds: () => [],
      invalidateModelsCache: () => {
        state.invalidated += 1;
      },
      ...overrides.value,
    },
  };
}

test("an externally disabled credential marks the provider and its models disabled", async () => {
  const d = deps({
    value: {
      // The pool re-lists only live rows; the disabled row lives in the
      // tombstone list (exactly what `credentials.reload()` produces).
      listCredentials: () => [],
      listDisabled: async () => [{ provider: "anthropic", cause: "invalid_grant", email: "a@b.c" }],
      availableModels: () => [{ provider: "anthropic", id: "claude-sonnet-4" }],
      providerIds: () => ["anthropic"],
    },
  });
  const snapshot = await collectModelsHealth(d.value);
  assert.equal(snapshot.providers.anthropic.state, "disabled");
  assert.equal(snapshot.providers.anthropic.cause, "invalid_grant");
  assert.equal(snapshot.providers.anthropic.account, "a@b.c");
  assert.deepEqual(snapshot.modelHealth["anthropic/claude-sonnet-4"], { state: "disabled", cause: "invalid_grant" });
  assert.equal(snapshot.availableModelCount, 1);
  assert.equal(snapshot.disabledModelCount, 1);

  // A deps source that hands back raw rows still respects disabled_cause.
  const raw = await collectModelsHealth({
    ...d.value,
    listCredentials: () => [
      { provider: "anthropic", credential: { type: "api_key", key: "x" }, disabledCause: "invalid_grant" },
    ],
    listDisabled: async () => [],
  });
  assert.equal(raw.providers.anthropic.state, "disabled");
});

test("a stored OAuth token inside the expiry window reports expiring + expiresAt", async () => {
  const d = deps({
    value: {
      listCredentials: () => [
        { provider: "openai-codex", credential: oauthCredential(NOW + 60 * 60 * 1000, { email: "dev@x.y" }), disabledCause: null },
      ],
      availableModels: () => [{ provider: "openai-codex", id: "gpt-5" }],
      providerIds: () => ["openai-codex"],
    },
  });
  const snapshot = await collectModelsHealth(d.value);
  assert.equal(snapshot.providers["openai-codex"].state, "expiring");
  assert.equal(snapshot.providers["openai-codex"].expiresAt, NOW + 60 * 60 * 1000);
  assert.equal(snapshot.providers["openai-codex"].account, "dev@x.y");
  // A live token is still usable: the model itself is not flagged.
  assert.deepEqual(snapshot.modelHealth["openai-codex/gpt-5"], { state: "ok" });
  assert.equal(snapshot.disabledModelCount, 0);
});

test("a token outside the window, a keyless endpoint and an env key are all ok", async () => {
  const d = deps({
    value: {
      listCredentials: () => [
        { provider: "anthropic", credential: oauthCredential(NOW + 30 * DAY), disabledCause: null },
      ],
      availableModels: () => [
        { provider: "anthropic", id: "claude-sonnet-4" },
        { provider: "vllm-local", id: "qwen" },
        { provider: "zhipu", id: "glm-5" },
      ],
      providerIds: () => ["anthropic", "vllm-local", "zhipu", "openrouter"],
      keyless: (provider) => provider === "vllm-local",
      hasConcreteSource: (provider) => provider === "zhipu",
    },
  });
  const snapshot = await collectModelsHealth(d.value);
  assert.equal(snapshot.providers.anthropic.state, "ok");
  assert.equal(snapshot.providers["vllm-local"].state, "ok");
  assert.equal(snapshot.providers.zhipu.state, "ok");
  // Catalog provider with neither credentials nor a key source.
  assert.equal(snapshot.providers.openrouter.state, "missing");
  // A provider with no entry at all is unverified, never red.
  assert.deepEqual(modelHealthForProvider(undefined), { state: "unverified" });
  assert.deepEqual(modelHealthForProvider(snapshot.providers.openrouter), {
    state: "unverified",
    cause: "No credentials configured",
  });
});

// ── T4 cache invalidation on state change ────────────────────────────────────

test("a changed provider signature invalidates the models cache once", async () => {
  const d = deps({
    value: {
      listCredentials: () => [{ provider: "anthropic", credential: { type: "api_key", key: "x" }, disabledCause: null }],
      availableModels: () => [{ provider: "anthropic", id: "claude-sonnet-4" }],
      providerIds: () => ["anthropic"],
    },
  });
  const first = await collectModelsHealth(d.value);
  const stable = modelsHealthSignature(first);
  assert.equal(d.state.invalidated, 0, "collect must not invalidate; the poller decides");

  const disabled = await collectModelsHealth({
    ...d.value,
    listCredentials: () => [],
    listDisabled: async () => [{ provider: "anthropic", cause: "invalid_grant" }],
  });
  assert.notEqual(modelsHealthSignature(disabled), stable);
  assert.equal(modelsHealthSignature(disabled).includes("anthropic=disabled:invalid_grant"), true);
});

test("refreshModelsFreshness reloads credentials then asks the registry about staleness", async () => {
  const calls = [];
  const changed = await refreshModelsFreshness({
    authStorage: { credentials: { reload: async () => calls.push("reload") } },
    modelRegistry: { refreshIfStale: async () => (calls.push("refreshIfStale"), true) },
  });
  assert.deepEqual(calls, ["reload", "refreshIfStale"]);
  assert.equal(changed, true);
});

// ── T5 real SDK pool: external sqlite write is visible on the next scan ──────

test("an external disabled_cause in agent.db surfaces on the next scan (hermetic HOME)", async () => {
  const { discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
  const agentDir = join(base, "agent");
  const authStorage = await discoverAuthStorage(agentDir);
  try {
    await authStorage.credentials.set("anthropic", { type: "api_key", key: "sk-ant-hermetic" });
    const rows = authStorage.credentials.list("anthropic");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].disabledCause, null);

    const realDeps = (models) => ({
      reloadCredentials: () => authStorage.credentials.reload(),
      refreshRegistry: async () => false,
      listCredentials: () =>
        authStorage.credentials.list().map((row) => ({
          provider: row.provider,
          credential: row.credential,
          disabledCause: row.disabledCause,
        })),
      listDisabled: async () =>
        (await authStorage.credentials.listDisabled()).map((row) => ({
          provider: row.provider,
          cause: row.cause,
          ...(row.email ? { email: row.email } : {}),
          ...(row.accountId ? { accountId: row.accountId } : {}),
        })),
      hasConcreteSource: () => false,
      keyless: () => false,
      availableModels: () => models,
      providerIds: () => ["anthropic"],
      invalidateModelsCache: () => {},
    });

    const models = [{ provider: "anthropic", id: "claude-sonnet-4" }];
    const before = await collectModelsHealth(realDeps(models));
    assert.equal(before.providers.anthropic.state, "ok");
    assert.deepEqual(before.modelHealth["anthropic/claude-sonnet-4"], { state: "ok" });

    // Another process (the CLI, a failed OAuth refresh) disables the row.
    const dbFile = readdirSync(agentDir).find((name) => name.endsWith(".db"));
    assert.ok(dbFile, "agent dir must contain the credential database");
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(agentDir, dbFile));
    db.run("UPDATE auth_credentials SET disabled_cause = ? WHERE provider = ? AND disabled_cause IS NULL", [
      "invalid_grant",
      "anthropic",
    ]);
    db.close();

    const afterScan = await collectModelsHealth(realDeps(models));
    assert.equal(afterScan.providers.anthropic.state, "disabled");
    assert.equal(afterScan.providers.anthropic.cause, "invalid_grant");
    assert.deepEqual(afterScan.modelHealth["anthropic/claude-sonnet-4"], {
      state: "disabled",
      cause: "invalid_grant",
    });
    assert.equal(afterScan.disabledModelCount, 1);
    // The in-process snapshot the route reads is the reloaded one, not boot state.
    assert.equal(authStorage.credentials.list("anthropic").length, 0);
  } finally {
    authStorage.close();
  }
});