import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

const { hostSpawnSetenvArgs } = await loadSubject();

test("forwards static machine and path environment without browser credentials", () => {
  const args = hostSpawnSetenvArgs({
    OMP_WEB_HOST_RUN_DIR: "/tmp/omp-hosts",
    OMP_WEB_HOST_IDLE_MS: "60000",
    HOME: "/tmp/omp-home",
    PI_CODING_AGENT_DIR: "/tmp/omp-agent",
    PI_PROFILE: "default",
    OMP_PROFILE: "default",
    OMP_WEB_USERS_FILE: "/tmp/users.yml",
    OMP_WEB_MACHINE_ID: "joysort187",
    OMP_WEB_MACHINE_NAME: "JoySort 187",
    OMP_WEB_STATIC_MAPPINGS_FILE: "/tmp/static-mappings.json",
    OMP_WEB_STATIC_ROOT: "/tmp/static",
    OMP_WEB_PASSWORD: "must-not-forward",
  });

  assert.deepEqual(args, [
    "--setenv=OMP_WEB_HOST_RUN_DIR=/tmp/omp-hosts",
    "--setenv=OMP_WEB_HOST_IDLE_MS=60000",
    "--setenv=HOME=/tmp/omp-home",
    "--setenv=PI_CODING_AGENT_DIR=/tmp/omp-agent",
    "--setenv=PI_PROFILE=default",
    "--setenv=OMP_PROFILE=default",
    "--setenv=OMP_WEB_USERS_FILE=/tmp/users.yml",
    "--setenv=OMP_WEB_MACHINE_ID=joysort187",
    "--setenv=OMP_WEB_MACHINE_NAME=JoySort 187",
    "--setenv=OMP_WEB_STATIC_MAPPINGS_FILE=/tmp/static-mappings.json",
    "--setenv=OMP_WEB_STATIC_ROOT=/tmp/static",
  ]);
});

test("keeps absent inherited values absent", () => {
  const args = hostSpawnSetenvArgs({
    OMP_WEB_MACHINE_ID: undefined,
    OMP_WEB_MACHINE_NAME: undefined,
    OMP_WEB_STATIC_MAPPINGS_FILE: undefined,
    OMP_WEB_STATIC_ROOT: "/tmp/static",
    OMP_WEB_PASSWORD: "must-not-forward",
  });

  assert.deepEqual(args, ["--setenv=OMP_WEB_STATIC_ROOT=/tmp/static"]);
  assert.equal(args.some((arg) => arg.includes("OMP_WEB_PASSWORD")), false);
});
