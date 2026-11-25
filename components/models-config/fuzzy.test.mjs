import assert from "node:assert/strict";
import test from "node:test";

import { fuzzyMatch, highlightSegments } from "./fuzzy.ts";

test("a subsequence query matches a model it is not a substring of (q4m)", () => {
  const match = fuzzyMatch("bailian-token-plan/qwen4-max-preview", "q4m");

  assert.equal(match.hit, true);
  assert.deepEqual(match.indices, [19, 23, 25]);
});

test("a substring match outranks a subsequence match", () => {
  const substring = fuzzyMatch("openai/gpt-4o-mini", "gpt-4o");
  const subsequence = fuzzyMatch("openai/gpt-4o-mini", "g4o");

  assert.equal(substring.score > subsequence.score, true);
});

test("an earlier substring scores higher than a later one", () => {
  const early = fuzzyMatch("glm-5.3", "glm");
  const late = fuzzyMatch("zhipu/glm-5.3", "glm");

  assert.equal(early.score > late.score, true);
});

test("a query with no matching characters misses", () => {
  assert.deepEqual(fuzzyMatch("anthropic/claude-opus-5", "zzz"), { hit: false, score: 0, indices: [] });
});

test("an empty query matches everything with no highlights", () => {
  assert.deepEqual(fuzzyMatch("anything", ""), { hit: true, score: 0, indices: [] });
});

test("highlight segments mark exactly the matched offsets", () => {
  assert.deepEqual(highlightSegments("qwen4-max", [0, 1, 2, 3]), [
    { text: "qwen", marked: true },
    { text: "4-max", marked: false },
  ]);
  assert.deepEqual(highlightSegments("qwen4-max", []), [{ text: "qwen4-max", marked: false }]);
});