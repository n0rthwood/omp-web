import assert from "node:assert/strict";
import test from "node:test";

import { diffProviderModels, hasModelDiff } from "./models-config-diff.ts";

const model = (id, overrides = {}) => ({ id, name: id, ...overrides });

test("reports added and removed models with display names", () => {
  const diff = diffProviderModels(
    [model("gpt-5.9-preview"), model("gpt-6.1-sol")],
    [model("gpt-6.1-sol"), model("gpt-6.2-astra", { name: "GPT-6.2 Astra" })],
  );

  assert.deepEqual(diff.added, [{ id: "gpt-6.2-astra", name: "GPT-6.2 Astra" }]);
  assert.deepEqual(diff.removed, [{ id: "gpt-5.9-preview", name: "gpt-5.9-preview" }]);
  assert.deepEqual(diff.changed, []);
  assert.equal(hasModelDiff(diff), true);
});

test("reports only the fields that changed, before → after", () => {
  const diff = diffProviderModels(
    [model("m", { contextWindow: 272_000, maxTokens: 8192, input: ["text"] })],
    [model("m", { contextWindow: 400_000, maxTokens: 8192, input: ["text", "image"] })],
  );

  assert.deepEqual(diff.changed, [{
    id: "m",
    fields: [
      { field: "contextWindow", before: 272_000, after: 400_000 },
      { field: "input", before: ["text"], after: ["text", "image"] },
    ],
  }]);
});

test("an unchanged provider produces an empty diff", () => {
  const before = [model("m", { contextWindow: 1000, cost: { input: 1, output: 2 } })];
  const after = [model("m", { contextWindow: 1000, cost: { output: 2, input: 1 } })];

  assert.deepEqual(diffProviderModels(before, after), { added: [], removed: [], changed: [] });
  assert.equal(hasModelDiff({ added: [], removed: [], changed: [] }), false);
});

test("a model that disappears is a removal, not a change", () => {
  const diff = diffProviderModels([model("gone")], []);

  assert.deepEqual(diff.removed, [{ id: "gone", name: "gone" }]);
  assert.deepEqual(diff.changed, []);
});