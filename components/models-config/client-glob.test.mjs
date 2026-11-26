// The overview filter's browser-safe matcher must select exactly what the
// server's Bun.Glob selects for the same `enabledModels` pattern (#154).
// Bun.Glob is used here only as the oracle; it never reaches client code.
// Individually runnable: bun test components/models-config/client-glob.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { globToRegExp } = await jiti.import("./client-glob.ts");

const selectors = [
  "anthropic/claude-opus-5", "anthropic/claude-opus-5-5", "anthropic/claude-opus-4-5", "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5-20250929", "anthropic/claude-fable-5-2", "anthropic/claude-3-5-sonnet-20241022",
  "openrouter/anthropic/claude-opus-5", "openrouter/openrouter/free", "openrouter/baidu/ernie-5.5-flash-preview:free",
  "openrouter/google/gemma-4-31b-it:free", "openrouter/openai/gpt-5", "openrouter/free",
  "openai-codex/gpt-5.6-sol", "openai-codex/gpt-6-astra", "openai-codex/gpt-6.2-sol", "openai-codex/gpt-image-2",
  "zhipu-coding-plan/glm-4.7", "zhipu-coding-plan/glm-5", "zhipu-coding-plan/glm-5.4", "zhipu-coding-plan/glm-5v-turbo",
  "zhipu-coding-plan/glm-5.2-highspeed[1m]", "zhipu-coding-plan/glm-4.6v",
  "bailian-token-plan/deepseek-v4.1-flash", "bailian-token-plan/deepseek-v4.1-flash-1017",
  "bailian-token-plan/deepseek-v4.1-flash-1030", "bailian-token-plan/deepseek-v4.1-flash-0901",
  "bailian-token-plan/qwen3.7-max", "bailian-token-plan/qwen3.8-max", "bailian-token-plan/qwen4-max", "bailian-token-plan/auto",
  "joyai/deepseek-chat", "a.b", "axb",
];

const patterns = [
  // the live enabledModels list
  "anthropic/claude-{fable,haiku,mythos,opus,sonnet}-{[5-9],[1-9][0-9]}*",
  "openai-codex/gpt-{[6-9],[1-9][0-9]}*",
  "zhipu-coding-plan/glm-{[5-9],[1-9][0-9]}*",
  "openrouter/**/*free*",
  "bailian-token-plan/deepseek-v4.1-*-{101[7-9],10[2-9]?,1[1-2]??}",
  "bailian-token-plan/qwen{3.[8-9],[4-9]}*",
  "bailian-token-plan/glm-{[5-9],[1-9][0-9]}*",
  "joyai/*",
  // syntax edges
  "*", "**", "anthropic/*", "anthropic/**", "**/free", "openrouter/**free*", "openrouter/*/free", "openrouter/*free*",
  "a?b", "a[.]b", "a[!.]b", "a[^.]b", "a\\.b", "{a,b}", "{a,{b,c}}.b", "[a-c]xb", "claude-*-[5-9]*",
  "unclosed[", "unclosed{a,b", "zhipu-coding-plan/glm-5.2-highspeed\\[1m\\]",
];

test("client glob selects exactly what Bun.Glob selects, for the live patterns and syntax edges", () => {
  for (const pattern of patterns) {
    const oracle = new Bun.Glob(pattern.toLowerCase());
    const regex = globToRegExp(pattern.toLowerCase());
    for (const selector of selectors) {
      assert.equal(
        regex.test(selector.toLowerCase()),
        oracle.match(selector.toLowerCase()),
        `${pattern} vs ${selector}`,
      );
    }
  }
});

test("an unterminated class or brace is literal instead of throwing", () => {
  assert.equal(globToRegExp("a[b").test("a[b"), true);
  assert.equal(globToRegExp("a{b,c").test("a{b,c"), true);
});
