// Guards the one default ProviderConfigForm writes on its own (#144).
// Individually runnable: bun test components/models-config/ProviderConfigForm.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ProviderConfigForm.tsx", import.meta.url), "utf8");

test("only a block that declares an endpoint is given the default API", () => {
  // The form mounts for every models.yml provider block, including a block that
  // holds nothing but `modelOverrides`. Defaulting `api` there wrote an
  // unrequested `api: openai-completions` onto a catalog provider (anthropic is
  // `anthropic-messages`), so the default must stay behind `baseUrl`.
  assert.match(source, /if \(!provider\.api && provider\.baseUrl\) onChange\(\{ \.\.\.provider, api: "openai-completions" \}\);/);
  assert.doesNotMatch(source, /if \(!provider\.api\) onChange\(/);
});
