import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Fresh module graph per case: both gates read process.env at call time, but
 *  the users store caches its file. */
async function loadGate() {
  const suffix = `${Date.now()}-${Math.random()}`;
  return import(`./fleet-gate.ts?${suffix}`);
}

async function withEnv(vars, body) {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function emptyUsersFile() {
  const dir = mkdtempSync(join(tmpdir(), "omp-fleet-gate-"));
  const file = join(dir, "omp-web-users.yml");
  writeFileSync(file, "users: []\n");
  return { dir, file };
}

test("a loopback bind may configure machines with no authentication", async () => {
  const { dir, file } = emptyUsersFile();
  try {
    await withEnv(
      { OMP_WEB_HOSTNAME: "127.0.0.1", OMP_WEB_PASSWORD: undefined, OMP_WEB_USERS_FILE: file },
      async () => {
        const { isFleetConfigurationAllowed } = await loadGate();
        assert.equal(isFleetConfigurationAllowed(), true);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wider bind with no authentication may not configure machines", async () => {
  const { dir, file } = emptyUsersFile();
  try {
    await withEnv(
      { OMP_WEB_HOSTNAME: "0.0.0.0", OMP_WEB_PASSWORD: undefined, OMP_WEB_USERS_FILE: file },
      async () => {
        const { isFleetConfigurationAllowed } = await loadGate();
        // Every caller is the synthetic anonymous admin here, so the route's
        // admin check stops nobody — and the registry holds other hosts' keys.
        assert.equal(isFleetConfigurationAllowed(), false);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wider bind with a password may configure machines", async () => {
  const { dir, file } = emptyUsersFile();
  try {
    await withEnv(
      { OMP_WEB_HOSTNAME: "0.0.0.0", OMP_WEB_PASSWORD: "s3cret", OMP_WEB_USERS_FILE: file },
      async () => {
        const { isFleetConfigurationAllowed } = await loadGate();
        assert.equal(isFleetConfigurationAllowed(), true);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
