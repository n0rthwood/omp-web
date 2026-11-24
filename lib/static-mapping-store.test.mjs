import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subject = await import("./static-mapping-store.ts");

function isolatedStore() {
  const dir = mkdtempSync(join(tmpdir(), "omp-static-mappings-"));
  return { dir, file: join(dir, "omp-web-static-mappings.json"), root: join(dir, "static") };
}

async function withStore(store, fn) {
  const saved = {
    OMP_WEB_STATIC_MAPPINGS_FILE: process.env.OMP_WEB_STATIC_MAPPINGS_FILE,
    OMP_WEB_STATIC_ROOT: process.env.OMP_WEB_STATIC_ROOT,
    OMP_WEB_MACHINE_ID: process.env.OMP_WEB_MACHINE_ID,
    OMP_WEB_MACHINE_NAME: process.env.OMP_WEB_MACHINE_NAME,
  };
  process.env.OMP_WEB_STATIC_MAPPINGS_FILE = store.file;
  process.env.OMP_WEB_STATIC_ROOT = store.root;
  process.env.OMP_WEB_MACHINE_ID = "joysort187";
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("metadata lifecycle persists identity and deletes content on revoke", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      const persistent = subject.createStaticMapping({ id: "persistent", persistent: true, sessionId: "session-a" });
      assert.equal(persistent.lifecycle, "persistent");
      assert.equal(persistent.expiresAt, undefined);
      assert.equal(subject.getStaticPublicMachineId(), "joysort187");
      assert.equal(subject.toStaticMapping(persistent).publicPath, "/static/joysort187/persistent/index.html");

      const temporary = subject.createStaticMapping({ id: "temporary", ttlSeconds: 60 });
      assert.ok(temporary.expiresAt);
      const result = subject.revokeStaticMapping(temporary.id, "delete");
      assert.equal(result.contentDeleted, true);
      assert.equal(subject.getStaticMapping(temporary.id), null);
      assert.equal(existsSync(subject.getStaticMappingRoot(temporary.id)), false);
      assert.equal(readFileSync(store.file, "utf8").includes("session-a"), true);
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("retain revoke removes metadata while preserving content and uses machine-name fallback", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      process.env.OMP_WEB_MACHINE_ID = "bad/id";
      process.env.OMP_WEB_MACHINE_NAME = "JoySort 187 / Canary";
      const mapping = subject.createStaticMapping({ id: "retained", lifecycle: "persistent" });
      const result = subject.revokeStaticMapping(mapping.id, "retain");
      assert.equal(result.contentDeleted, false);
      assert.equal(result.mapping.state, "revoked");
      assert.equal(subject.getStaticPublicMachineId(), "joysort-187-canary");
      assert.equal(subject.getStaticMapping(mapping.id), null);
      assert.equal(existsSync(subject.getStaticMappingRoot(mapping.id)), true);
      assert.equal(readFileSync(store.file, "utf8").includes("retained"), false);
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("retained content blocks explicit mapping ID reuse", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      const mapping = subject.createStaticMapping({ id: "retained-reuse", persistent: true });
      const root = subject.getStaticMappingRoot(mapping.id);
      writeFileSync(join(root, "index.html"), "old retained bytes");
      subject.revokeStaticMapping(mapping.id, "retain");

      assert.throws(
        () => subject.createStaticMapping({ id: mapping.id, persistent: true }),
        (error) => {
          assert.equal(error.status, 409);
          assert.equal(error.field, "id");
          assert.match(error.message, /not empty/);
          return true;
        },
      );
      assert.equal(subject.getStaticMapping(mapping.id), null);
      assert.equal(subject.resolveStaticMappingFile(mapping.id, ["index.html"]), null);
      assert.equal(readFileSync(join(root, "index.html"), "utf8"), "old retained bytes");
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("past temporary expiry PATCH is rejected without deleting active content", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      const mapping = subject.createStaticMapping({ id: "renewable", ttlSeconds: 60 });
      const root = subject.getStaticMappingRoot(mapping.id);
      writeFileSync(join(root, "index.html"), "still active");

      assert.throws(
        () => subject.updateStaticMapping(mapping.id, {
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
        (error) => {
          assert.equal(error.status, 400);
          assert.equal(error.field, "expiresAt");
          assert.equal(error.message, "expiresAt must be in the future");
          return true;
        },
      );
      const dateNow = Date.now;
      const exactNow = dateNow();
      Date.now = () => exactNow;
      try {
        assert.throws(
          () => subject.updateStaticMapping(mapping.id, {
            expiresAt: new Date(exactNow).toISOString(),
          }),
          (error) => {
            assert.equal(error.status, 400);
            assert.equal(error.field, "expiresAt");
            assert.equal(error.message, "expiresAt must be in the future");
            return true;
          },
        );
      } finally {
        Date.now = dateNow;
      }
      assert.equal(readFileSync(join(root, "index.html"), "utf8"), "still active");

      const unchanged = subject.getStaticMapping(mapping.id);
      assert.equal(unchanged.state, "active");
      assert.equal(unchanged.contentRetained, true);
      assert.equal(readFileSync(join(root, "index.html"), "utf8"), "still active");

      const renewed = subject.updateStaticMapping(mapping.id, { ttlSeconds: 60 });
      assert.equal(renewed.state, "active");
      assert.equal(renewed.lifecycle, "temporary");
      assert.ok(Date.parse(renewed.expiresAt) > Date.now());
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("expired temporary mappings sweep while persistent mappings remain", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      const expired = subject.createStaticMapping({ id: "expired", expiresAt: new Date(0).toISOString() });
      const persistent = subject.createStaticMapping({ id: "keep", lifecycle: "persistent" });
      subject.sweepExpiredStaticMappings(Date.now());
      assert.equal(subject.getStaticMapping(expired.id).state, "expired");
      assert.equal(subject.getStaticMapping(expired.id).contentRetained, false);
      assert.equal(subject.getStaticMapping(persistent.id).state, "active");
      assert.equal(existsSync(subject.getStaticMappingRoot(expired.id)), false);
      assert.equal(existsSync(subject.getStaticMappingRoot(persistent.id)), true);
      const renewed = subject.updateStaticMapping(expired.id, { persistent: true });
      assert.equal(renewed.state, "active");
      assert.equal(renewed.lifecycle, "persistent");
      assert.equal(existsSync(subject.getStaticMappingRoot(expired.id)), true);
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("asset resolution rejects traversal and symlink escapes", async () => {
  const store = isolatedStore();
  const outside = join(store.dir, "outside");
  try {
    await withStore(store, async () => {
      const mapping = subject.createStaticMapping({ id: "safe" });
      const root = subject.getStaticMappingRoot(mapping.id);
      writeFileSync(join(root, "index.html"), "<h1>safe</h1>");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(join(outside, "secret.txt"), join(root, "secret.txt"));

      assert.ok(subject.resolveStaticMappingFile(mapping.id, ["index.html"]));
      assert.equal(subject.resolveStaticMappingFile(mapping.id, ["secret.txt"]), null);
      assert.throws(() => subject.resolveStaticMappingFile(mapping.id, ["..", "outside", "secret.txt"]));
      rmSync(root, { recursive: true, force: true });
      symlinkSync(outside, root);
      assert.equal(subject.resolveStaticMappingFile(mapping.id, ["secret.txt"]), null);
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});
