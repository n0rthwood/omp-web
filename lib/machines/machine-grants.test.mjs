import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadStore() {
  return import("./machine-store.ts");
}

async function loadGrants() {
  return import("./machine-grants.ts");
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tempMachinesFile() {
  const dir = mkdtempSync(join(tmpdir(), "machine-grants-"));
  return { dir, file: join(dir, "omp-web-machines.json") };
}

test("effectiveMachineGrants: admin role is always \"*\", user role carries the stored value", async () => {
  const { effectiveMachineGrants } = await loadGrants();
  assert.equal(effectiveMachineGrants({ role: "admin", machines: [] }), "*");
  assert.equal(effectiveMachineGrants({ role: "admin", machines: ["gpu-1"] }), "*");
  assert.deepEqual(effectiveMachineGrants({ role: "user", machines: ["gpu-1"] }), ["gpu-1"]);
  assert.equal(effectiveMachineGrants({ role: "user", machines: "*" }), "*");
});

test("pruneMachineGrants: \"*\" stays; array drops ids no longer in the registry", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const store = await loadStore();
      const { pruneMachineGrants } = await loadGrants();
      const gpu1 = store.createMachine({ name: "GPU 1", baseUrl: "http://gpu1", authMode: "none", id: "gpu-1" });
      assert.equal(gpu1.id, "gpu-1");

      assert.equal(pruneMachineGrants("*"), "*");
      assert.deepEqual(pruneMachineGrants(["gpu-1", "deleted-machine"]), ["gpu-1"]);
      assert.deepEqual(pruneMachineGrants(["local"]), ["local"]);
      assert.deepEqual(pruneMachineGrants([]), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grantedMachineIds: always includes local, resolves \"*\" to the full registry", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const store = await loadStore();
      const { grantedMachineIds } = await loadGrants();
      store.createMachine({ name: "GPU 1", baseUrl: "http://gpu1", authMode: "none", id: "gpu-1" });
      store.createMachine({ name: "GPU 2", baseUrl: "http://gpu2", authMode: "none", id: "gpu-2" });

      assert.deepEqual(grantedMachineIds({ role: "user", machines: ["gpu-1"] }), ["local", "gpu-1"]);
      assert.deepEqual(grantedMachineIds({ role: "user", machines: [] }).sort(), ["local"]);
      assert.deepEqual(
        grantedMachineIds({ role: "admin", machines: [] }).sort(),
        ["gpu-1", "gpu-2", "local"].sort(),
      );
      assert.deepEqual(
        grantedMachineIds({ role: "user", machines: "*" }).sort(),
        ["gpu-1", "gpu-2", "local"].sort(),
      );
      // A stale grant for a deleted machine never leaks into the result.
      assert.deepEqual(grantedMachineIds({ role: "user", machines: ["deleted-machine"] }), ["local"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isMachineGranted: local is always granted; admin bypasses; user must be listed and the machine must exist in the registry", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const store = await loadStore();
      const { isMachineGranted } = await loadGrants();
      store.createMachine({ name: "GPU 1", baseUrl: "http://gpu1", authMode: "none", id: "gpu-1" });

      assert.equal(isMachineGranted({ role: "user", machines: [] }, "local"), true);
      assert.equal(isMachineGranted({ role: "admin", machines: [] }, "gpu-1"), true);
      assert.equal(isMachineGranted({ role: "admin", machines: [] }, "unknown-machine"), true);
      assert.equal(isMachineGranted({ role: "user", machines: ["gpu-1"] }, "gpu-1"), true);
      assert.equal(isMachineGranted({ role: "user", machines: [] }, "gpu-1"), false);
      assert.equal(isMachineGranted({ role: "user", machines: "*" }, "gpu-1"), true);
      // Stale grant for a machine that no longer exists is never granted.
      assert.equal(isMachineGranted({ role: "user", machines: ["deleted-machine"] }, "deleted-machine"), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
