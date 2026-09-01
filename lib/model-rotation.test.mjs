import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-rotation.ts");
  } catch {
    return import("./model-rotation.ts");
  }
}

const {
  advanceCursors,
  buildRolePool,
  readRotationState,
  rotateRole,
  rotatesRole,
  writeRotationState,
} = await loadSubject();

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "omp31-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("pool is the primary followed by its backups", () => {
  assert.deepEqual(
    buildRolePool("anthropic/claude-opus-5", ["deepseek/deepseek-v4-pro", "bailian-cli/glm-5.2"]),
    ["anthropic/claude-opus-5", "deepseek/deepseek-v4-pro", "bailian-cli/glm-5.2"],
  );
});

test("a repeated selector is kept once, at its first position", () => {
  // The primary commonly reappears in `default`'s chain; rotating onto the same
  // model twice would waste a slot and misreport the spread.
  assert.deepEqual(
    buildRolePool("deepseek/deepseek-v4-pro", ["bailian-cli/glm-5.2", "deepseek/deepseek-v4-pro"]),
    ["deepseek/deepseek-v4-pro", "bailian-cli/glm-5.2"],
  );
});

test("entries from disabled providers never enter the pool", () => {
  // Rotating onto a disabled provider would fail every request for the whole
  // conversation, so it must be dropped rather than merely deprioritised.
  assert.deepEqual(
    buildRolePool("zhipu-coding-plan/glm-5.3", ["bedrock-mantle/claude", "deepseek/deepseek-v4-pro"], ["bedrock-mantle"]),
    ["zhipu-coding-plan/glm-5.3", "deepseek/deepseek-v4-pro"],
  );
});

test("a thinking-level suffix does not break provider detection", () => {
  assert.deepEqual(buildRolePool("anthropic/claude-opus-5:high", [], ["anthropic"]), []);
});

test("empty and blank entries are ignored", () => {
  assert.deepEqual(buildRolePool(undefined, ["  ", "deepseek/deepseek-v4-pro"]), ["deepseek/deepseek-v4-pro"]);
  assert.deepEqual(buildRolePool(undefined, undefined), []);
});

test("consecutive cursors walk the pool then wrap", () => {
  const pool = ["A/1", "B/2", "C/3"];
  assert.deepEqual(rotateRole(pool, 0), { primary: "A/1", chain: ["B/2", "C/3"], index: 0 });
  assert.deepEqual(rotateRole(pool, 1), { primary: "B/2", chain: ["C/3", "A/1"], index: 1 });
  assert.deepEqual(rotateRole(pool, 2), { primary: "C/3", chain: ["A/1", "B/2"], index: 2 });
  assert.deepEqual(rotateRole(pool, 3), { primary: "A/1", chain: ["B/2", "C/3"], index: 0 });
});

test("the chain is the rotated remainder, so failover depth never shrinks", () => {
  const pool = ["A/1", "B/2", "C/3", "D/4"];
  for (let cursor = 0; cursor < 8; cursor++) {
    const rotated = rotateRole(pool, cursor);
    assert.equal(rotated.chain.length, pool.length - 1);
    assert.deepEqual(new Set([rotated.primary, ...rotated.chain]), new Set(pool));
  }
});

test("a single-entry pool always yields that entry and an empty chain", () => {
  assert.deepEqual(rotateRole(["only/1"], 7), { primary: "only/1", chain: [], index: 0 });
});

test("an empty pool rotates to nothing", () => {
  assert.equal(rotateRole([], 3), undefined);
});

test("a corrupt cursor cannot produce a negative index", () => {
  assert.equal(rotateRole(["A/1", "B/2"], -3)?.index, 1);
  assert.equal(rotateRole(["A/1", "B/2"], Number.NaN)?.index, 0);
});

test("a role rotates only when both the master switch and its own flag are on", () => {
  assert.equal(rotatesRole({ enabled: true, roles: { smol: true }, cursors: {} }, "smol"), true);
  assert.equal(rotatesRole({ enabled: false, roles: { smol: true }, cursors: {} }, "smol"), false);
  assert.equal(rotatesRole({ enabled: true, roles: { smol: false }, cursors: {} }, "smol"), false);
  assert.equal(rotatesRole({ enabled: true, roles: {}, cursors: {} }, "smol"), false);
});

test("missing state file reads as rotation off", () => {
  withDir((dir) => {
    assert.deepEqual(readRotationState(dir), { enabled: false, roles: {}, cursors: {} });
  });
});

test("malformed state file reads as rotation off rather than throwing", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "omp-web-model-rotation.json"), "{ not json");
    assert.deepEqual(readRotationState(dir), { enabled: false, roles: {}, cursors: {} });
  });
});

test("non-boolean and non-numeric fields are discarded on read", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "omp-web-model-rotation.json"),
      JSON.stringify({ enabled: "yes", roles: { a: true, b: "x" }, cursors: { a: 3, b: "9" } }),
    );
    assert.deepEqual(readRotationState(dir), { enabled: false, roles: { a: true }, cursors: { a: 3 } });
  });
});

test("state round-trips through write and read", () => {
  withDir((dir) => {
    const state = { enabled: true, roles: { task: true }, cursors: { task: 5 } };
    writeRotationState(dir, state);
    assert.deepEqual(readRotationState(dir), state);
  });
});

test("advancing hands out the current cursor and persists the next", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { smol: true }, cursors: {} });
    assert.deepEqual(advanceCursors(dir, ["smol"]), { smol: 0 });
    assert.deepEqual(advanceCursors(dir, ["smol"]), { smol: 1 });
    assert.deepEqual(advanceCursors(dir, ["smol"]), { smol: 2 });
    assert.equal(readRotationState(dir).cursors.smol, 3);
  });
});

test("advancing preserves the opt-in flags it did not touch", () => {
  withDir((dir) => {
    writeRotationState(dir, { enabled: true, roles: { smol: true, task: false }, cursors: { task: 4 } });
    advanceCursors(dir, ["smol"]);
    const after = readRotationState(dir);
    assert.deepEqual(after.roles, { smol: true, task: false });
    assert.equal(after.cursors.task, 4);
    assert.equal(after.enabled, true);
  });
});

test("advancing no roles writes nothing", () => {
  withDir((dir) => {
    assert.deepEqual(advanceCursors(dir, []), {});
    assert.equal(existsSync(join(dir, "omp-web-model-rotation.json")), false);
  });
});

test("three conversations land on three entries and the fourth wraps", () => {
  // The headline behaviour: consecutive conversations spread across providers.
  withDir((dir) => {
    const pool = ["anthropic/claude-opus-5", "deepseek/deepseek-v4-pro", "bailian-cli/glm-5.2"];
    writeRotationState(dir, { enabled: true, roles: { default: true }, cursors: {} });
    const picks = [0, 1, 2, 3].map(() => {
      const cursor = advanceCursors(dir, ["default"]).default;
      return rotateRole(pool, cursor).primary;
    });
    assert.deepEqual(picks, [...pool, pool[0]]);
  });
});
