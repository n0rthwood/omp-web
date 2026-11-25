import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const subject = await jiti.import("./models-config-sync.ts");

const { SYNC_SCHEMA_VERSION, SyncValidationError, applyDeclarationLayer, exportDeclarationLayer, parseSyncRequest } = subject;

const OAUTH_IDS = ["anthropic", "openai-codex", "xai-oauth"];

function fixture(t, { models, config, env = [], envFile, loggedIn = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omp141-sync-"));
  if (models !== undefined) writeFileSync(join(dir, "models.yml"), models);
  if (config !== undefined) writeFileSync(join(dir, "config.yml"), config);
  if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile);
  const logged = new Set(loggedIn);
  const deps = {
    agentDir: dir,
    envKeyNames: env,
    oauthProviderIds: OAUTH_IDS,
    hasOAuthCredential: (provider) => logged.has(provider),
    now: () => new Date("2026-11-25T12:00:00.000Z"),
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, deps };
}

function payload(overrides = {}) {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    exportedAt: "2026-11-25T11:00:00.000Z",
    sourceMachine: "gateway",
    providers: {},
    roles: {},
    enabledModels: [],
    fallbackChains: {},
    excludedOAuthProviders: [],
    ...overrides,
  };
}

function parse(body, sections = ["providers", "roles", "enabledModels"], extra = {}) {
  return parseSyncRequest({ payload: body, sections, ...extra });
}

test("export carries the declaration layer and withholds every OAuth provider block", (t) => {
  const { deps } = fixture(t, {
    models: [
      "providers:",
      "  anthropic:",
      "    baseUrl: https://oauth.example",
      "    models:",
      "      - id: claude-opus-5",
      "  openai-codex:",
      "    baseUrl: https://chatgpt.example",
      "  zhipu-coding-plan:",
      "    apiKey: ZHIPU_API_KEY",
      "    models:",
      "      - id: glm-5.3",
      "  joyai:",
      "    apiKey: JOYAI_API_KEY",
      "",
    ].join("\n"),
    config: [
      "modelRoles:",
      "  default: zhipu-coding-plan/glm-5.3",
      "  slow: anthropic/claude-opus-5",
      "enabledModels:",
      "  - zhipu-coding-plan/*",
      "  - anthropic/claude-opus-5*",
      "retry:",
      "  fallbackChains:",
      "    default:",
      "      - zhipu-coding-plan/glm-5.3",
      "",
    ].join("\n"),
    env: ["ZHIPU_API_KEY", "JOYAI_API_KEY"],
  });

  const exported = exportDeclarationLayer(deps);

  assert.equal(exported.schemaVersion, SYNC_SCHEMA_VERSION);
  assert.equal(exported.sourceMachine, process.env.OMP_WEB_MACHINE_NAME?.trim() || hostname());
  assert.deepEqual(Object.keys(exported.providers).sort(), ["joyai", "zhipu-coding-plan"]);
  assert.deepEqual(exported.excludedOAuthProviders, ["anthropic", "openai-codex"]);
  assert.deepEqual(exported.roles, {
    default: "zhipu-coding-plan/glm-5.3",
    slow: "anthropic/claude-opus-5",
  });
  assert.deepEqual(exported.enabledModels, ["zhipu-coding-plan/*", "anthropic/claude-opus-5*"]);
  assert.deepEqual(exported.fallbackChains, { default: ["zhipu-coding-plan/glm-5.3"] });
});

test("export payload contains no credential value, only env-var names and presence", (t) => {
  const secret = "sk-live-DO-NOT-LEAK-9f3a";
  const { dir, deps } = fixture(t, {
    models: [
      "providers:",
      "  zhipu-coding-plan:",
      "    apiKey: ZHIPU_API_KEY",
      "    headers:",
      "      X-Api-Key: ${secret}",
      "    models:",
      "      - id: glm-5.3",
      "",
    ].join("\n"),
    envFile: `ZHIPU_API_KEY=${secret}\nOTHER_KEY=other-value\n`,
  });

  const exported = exportDeclarationLayer(deps);
  const serialized = JSON.stringify(exported);

  assert.ok(!serialized.includes(secret), "credential value must never appear in the payload");
  assert.ok(!serialized.includes("other-value"), "the .env value never reaches the payload");
  assert.ok(serialized.includes("ZHIPU_API_KEY"), "bare env-var name is safe to sync");
  const fromEnvFile = subject.readEnvKeyNames(dir);
  assert.ok(fromEnvFile.includes("ZHIPU_API_KEY"), "presence is read from .env key names");
  assert.ok(fromEnvFile.includes("OTHER_KEY"));
  assert.ok(existsSync(join(dir, "models.yml")));
});

test("apply is idempotent: a second identical apply diffs empty and writes nothing", (t) => {
  const { dir, deps } = fixture(t, { models: "providers: {}\n", config: "modelRoles: {}\n" });
  const body = payload({
    providers: { "zhipu-coding-plan": { apiKey: "ZHIPU_API_KEY", models: [{ id: "glm-5.3" }] } },
    roles: { default: "zhipu-coding-plan/glm-5.3" },
    enabledModels: ["zhipu-coding-plan/*"],
    fallbackChains: { default: ["zhipu-coding-plan/glm-5.3"] },
  });

  const first = applyDeclarationLayer(parse(body), deps);
  assert.equal(first.dryRun, false);
  assert.equal(first.changed, true);
  assert.deepEqual(first.applied.providers.added, ["zhipu-coding-plan"]);
  assert.ok(first.backupPaths.length > 0, "a backup is written before the first change");

  const modelsAfterFirst = readFileSync(join(dir, "models.yml"), "utf8");
  const configAfterFirst = readFileSync(join(dir, "config.yml"), "utf8");

  const second = applyDeclarationLayer(parse(body), deps);
  assert.equal(second.changed, false, "same payload twice must be a no-op");
  assert.deepEqual(second.applied.providers.added, []);
  assert.deepEqual(second.applied.providers.updated, []);
  assert.deepEqual(second.applied.roles.added, []);
  assert.deepEqual(second.applied.enabledModels.added, []);
  assert.deepEqual(second.backupPaths, [], "no backup when nothing changes");
  assert.equal(readFileSync(join(dir, "models.yml"), "utf8"), modelsAfterFirst);
  assert.equal(readFileSync(join(dir, "config.yml"), "utf8"), configAfterFirst);
});

test("apply preserves remote-only providers and backs up both files before writing", (t) => {
  const { dir, deps } = fixture(t, {
    models: [
      "providers:",
      "  remote-only:",
      "    apiKey: REMOTE_KEY",
      "    models:",
      "      - id: remote-model",
      "",
    ].join("\n"),
    config: "modelRoles:\n  default: remote-only/remote-model\n",
  });

  const result = applyDeclarationLayer(
    parse(payload({
      providers: { "zhipu-coding-plan": { apiKey: "ZHIPU_API_KEY" } },
      roles: { default: "zhipu-coding-plan/glm-5.3" },
    })),
    deps,
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.applied.providers.added, ["zhipu-coding-plan"]);
  const models = readFileSync(join(dir, "models.yml"), "utf8");
  assert.ok(models.includes("remote-only"), "remote-only provider survives an additive merge");
  assert.ok(models.includes("zhipu-coding-plan"));

  const backups = readdirSync(dir).filter((name) => name.includes(".bak.sync-"));
  assert.equal(backups.length, 2, "models.yml + config.yml each get one backup");
  assert.ok(backups.every((name) => name.endsWith("2026-11-25T12-00-00-000Z")));
  assert.deepEqual(result.backupPaths.sort(), backups.map((name) => join(dir, name)).sort());
});

test("prune removes remote-only providers while roles are replaced wholesale", (t) => {
  const { deps } = fixture(t, {
    models: "providers:\n  remote-only:\n    apiKey: REMOTE_KEY\n",
    config: "modelRoles:\n  default: remote-only/x\n  task: remote-only/y\n",
  });

  const result = applyDeclarationLayer(
    parse(payload({ providers: { joyai: { apiKey: "JOYAI_API_KEY" } }, roles: { default: "joyai/glm-5.3" } }), ["providers", "roles"], { prune: true }),
    deps,
  );

  assert.deepEqual(result.applied.providers.removed, ["remote-only"]);
  assert.deepEqual(result.applied.roles.removed, ["task"]);
  assert.deepEqual(result.applied.roles.updated, ["default"], "same role, new selector is an update");
});

test("dryRun returns the diff and preflight warnings without touching the disk", (t) => {
  const { dir, deps } = fixture(t, {
    models: "providers: {}\n",
    config: "modelRoles: {}\n",
    env: ["JOYAI_API_KEY"],
  });
  const before = {
    models: readFileSync(join(dir, "models.yml"), "utf8"),
    config: readFileSync(join(dir, "config.yml"), "utf8"),
  };

  const dry = applyDeclarationLayer(
    parse(payload({
      providers: { "zhipu-coding-plan": { apiKey: "ZHIPU_API_KEY" } },
      roles: { slow: "anthropic/claude-opus-5" },
      enabledModels: ["anthropic/claude-opus-5*"],
    }), ["providers", "roles", "enabledModels"], { dryRun: true }),
    deps,
  );

  assert.equal(dry.dryRun, true);
  assert.equal(dry.changed, true);
  assert.deepEqual(dry.applied.providers.added, ["zhipu-coding-plan"]);
  assert.deepEqual(dry.backupPaths, []);
  assert.ok(dry.warnings.includes("ZHIPU_API_KEY missing — provider zhipu-coding-plan will sync but run degraded"));
  assert.ok(dry.warnings.some((warning) => warning.startsWith("anthropic not logged in")));
  assert.equal(readFileSync(join(dir, "models.yml"), "utf8"), before.models, "dryRun must not write models.yml");
  assert.equal(readFileSync(join(dir, "config.yml"), "utf8"), before.config, "dryRun must not write config.yml");
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".bak.sync-")), []);
});

test("preflight reports an OAuth provider as ready when the target holds a credential", (t) => {
  const { deps } = fixture(t, { models: "providers: {}\n", config: "modelRoles: {}\n", loggedIn: ["anthropic"] });
  const dry = applyDeclarationLayer(
    parse(payload({ roles: { slow: "anthropic/claude-opus-5" } }), ["roles"], { dryRun: true }),
    deps,
  );
  assert.deepEqual(dry.warnings, []);
  assert.deepEqual(dry.issues, []);
});

test("preflight findings are structured, and the English lines keep their order (issue #145)", (t) => {
  const { deps } = fixture(t, {
    models: "providers: {}\n",
    config: "modelRoles: {}\n",
    env: ["JOYAI_API_KEY"],
  });
  const dry = applyDeclarationLayer(
    parse(payload({
      providers: {
        joyai: { apiKey: "JOYAI_API_KEY" },
        "zhipu-coding-plan": { apiKey: "ZHIPU_API_KEY" },
      },
      roles: { slow: "anthropic/claude-opus-5", task: "openai-codex/gpt-6" },
    }), ["providers", "roles"], { dryRun: true }),
    deps,
  );
  // A key the target holds is not a finding.
  assert.deepEqual(dry.issues, [
    { kind: "missing_key", provider: "zhipu-coding-plan", envVar: "ZHIPU_API_KEY" },
    { kind: "not_logged_in", provider: "anthropic" },
    { kind: "not_logged_in", provider: "openai-codex" },
  ]);
  assert.deepEqual(dry.warnings, [
    "ZHIPU_API_KEY missing — provider zhipu-coding-plan will sync but run degraded",
    "anthropic not logged in — roles/allow-list entries fall back through retry.fallbackChains",
    "openai-codex not logged in — roles/allow-list entries fall back through retry.fallbackChains",
  ]);
});

test("schema and section validation reject bad requests before any write", (t) => {
  const { dir } = fixture(t, { models: "providers: {}\n", config: "modelRoles: {}\n" });
  const before = readFileSync(join(dir, "models.yml"), "utf8");

  assert.throws(() => parse(payload({ schemaVersion: 99 })), SyncValidationError);
  assert.throws(() => parse(payload(), []), SyncValidationError);
  assert.throws(() => parse(payload(), ["nope"]), SyncValidationError);
  assert.throws(() => parse(payload({ roles: { default: 7 } })), SyncValidationError);
  assert.throws(() => parse(payload({ enabledModels: [1] })), SyncValidationError);
  assert.throws(() => parse(payload(), ["providers"], { dryRun: "yes" }), SyncValidationError);
  assert.throws(() => parseSyncRequest({ payload: null, sections: ["providers"] }), SyncValidationError);
  assert.equal(readFileSync(join(dir, "models.yml"), "utf8"), before);
});

test("a config.yml with no retry block gains one only for the roles section", (t) => {
  const { dir, deps } = fixture(t, { models: "providers: {}\n", config: "modelRoles:\n  default: a/b\n" });
  applyDeclarationLayer(parse(payload({ roles: { default: "joyai/glm-5.3" } }), ["roles"]), deps);
  const config = readFileSync(join(dir, "config.yml"), "utf8");
  assert.ok(config.includes("fallbackChains: {}"), "an empty chain map is written explicitly");
  assert.ok(config.includes("default: joyai/glm-5.3"));
});

test("a section already in sync does not mask a change in a later section", (t) => {
  const { dir, deps } = fixture(t, {
    models: "providers:\n  zhipu-coding-plan:\n    apiKey: ZHIPU_API_KEY\n",
    config: "modelRoles:\n  default: joyai/glm-5.3\n",
  });
  const body = payload({
    providers: { "zhipu-coding-plan": { apiKey: "ZHIPU_API_KEY" } },
    roles: { default: "zhipu-coding-plan/glm-5.3" },
  });

  const result = applyDeclarationLayer(parse(body, ["providers", "roles"]), deps);

  assert.deepEqual(result.applied.providers.added, [], "providers are already in sync");
  assert.deepEqual(result.applied.providers.unchanged, ["zhipu-coding-plan"]);
  assert.deepEqual(result.applied.roles.updated, ["default"]);
  assert.equal(result.changed, true, "the roles change must still be written");
  assert.ok(result.backupPaths.length > 0, "the write is backed up");
  assert.ok(readFileSync(join(dir, "config.yml"), "utf8").includes("default: zhipu-coding-plan/glm-5.3"));
});

test("a real apply invalidates the omp runtime and model cache; dryRun does not", (t) => {
  const { deps } = fixture(t, { models: "providers: {}\n", config: "modelRoles: {}\n" });
  const body = payload({ providers: { joyai: { apiKey: "JOYAI_API_KEY" } } });
  const sentinel = Promise.resolve({});

  globalThis.__ompRuntimePromise = sentinel;
  globalThis.__ompModelsCacheState = { entries: new Map([["x", { data: {}, expiresAt: 1 }]]), inFlight: new Map(), generation: 0 };
  applyDeclarationLayer(parse(body, ["providers"], { dryRun: true }), deps);
  assert.strictEqual(globalThis.__ompRuntimePromise, sentinel, "dryRun must not drop the runtime");
  assert.equal(globalThis.__ompModelsCacheState.entries.size, 1, "dryRun must not clear the model cache");

  globalThis.__ompRuntimePromise = sentinel;
  globalThis.__ompModelsCacheState = { entries: new Map([["x", { data: {}, expiresAt: 1 }]]), inFlight: new Map(), generation: 0 };
  applyDeclarationLayer(parse(body, ["providers"]), deps);
  assert.equal(globalThis.__ompRuntimePromise, undefined, "a real write drops the cached runtime");
  assert.equal(globalThis.__ompModelsCacheState.entries.size, 0, "a real write clears the model cache");
  t.after(() => {
    globalThis.__ompRuntimePromise = undefined;
    globalThis.__ompModelsCacheState = undefined;
  });
});