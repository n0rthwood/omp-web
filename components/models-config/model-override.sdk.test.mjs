// SDK contract behind components/models-config/model-override.ts (#144):
// what this panel writes into models.yml must load in the real registry and
// change exactly the edited field. Every other shape an edit could take fails
// validation for the WHOLE file, which drops every models.yml provider.
// Individually runnable: bun test components/models-config/model-override.sdk.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";

// Hermetic agent dir BEFORE any SDK import: the registry defaults to ~/.omp/agent.
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const base = mkdtempSync(join(tmpdir(), "omp144-override-sdk-"));
setAgentDir(join(base, "agent"));

const { AuthStorage, ModelRegistry } = await import("@oh-my-pi/pi-coding-agent");
const { changedModelFields, toModelDefinition, withModelOverride } = await import("./model-override.ts");

const authStorage = await AuthStorage.create(join(base, "auth.db"));

test.after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
/** Load `config` exactly as PUT /api/models-config writes it. */
function load(config) {
  const modelsPath = join(base, `models-${counter++}.yml`);
  writeFileSync(modelsPath, stringify(config, { lineWidth: 0 }));
  const registry = new ModelRegistry(authStorage, modelsPath);
  return {
    error: registry.getError()?.message,
    row: (provider, id) => registry.getAll().find((model) => model.provider === provider && model.id === id),
  };
}

const claude = { provider: "anthropic", id: "claude-3-5-sonnet-20240620" };
const pristine = load({});
const catalog = pristine.row(claude.provider, claude.id);
// The fact sheet the provider table shows for that row, as the API now sends it.
const seed = {
  id: catalog.id,
  name: catalog.name,
  input: catalog.input,
  contextWindow: catalog.contextWindow,
  maxTokens: catalog.maxTokens,
  cost: { input: catalog.cost.input, output: catalog.cost.output, cacheRead: catalog.cost.cacheRead, cacheWrite: catalog.cost.cacheWrite },
};

test("editing a catalog row lands as a modelOverrides patch the SDK accepts and applies", () => {
  assert.equal(pristine.error, undefined);
  const changed = changedModelFields(seed, { ...seed, maxTokens: 64000, input: ["text"], cost: { ...seed.cost, output: 99 } });
  assert.deepEqual(changed, { input: ["text"], maxTokens: 64000, cost: { output: 99 } });

  const saved = load(withModelOverride({ providers: {} }, claude.provider, claude.id, changed));
  assert.equal(saved.error, undefined);
  const row = saved.row(claude.provider, claude.id);
  assert.equal(row.maxTokens, 64000);
  assert.deepEqual(row.input, ["text"]);
  assert.equal(row.cost.output, 99);
  // Everything the edit did not name still follows the catalog.
  assert.equal(row.name, catalog.name);
  assert.equal(row.contextWindow, catalog.contextWindow);
  assert.equal(row.cost.input, catalog.cost.input);
  assert.equal(row.cost.cacheRead, catalog.cost.cacheRead);
  assert.equal(row.baseUrl, catalog.baseUrl);
});

test("clearing the last override leaves no empty block the schema would reject", () => {
  const edited = withModelOverride({ providers: {} }, claude.provider, claude.id, { maxTokens: 64000 });
  const cleared = withModelOverride(edited, claude.provider, claude.id, { maxTokens: undefined });
  assert.deepEqual(cleared, { providers: {} });
  const reloaded = load(cleared);
  assert.equal(reloaded.error, undefined);
  assert.equal(reloaded.row(claude.provider, claude.id).maxTokens, catalog.maxTokens);
});

test("a same-id models[] entry is NOT a valid way to override a catalog row", () => {
  // This is the shape a naive "save the row" would have produced.
  const naive = load({ providers: { anthropic: { models: [{ id: claude.id, input: ["text"] }] } } });
  assert.match(naive.error, /"baseUrl" is required when defining custom models/);
});

test("a definition this panel appends loads; the partial cost it was normalized from does not", () => {
  const host = { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", apiKey: "k", api: "openai-completions" };
  const drafted = { id: "glm-custom", name: "  GLM Custom ", contextWindow: 128000, cost: { input: 1 } };
  const ok = load({ providers: { "zhipu-coding-plan": { ...host, models: [toModelDefinition(drafted)] } } });
  assert.equal(ok.error, undefined);
  assert.equal(ok.row("zhipu-coding-plan", "glm-custom").name, "GLM Custom");
  assert.deepEqual(ok.row("zhipu-coding-plan", "glm-custom").cost, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });

  const partial = load({ providers: { "zhipu-coding-plan": { ...host, models: [drafted] } } });
  assert.match(partial.error, /cost\.output: must be a number/);
});
