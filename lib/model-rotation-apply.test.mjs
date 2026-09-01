import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadModule(spec) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(spec);
  } catch {
    return import(spec);
  }
}

const { applyConversationRotation, writeRotationState } = await loadModule("./model-rotation.ts");
const { Settings } = await loadModule("@oh-my-pi/pi-coding-agent/config/settings");

/**
 * `Settings.isolated` is mandatory here. `Settings.init` takes an options
 * object, silently falls back to the real `~/.omp/agent` when given anything
 * else, and returns the live global singleton when one exists — a write-mode
 * test built on it rewrites the user's own config.
 */
function makeSettings() {
  return Settings.isolated(
    {
      modelRoles: {
        default: "anthropic/claude-opus-5",
        task: "anthropic/claude-sonnet-5",
        commit: "anthropic/claude-sonnet-4-20250514",
      },
      "retry.fallbackChains": {
        default: ["deepseek/deepseek-v4-pro", "bailian-cli/glm-5.2"],
        task: ["deepseek/deepseek-v4-flash"],
      },
    },
    { storage: null },
  );
}

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "omp31-apply-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("rotation off leaves both records untouched", () => {
  withDir((dir) => {
    const settings = makeSettings();
    assert.deepEqual(applyConversationRotation(settings, dir), []);
    assert.equal(settings.getModelRole("default"), "anthropic/claude-opus-5");
    assert.deepEqual(settings.get("retry.fallbackChains").default,
      ["deepseek/deepseek-v4-pro", "bailian-cli/glm-5.2"]);
  });
});

test("consecutive conversations walk the pool and then wrap", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: {} });
    const picks = [0, 1, 2, 3].map(() => {
      const settings = makeSettings();
      applyConversationRotation(settings, dir);
      return settings.getModelRole("default");
    });
    assert.deepEqual(picks, [
      "anthropic/claude-opus-5",
      "deepseek/deepseek-v4-pro",
      "bailian-cli/glm-5.2",
      "anthropic/claude-opus-5",
    ]);
  });
});

test("each conversation's failover chain is the rotated remainder", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: { default: 1 } });
    const settings = makeSettings();
    applyConversationRotation(settings, dir);
    // Primary is entry 1, so the chain must be entry 2 then entry 0 - never the
    // globally configured order, or two conversations would fail over together.
    assert.equal(settings.getModelRole("default"), "deepseek/deepseek-v4-pro");
    assert.deepEqual(settings.get("retry.fallbackChains").default,
      ["bailian-cli/glm-5.2", "anthropic/claude-opus-5"]);
  });
});

test("a role that is not opted in keeps its configured model and chain", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: { default: 1 } });
    const settings = makeSettings();
    applyConversationRotation(settings, dir);
    assert.equal(settings.getModelRole("task"), "anthropic/claude-sonnet-5");
    assert.deepEqual(settings.get("retry.fallbackChains").task, ["deepseek/deepseek-v4-flash"]);
  });
});

test("skipRoles leaves the role alone and consumes no slot", () => {
  // An explicit model pick in the browser must win, and must not burn the
  // cursor that the next conversation would otherwise have used.
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: {} });
    const skipped = makeSettings();
    assert.deepEqual(applyConversationRotation(skipped, dir, { skipRoles: ["default"] }), []);
    assert.equal(skipped.getModelRole("default"), "anthropic/claude-opus-5");

    const next = makeSettings();
    applyConversationRotation(next, dir);
    assert.equal(next.getModelRole("default"), "anthropic/claude-opus-5", "cursor 0 was still available");
  });
});

test("a role rotates over the backups the panel shows it, inherited ones included", () => {
  // `commit` configures no chain of its own but inherits `default`'s, and #30's
  // panel displays exactly that as its backups. Rotating over the displayed set
  // is what makes the UI and the behaviour agree.
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { commit: true }, cursors: { commit: 1 } });
    const settings = makeSettings();
    applyConversationRotation(settings, dir);
    assert.equal(settings.getModelRole("commit"), "deepseek/deepseek-v4-pro");
  });
});

test("a role with genuinely no backups is skipped and consumes no slot", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { commit: true }, cursors: {} });
    const settings = Settings.isolated(
      { modelRoles: { commit: "anthropic/claude-sonnet-4-20250514" }, "retry.fallbackChains": {} },
      { storage: null },
    );
    assert.deepEqual(applyConversationRotation(settings, dir), []);
    assert.equal(settings.getModelRole("commit"), "anthropic/claude-sonnet-4-20250514");
  });
});

test("rotation never reaches a disabled provider", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: {} });
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const settings = Settings.isolated(
        {
          modelRoles: { default: "anthropic/claude-opus-5" },
          "retry.fallbackChains": { default: ["deepseek/deepseek-v4-pro", "bailian-cli/glm-5.2"] },
          disabledProviders: ["deepseek"],
        },
        { storage: null },
      );
      applyConversationRotation(settings, dir);
      seen.add(settings.getModelRole("default"));
    }
    assert.deepEqual([...seen].sort(), ["anthropic/claude-opus-5", "bailian-cli/glm-5.2"]);
  });
});

test("non-role fallback keys survive rotation", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: {} });
    const settings = Settings.isolated(
      {
        modelRoles: { default: "anthropic/claude-opus-5" },
        "retry.fallbackChains": {
          default: ["deepseek/deepseek-v4-pro"],
          "zhipu-coding-plan/glm-5.3": ["bailian-cli/glm-5.2"],
        },
      },
      { storage: null },
    );
    applyConversationRotation(settings, dir);
    assert.deepEqual(settings.get("retry.fallbackChains")["zhipu-coding-plan/glm-5.3"], ["bailian-cli/glm-5.2"]);
  });
});

test("one conversation's rotation does not leak into another's Settings", () => {
  // The trap this guards: `getSettingsForCwd` returns the SHARED process-wide
  // Settings when the cwd already matches. Applying the override to that
  // instance would pin every other conversation — and the TUI-facing config
  // surface — to whatever the last conversation happened to draw.
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: {} });
    const first = makeSettings();
    const second = makeSettings();
    applyConversationRotation(first, dir);
    assert.equal(first.getModelRole("default"), "anthropic/claude-opus-5");
    assert.equal(second.getModelRole("default"), "anthropic/claude-opus-5", "untouched instance keeps its own value");

    applyConversationRotation(second, dir);
    assert.equal(second.getModelRole("default"), "deepseek/deepseek-v4-pro");
    assert.equal(first.getModelRole("default"), "anthropic/claude-opus-5", "first conversation stayed on its pick");
  });
});
