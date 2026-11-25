// Guards the models.yml write paths behind the provider model table (#144):
// catalog-row edits land in `modelOverrides` as sparse patches, `models[]`
// definitions are normalized to what the SDK schema accepts.
// Individually runnable: bun test components/models-config/model-override.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { changedModelFields, toModelDefinition, withModelOverride } from "./model-override.ts";

const catalogRow = {
  id: "claude-sonnet",
  name: "Claude Sonnet",
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 8192,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

test("only the edited field is reported, so the rest keeps following the catalog", () => {
  const changed = changedModelFields(catalogRow, { ...catalogRow, maxTokens: 64000 });
  assert.deepEqual(changed, { maxTokens: 64000 });

  assert.deepEqual(changedModelFields(catalogRow, catalogRow), {});
  assert.deepEqual(changedModelFields(catalogRow, { ...catalogRow, input: ["text"] }), { input: ["text"] });
});

test("cost reports just the changed rate and a blank name is a cleared one", () => {
  assert.deepEqual(changedModelFields(catalogRow, { ...catalogRow, cost: { ...catalogRow.cost, output: 99 } }), { cost: { output: 99 } });
  assert.deepEqual(changedModelFields(catalogRow, { ...catalogRow, name: "  " }), { name: undefined });
});

test("editing a catalog row creates the provider's modelOverrides block", () => {
  const next = withModelOverride({ providers: { joyai: { baseUrl: "http://x" } } }, "anthropic", "claude-sonnet", { maxTokens: 64000 });
  assert.deepEqual(next.providers.anthropic, { modelOverrides: { "claude-sonnet": { maxTokens: 64000 } } });
  // Siblings are untouched.
  assert.deepEqual(next.providers.joyai, { baseUrl: "http://x" });
});

test("a later edit folds into the existing patch and keeps fields the panel does not edit", () => {
  const config = { providers: { anthropic: { modelOverrides: { "claude-sonnet": { maxTokens: 64000, promptCache: { short: 300 } } } } } };
  const next = withModelOverride(config, "anthropic", "claude-sonnet", { input: ["text"] });
  assert.deepEqual(next.providers.anthropic.modelOverrides["claude-sonnet"], { maxTokens: 64000, promptCache: { short: 300 }, input: ["text"] });
  assert.deepEqual(config.providers.anthropic.modelOverrides["claude-sonnet"], { maxTokens: 64000, promptCache: { short: 300 } }, "input config is not mutated");
});

test("clearing a field lifts its override; untouched keys of the patch survive", () => {
  const config = { providers: { anthropic: { modelOverrides: { "claude-sonnet": { maxTokens: 64000, name: "Renamed" } } } } };
  const next = withModelOverride(config, "anthropic", "claude-sonnet", { maxTokens: undefined });
  assert.deepEqual(next.providers.anthropic.modelOverrides["claude-sonnet"], { name: "Renamed" });
});

test("the last patch takes its containers with it — an empty map or block fails the whole file", () => {
  const onlyPatch = { providers: { anthropic: { modelOverrides: { "claude-sonnet": { maxTokens: 64000 } } } } };
  assert.deepEqual(withModelOverride(onlyPatch, "anthropic", "claude-sonnet", { maxTokens: undefined }), { providers: {} });

  const withBaseUrl = { providers: { anthropic: { baseUrl: "https://api.anthropic.com", modelOverrides: { "claude-sonnet": { maxTokens: 64000 } } } } };
  assert.deepEqual(
    withModelOverride(withBaseUrl, "anthropic", "claude-sonnet", { maxTokens: undefined }).providers.anthropic,
    { baseUrl: "https://api.anthropic.com" },
  );
});

test("an empty change is a no-op that returns the same config object", () => {
  const config = { providers: {} };
  assert.equal(withModelOverride(config, "anthropic", "claude-sonnet", {}), config);
});

test("a models[] definition gets a complete cost or none, and never a blank name", () => {
  assert.deepEqual(toModelDefinition({ id: "m", name: "  ", cost: { input: 1 } }), { id: "m", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(toModelDefinition({ id: "m", cost: { cacheRead: 0.1 }, thinkingLevelMap: { low: "low" } }), { id: "m", thinkingLevelMap: { low: "low" } });
  assert.deepEqual(toModelDefinition({ id: "m", name: " Model " }), { id: "m", name: "Model" });
});
