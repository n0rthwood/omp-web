import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
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
      const persistent = subject.createStaticMapping({ id: "persistent", persistent: true, sessionId: "session-a", projectRoot: "/opt/projects/main" });
      assert.equal(persistent.lifecycle, "persistent");
      assert.equal(persistent.expiresAt, undefined);
      assert.equal(subject.getStaticPublicMachineId(), "joysort187");
      assert.equal(subject.toStaticMapping(persistent).publicPath, "/static/joysort187/persistent/index.html");
      assert.equal(persistent.projectRoot, "/opt/projects/main");

      const temporary = subject.createStaticMapping({ id: "temporary", ttlSeconds: 60, projectRoot: "/opt/projects/main" });
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
      const mapping = subject.createStaticMapping({ id: "retained", lifecycle: "persistent", projectRoot: "/opt/projects/main" });
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
      const mapping = subject.createStaticMapping({ id: "retained-reuse", persistent: true, projectRoot: "/opt/projects/main" });
      const root = subject.getStaticMappingRoot(mapping.id);
      writeFileSync(join(root, "index.html"), "old retained bytes");
      subject.revokeStaticMapping(mapping.id, "retain");

      assert.throws(
        () => subject.createStaticMapping({ id: mapping.id, persistent: true, projectRoot: "/opt/projects/main" }),
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
      const mapping = subject.createStaticMapping({ id: "renewable", ttlSeconds: 60, projectRoot: "/opt/projects/main" });
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
      const expired = subject.createStaticMapping({ id: "expired", expiresAt: new Date(0).toISOString(), projectRoot: "/opt/projects/main" });
      const persistent = subject.createStaticMapping({ id: "keep", lifecycle: "persistent", projectRoot: "/opt/projects/main" });
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
      const mapping = subject.createStaticMapping({ id: "safe", projectRoot: "/opt/projects/main" });
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

test("a bare mapping URL resolves index.html before index.htm and never lists a directory", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      const mapping = subject.createStaticMapping({ id: "bare-index", lifecycle: "persistent", projectRoot: "/opt/projects/main" });
      const root = subject.getStaticMappingRoot(mapping.id);

      // Neither index file exists: no resolution, no listing.
      writeFileSync(join(root, "notes.txt"), "not an index");
      assert.equal(subject.resolveStaticMappingFile(mapping.id, []), null);

      // index.htm alone is served when index.html is absent.
      writeFileSync(join(root, "index.htm"), "<h1>htm</h1>");
      let resolved = subject.resolveStaticMappingFile(mapping.id, []);
      assert.ok(resolved);
      assert.equal(resolved.filePath, join(root, "index.htm"));

      // index.html wins when both exist.
      writeFileSync(join(root, "index.html"), "<h1>html</h1>");
      resolved = subject.resolveStaticMappingFile(mapping.id, []);
      assert.ok(resolved);
      assert.equal(resolved.filePath, join(root, "index.html"));

      // A directory named index.html is never served or enumerated.
      rmSync(join(root, "index.html"));
      mkdirSync(join(root, "index.html"));
      writeFileSync(join(root, "index.html", "inner.txt"), "inner");
      resolved = subject.resolveStaticMappingFile(mapping.id, []);
      assert.ok(resolved);
      assert.equal(resolved.filePath, join(root, "index.htm"));
      assert.equal(subject.resolveStaticMappingFile(mapping.id, ["index.html"]), null);

      // Explicit asset paths keep their exact behavior.
      resolved = subject.resolveStaticMappingFile(mapping.id, ["notes.txt"]);
      assert.ok(resolved);
      assert.equal(resolved.filePath, join(root, "notes.txt"));
      assert.equal(subject.resolveStaticMappingFile(mapping.id, ["missing.html"]), null);
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("entryFile still rejects an empty path after bare-URL support", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      assert.throws(() => subject.createStaticMapping({ entryFile: "", projectRoot: "/opt/projects/main" }), /entryFile/);
      assert.throws(() => subject.createStaticMapping({ entryFile: "a//b", projectRoot: "/opt/projects/main" }), /asset path is invalid/);
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("create requires an explicit absolute projectRoot and persists its normalized form", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      for (const bad of [undefined, null, "", "   ", "relative/path", "\\opt\\proj"]) {
        assert.throws(
          () => subject.createStaticMapping({ id: "bad-root", projectRoot: bad }),
          (error) => {
            assert.equal(error.status, 400);
            assert.equal(error.field, "projectRoot");
            return true;
          },
          `projectRoot ${JSON.stringify(bad)} must be rejected`,
        );
      }
      assert.equal(existsSync(subject.getStaticMappingRoot("bad-root")), false);

      const mapping = subject.createStaticMapping({ id: "rooted", persistent: true, projectRoot: " /opt//projects/./designer/../main/ " });
      assert.equal(mapping.projectRoot, "/opt/projects/main");
      const persisted = JSON.parse(readFileSync(store.file, "utf8"));
      assert.equal(persisted.mappings[0].projectRoot, "/opt/projects/main");
      assert.equal(subject.toStaticMapping(mapping).projectRoot, "/opt/projects/main");
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("historical rows without projectRoot load as legacy; malformed persisted roots are dropped", async () => {
  const store = isolatedStore();
  try {
    await withStore(store, async () => {
      const now = new Date().toISOString();
      writeFileSync(store.file, JSON.stringify({
        mappings: [
          { id: "legacy", label: "legacy", lifecycle: "persistent", state: "active", entryFile: "index.html", createdAt: now, updatedAt: now, contentRetained: true },
          { id: "bad-root", lifecycle: "persistent", state: "active", entryFile: "index.html", createdAt: now, updatedAt: now, contentRetained: true, projectRoot: "relative/root" },
          { id: "rooted", lifecycle: "persistent", state: "active", entryFile: "index.html", createdAt: now, updatedAt: now, contentRetained: true, projectRoot: "/opt/projects/main" },
        ],
      }));
      globalThis.__ompStaticMappingsCache = undefined;
      const listed = subject.listStaticMappings();
      assert.deepEqual(listed.map((mapping) => mapping.id), ["legacy", "bad-root", "rooted"]);
      assert.equal(subject.getStaticMapping("legacy").projectRoot, undefined);
      assert.equal(subject.getStaticMapping("bad-root").projectRoot, undefined);
      assert.equal(subject.getStaticMapping("rooted").projectRoot, "/opt/projects/main");
      // Legacy rows keep serving directly: auth + machine only, no project gate.
      const root = subject.getStaticMappingRoot("legacy");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "index.html"), "<h1>legacy</h1>");
      assert.ok(subject.resolveStaticMappingFile("legacy", ["index.html"]));
    });
  } finally {
    rmSync(store.dir, { recursive: true, force: true });
  }
});

test("resolveStaticProjectRoot collapses a removed <repo>-worktrees/<branch> path to the main checkout", async () => {
  const repo = mkdtempSync(join(tmpdir(), "omp-static-store-repo-"));
  const worktree = join(`${repo}-worktrees`, "feature-x");
  try {
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(repo, "README.md"), "main");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    mkdirSync(`${repo}-worktrees`, { recursive: true });
    git("worktree", "add", "-q", worktree, "-b", "feature-x");
    // Remove the worktree registration AND its directory so the path no
    // longer exists on disk — the exact case the old existsSync short-circuit
    // left dangling as a phantom project root.
    git("worktree", "remove", "--force", worktree);
    assert.equal(existsSync(worktree), false);

    assert.equal(await subject.resolveStaticProjectRoot(worktree), repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}-worktrees`, { recursive: true, force: true });
  }
});
