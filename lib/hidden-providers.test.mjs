// Guards the per-machine hidden-provider preference (issue #144).
// Individually runnable: bun test lib/hidden-providers.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentMachineId } from "./api-path.ts";
import { loadHiddenProviders, saveHiddenProviders } from "./hidden-providers.ts";

test("loadHiddenProviders returns an empty set when window is unavailable (no DOM in this test runtime)", () => {
  assert.deepEqual(loadHiddenProviders(), new Set());
});

test("saveHiddenProviders no-ops when window is unavailable", () => {
  assert.doesNotThrow(() => saveHiddenProviders(new Set(["xai"])));
});

function withLocalStorage(run) {
  const store = new Map();
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
  };
  try {
    return run(store);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    setCurrentMachineId("local");
  }
}

test("a hidden provider round-trips and an emptied set removes the key", () => {
  withLocalStorage((store) => {
    saveHiddenProviders(new Set(["xai", "qwen-portal"]));
    assert.deepEqual(loadHiddenProviders(), new Set(["xai", "qwen-portal"]));
    assert.equal(store.size, 1);

    saveHiddenProviders(new Set());
    assert.deepEqual(loadHiddenProviders(), new Set());
    assert.equal(store.size, 0);
  });
});

test("the preference is machine-scoped: a remote machine never shares the local set", () => {
  withLocalStorage((store) => {
    saveHiddenProviders(new Set(["xai"]));
    setCurrentMachineId("gateway");
    assert.deepEqual(loadHiddenProviders(), new Set(), "local hides must not leak to another machine");

    saveHiddenProviders(new Set(["qwen-portal"]));
    assert.equal(store.has("omp-web:hidden-providers"), true);
    assert.equal(store.has("m:gateway:omp-web:hidden-providers"), true);
  });
});

test("corrupt storage degrades to an empty set instead of throwing", () => {
  withLocalStorage((store) => {
    store.set("omp-web:hidden-providers", "{not json");
    assert.deepEqual(loadHiddenProviders(), new Set());
    // Non-string entries are dropped, strings are kept.
    store.set("omp-web:hidden-providers", JSON.stringify(["xai", 7, null]));
    assert.deepEqual(loadHiddenProviders(), new Set(["xai"]));
  });
});
