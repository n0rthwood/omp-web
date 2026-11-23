import assert from "node:assert/strict";
import test from "node:test";
import "@oh-my-pi/pi-coding-agent/config/all-settings";

async function loadModule(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { readDefaultModelRole } = await loadModule("./model-roles.ts");
const { selectInitialModelScope } = await loadModule("./model-scope.ts");
const { Settings } = await loadModule("@oh-my-pi/pi-coding-agent/config/settings");

/**
 * `Settings.isolated` is the only safe way to exercise a write here;
 * `Settings.init` can fall back to the real `~/.omp/agent` config.
 */
function makeSettings(selector) {
  return Settings.isolated(
    { modelRoles: selector === undefined ? {} : { default: selector } },
    { storage: null },
  );
}

// First entry deliberately differs from every default under test: the #123
// bug showed up as startup silently picking scopedModels[0].
const MODELS = [
  { id: "glm-4.5", provider: "zhipu-coding-plan", name: "GLM-4.5" },
  { id: "baidu/ernie-5.5-flash-preview:free", provider: "openrouter", name: "ERNIE-5.5-Flash-Preview (free)" },
  { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5" },
  { id: "glm-4.7:max", provider: "acme", name: "GLM-4.7 Max" },
];

test("a colon inside the model id resolves literally (#123)", () => {
  const ref = readDefaultModelRole(
    makeSettings("openrouter/baidu/ernie-5.5-flash-preview:free"),
    MODELS,
  );
  assert.deepEqual(ref, { provider: "openrouter", modelId: "baidu/ernie-5.5-flash-preview:free" });
});

test("a trailing thinking level is still stripped from the reference", () => {
  const ref = readDefaultModelRole(makeSettings("anthropic/claude-opus-5:high"), MODELS);
  assert.deepEqual(ref, { provider: "anthropic", modelId: "claude-opus-5" });
});

test("a literal id ending in :max wins over thinking-level stripping", () => {
  const ref = readDefaultModelRole(makeSettings("acme/glm-4.7:max"), MODELS);
  assert.deepEqual(ref, { provider: "acme", modelId: "glm-4.7:max" });
});

test("a selector matching nothing returns undefined", () => {
  assert.equal(readDefaultModelRole(makeSettings("ghost-gateway/no-such-model"), MODELS), undefined);
});

test("no configured default role returns undefined", () => {
  assert.equal(readDefaultModelRole(makeSettings(undefined), MODELS), undefined);
});

test("the resolved default wins over scopedModels[0] at session startup", () => {
  const ref = readDefaultModelRole(
    makeSettings("openrouter/baidu/ernie-5.5-flash-preview:free"),
    MODELS,
  );
  const scope = {
    visible: MODELS,
    scopedModels: MODELS.map((model) => ({ model })),
    thinkingLevelPins: {},
    warnings: [],
  };
  const initial = selectInitialModelScope(scope, { defaultModel: ref });
  assert.equal(initial.model, MODELS[1]);
  assert.notEqual(initial.model, scope.scopedModels[0].model);
});
