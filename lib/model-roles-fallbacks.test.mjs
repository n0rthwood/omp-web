import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-roles.ts");
  } catch {
    return import("./model-roles.ts");
  }
}

async function loadSettings() {
  const mod = "@oh-my-pi/pi-coding-agent/config/settings";
  try {
    const { createJiti } = await import("jiti");
    return (await createJiti(import.meta.url).import(mod)).Settings;
  } catch {
    return (await import(mod)).Settings;
  }
}

const { listRoleFallbackChains, writeRoleFallbackChain } = await loadSubject();
const Settings = await loadSettings();

/**
 * `Settings.isolated` is the only safe way to exercise a write here.
 * `Settings.init` takes an options object, silently falls back to the real
 * `~/.omp/agent` when handed anything else, and returns the live global
 * singleton when one exists — so a test using it rewrites the user's config.
 * `isolated` sets `inMemory`, which nulls the config path and disables saving.
 */
function makeSettings(fallbackChains) {
  return Settings.isolated(
    {
      modelRoles: {
        default: "anthropic/claude-opus-5",
        slow: "openai-codex/gpt-5.6-terra",
        smol: "anthropic/claude-sonnet-5",
      },
      "retry.fallbackChains": fallbackChains,
    },
    { storage: null },
  );
}

const CHAINS = {
  default: ["deepseek/deepseek-v4-pro"],
  slow: ["bailian-cli/glm-5.2", "deepseek/deepseek-v4-pro"],
  "zhipu-coding-plan/glm-5.3": ["bailian-cli/glm-5.2"],
  "deepseek/*": ["bailian-cli/glm-5.2"],
};

const byRole = (list, role) => list.find((entry) => entry.role === role);

test("a role with its own chain is not reported as inherited", () => {
  const chain = byRole(listRoleFallbackChains(makeSettings(CHAINS)), "slow");
  assert.equal(chain.inherited, false);
  assert.deepEqual(chain.configured, ["bailian-cli/glm-5.2", "deepseek/deepseek-v4-pro"]);
  assert.deepEqual(chain.effective, ["bailian-cli/glm-5.2", "deepseek/deepseek-v4-pro"]);
});

test("a role with no chain inherits the default chain", () => {
  const chain = byRole(listRoleFallbackChains(makeSettings(CHAINS)), "smol");
  assert.equal(chain.inherited, true);
  assert.equal(chain.configured, undefined);
  assert.deepEqual(chain.effective, ["deepseek/deepseek-v4-pro"]);
});

test("writing one role leaves selector and wildcard keys untouched", () => {
  // The panel is role-centric but the config also carries exact-selector and
  // `provider/*` keys. Dropping them on write would delete failover routing
  // the TUI depends on and the browser never displays.
  const settings = makeSettings(CHAINS);
  writeRoleFallbackChain(settings, "smol", ["bailian-cli/qwen3.6-flash"]);
  const written = settings.get("retry.fallbackChains");
  assert.deepEqual(written["zhipu-coding-plan/glm-5.3"], ["bailian-cli/glm-5.2"]);
  assert.deepEqual(written["deepseek/*"], ["bailian-cli/glm-5.2"]);
  assert.deepEqual(written.slow, ["bailian-cli/glm-5.2", "deepseek/deepseek-v4-pro"]);
  assert.deepEqual(written.smol, ["bailian-cli/qwen3.6-flash"]);
});

test("chain order is preserved exactly as written", () => {
  const settings = makeSettings(CHAINS);
  const ordered = ["deepseek/deepseek-v4-flash", "bailian-cli/qwen3.6-flash", "anthropic/claude-haiku-4-5-20251001"];
  writeRoleFallbackChain(settings, "smol", ordered);
  assert.deepEqual(byRole(listRoleFallbackChains(settings), "smol").effective, ordered);
});

test("an explicitly empty chain means no backups, not inherit", () => {
  // omp's own expansion only fills roles whose key is absent, so `[]` has to
  // survive as a real value or a role the user emptied silently regains the
  // default chain.
  const settings = makeSettings(CHAINS);
  writeRoleFallbackChain(settings, "smol", []);
  const chain = byRole(listRoleFallbackChains(settings), "smol");
  assert.equal(chain.inherited, false);
  assert.deepEqual(chain.configured, []);
  assert.deepEqual(chain.effective, []);
});

test("clearing a chain restores inheritance from default", () => {
  const settings = makeSettings(CHAINS);
  writeRoleFallbackChain(settings, "smol", ["bailian-cli/qwen3.6-flash"]);
  writeRoleFallbackChain(settings, "smol", null);
  const chain = byRole(listRoleFallbackChains(settings), "smol");
  assert.equal(chain.inherited, true);
  assert.equal(chain.configured, undefined);
  assert.deepEqual(chain.effective, ["deepseek/deepseek-v4-pro"]);
  assert.equal(Object.hasOwn(settings.get("retry.fallbackChains"), "smol"), false);
});

test("writing a role that had no chain does not disturb the default key", () => {
  const settings = makeSettings(CHAINS);
  writeRoleFallbackChain(settings, "smol", ["bailian-cli/qwen3.6-flash"]);
  assert.deepEqual(settings.get("retry.fallbackChains").default, ["deepseek/deepseek-v4-pro"]);
});
