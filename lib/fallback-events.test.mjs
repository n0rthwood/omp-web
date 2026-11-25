import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fallbackApplied, fallbackSucceeded, parseModelSelector, FALLBACK_MODEL_ROLE } = await jiti.import("./fallback-events.ts");

const APPLIED = {
  type: "retry_fallback_applied",
  from: "anthropic/claude-fable-5",
  to: "zhipu-coding-plan/glm-5.3",
  role: FALLBACK_MODEL_ROLE,
  reason: "credential rejected",
};

test("parses a provider/model selector and rejects halves", () => {
  assert.deepEqual(parseModelSelector("anthropic/claude-fable-5"), { provider: "anthropic", modelId: "claude-fable-5" });
  assert.equal(parseModelSelector("anthropic"), null);
  assert.equal(parseModelSelector("/model"), null);
  assert.equal(parseModelSelector("anthropic/"), null);
});

test("retry_fallback_applied builds the degrade banner", () => {
  assert.deepEqual(fallbackApplied(APPLIED, 7), {
    from: "anthropic/claude-fable-5",
    to: "zhipu-coding-plan/glm-5.3",
    role: "fallback",
    reason: "credential rejected",
    succeeded: false,
    runId: 7,
  });
});

test("retry_fallback_applied without a target is ignored", () => {
  assert.equal(fallbackApplied({ type: "retry_fallback_applied", from: "a/b" }, 1), null);
  assert.equal(fallbackApplied({ type: "retry_fallback_applied", to: "   " }, 1), null);
});

test("a frame without a role reports the default role", () => {
  const banner = fallbackApplied({ to: "openai/gpt-x" }, 3);
  assert.equal(banner.role, "default");
  assert.equal(banner.reason, undefined);
  assert.equal(banner.from, "");
});

test("retry_fallback_succeeded upgrades the banner of the same run", () => {
  const applied = fallbackApplied(APPLIED, 7);
  const done = fallbackSucceeded({ type: "retry_fallback_succeeded", model: "zhipu-coding-plan/glm-5.3", role: "fallback" }, applied, 7);
  assert.equal(done.succeeded, true);
  assert.equal(done.to, "zhipu-coding-plan/glm-5.3");
  assert.equal(done.from, "anthropic/claude-fable-5");
  assert.equal(done.runId, 7);
});

test("a late retry_fallback_succeeded from an older run never resurrects the banner", () => {
  const applied = fallbackApplied(APPLIED, 7);
  // Same object back: React bails out, the live run's banner is untouched.
  assert.equal(fallbackSucceeded({ type: "retry_fallback_succeeded", model: "other/model", role: "fallback" }, applied, 8), applied);
});

test("retry_fallback_succeeded without a banner still reports the answering model", () => {
  const done = fallbackSucceeded({ type: "retry_fallback_succeeded", model: "zhipu-coding-plan/glm-5.3", role: "fallback" }, null, 4);
  assert.equal(done.to, "zhipu-coding-plan/glm-5.3");
  assert.equal(done.from, "");
  assert.equal(done.succeeded, true);
  assert.equal(done.runId, 4);
});

test("retry_fallback_succeeded without a model and without a banner changes nothing", () => {
  assert.equal(fallbackSucceeded({ type: "retry_fallback_succeeded" }, null, 4), null);
});