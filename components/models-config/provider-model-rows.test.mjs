// Guards the provider table's row merge (#144): untrimmed registry rows plus
// the panel's own models.yml state.
// Individually runnable: bun test components/models-config/provider-model-rows.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderModelRows } from "./provider-model-rows.ts";

const registry = [
  { id: "claude-opus", name: "Claude Opus", provider: "anthropic", input: ["text", "image"], reasoning: true, cost: { input: 15, output: 75 }, contextWindow: 200000, maxTokens: 32000 },
  { id: "claude-haiku", name: "Claude Haiku", provider: "anthropic", input: ["text"], reasoning: false, cost: { input: 1, output: 5 }, contextWindow: 200000, maxTokens: 8192 },
  { id: "glm-5.3", name: "GLM", provider: "zhipu-coding-plan" },
];
const levels = { "anthropic:claude-opus": ["low", "medium", "high"] };

test("rows are the provider's full registry list with its catalog facts and efforts", () => {
  const rows = buildProviderModelRows({ id: "anthropic" }, registry, levels);
  assert.deepEqual(rows.map((row) => row.id), ["claude-haiku", "claude-opus"]);
  const opus = rows[1];
  assert.equal(opus.source, "catalog");
  assert.equal(opus.configIndex, null);
  assert.deepEqual(opus.entry, {
    id: "claude-opus", name: "Claude Opus", input: ["text", "image"], reasoning: true,
    cost: { input: 15, output: 75 }, contextWindow: 200000, maxTokens: 32000,
  });
  assert.deepEqual(opus.efforts, ["low", "medium", "high"]);
  // A model without a thinking surface reports no efforts rather than an empty list.
  assert.equal("efforts" in rows[0], false);
});

test("a models[] definition owns its row: merged when the registry also serves it, config otherwise", () => {
  const rows = buildProviderModelRows(
    { id: "anthropic", config: { models: [{ id: "claude-opus", contextWindow: 1000 }, { id: "claude-custom" }] } },
    registry,
    levels,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get("claude-opus").source, "merged");
  assert.equal(byId.get("claude-opus").configIndex, 0);
  assert.deepEqual(byId.get("claude-opus").entry, { id: "claude-opus", contextWindow: 1000 });
  assert.equal(byId.get("claude-custom").source, "config");
  assert.equal(byId.get("claude-custom").configIndex, 1);
  assert.equal(byId.get("claude-haiku").configIndex, null);
});

test("a modelOverrides patch marks its catalog row merged and shows the patched values", () => {
  const rows = buildProviderModelRows(
    { id: "anthropic", config: { modelOverrides: { "claude-haiku": { input: ["text", "image"], maxTokens: 64000, cost: { output: 9 } } } } },
    registry,
    levels,
  );
  const haiku = rows.find((row) => row.id === "claude-haiku");
  assert.equal(haiku.source, "merged");
  assert.equal(haiku.configIndex, null);
  assert.deepEqual(haiku.override, { input: ["text", "image"], maxTokens: 64000, cost: { output: 9 } });
  // Only the patched fields change; the rest still reads as the catalog row.
  assert.deepEqual(haiku.entry, {
    id: "claude-haiku", name: "Claude Haiku", input: ["text", "image"], reasoning: false,
    cost: { input: 1, output: 9 }, contextWindow: 200000, maxTokens: 64000,
  });
  assert.equal(rows.find((row) => row.id === "claude-opus").source, "catalog");
});

test("an override neither creates a row the registry does not serve nor beats a definition", () => {
  const rows = buildProviderModelRows(
    { id: "anthropic", config: { models: [{ id: "claude-opus", maxTokens: 1 }], modelOverrides: { "claude-opus": { maxTokens: 2 }, "claude-ghost": { maxTokens: 3 } } } },
    registry,
    levels,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.has("claude-ghost"), false);
  assert.equal(byId.get("claude-opus").entry.maxTokens, 1);
  assert.equal("override" in byId.get("claude-opus"), false);
});
