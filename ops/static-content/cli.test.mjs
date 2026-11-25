import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = await import("./cli.ts");
const store = await import("../../lib/static-mapping-store.ts");

function isolatedStore() {
  const dir = mkdtempSync(join(tmpdir(), "omp-static-cli-"));
  return { dir, file: join(dir, "mappings.json"), root: join(dir, "static") };
}

async function withStore(paths, fn) {
  const saved = {
    OMP_WEB_STATIC_MAPPINGS_FILE: process.env.OMP_WEB_STATIC_MAPPINGS_FILE,
    OMP_WEB_STATIC_ROOT: process.env.OMP_WEB_STATIC_ROOT,
    OMP_WEB_MACHINE_ID: process.env.OMP_WEB_MACHINE_ID,
  };
  process.env.OMP_WEB_STATIC_MAPPINGS_FILE = paths.file;
  process.env.OMP_WEB_STATIC_ROOT = paths.root;
  process.env.OMP_WEB_MACHINE_ID = "cli-host";
  globalThis.__ompStaticMappingsCache = undefined;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.__ompStaticMappingsCache = undefined;
  }
}

test("local JSON CLI creates, lists, updates, and revokes without HTTP", async () => {
  const paths = isolatedStore();
  try {
    await withStore(paths, async () => {
      const created = await cli.executeStaticContentCommand({
        command: "create",
        input: { id: "cli-report", persistent: true, entryFile: "index.html", projectRoot: "/opt/projects/main" },
      });
      assert.equal(created.publicPath, "/static/cli-host/cli-report/index.html");
      assert.equal(created.mapping.projectRoot, "/opt/projects/main");
      assert.equal(typeof created.writeDir, "string");
      writeFileSync(join(created.writeDir, "index.html"), "<h1>cli</h1>");

      const listed = await cli.executeStaticContentCommand({ op: "list" });
      assert.equal(listed.machineId, "cli-host");
      assert.equal(listed.mappings.length, 1);
      assert.equal(listed.mappings[0].projectRoot, "/opt/projects/main");

      const updated = await cli.executeStaticContentCommand({
        action: "update",
        mappingId: "cli-report",
        patch: { label: "Updated report" },
      });
      assert.equal(updated.mapping.label, "Updated report");
      assert.equal(updated.mapping.projectRoot, "/opt/projects/main");

      const retained = await cli.executeStaticContentCommand({ command: "revoke", id: "cli-report", content: "retain" });
      assert.equal(retained.mapping.state, "revoked");
      assert.equal(store.getStaticMapping("cli-report"), null);
      assert.equal(existsSync(join(paths.root, "cli-report")), true);

      const deleted = await cli.executeStaticContentCommand({ command: "create", id: "delete-me", persistent: true, projectRoot: "/opt/projects/main" });
      const deletedResult = await cli.executeStaticContentCommand({ command: "revoke", id: "delete-me", content: "delete" });
      assert.equal(deletedResult.contentDeleted, true);
      assert.equal(existsSync(deleted.writeDir), false);
    });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("local JSON CLI rejects non-static fields", async () => {
  await assert.rejects(
    () => cli.executeStaticContentCommand({ command: "create", project: "/tmp/project", projectRoot: "/opt/projects/main" }),
    /unsupported field: project/,
  );
});

test("local JSON CLI requires projectRoot on create and rejects malformed roots", async () => {
  const paths = isolatedStore();
  try {
    await withStore(paths, async () => {
      await assert.rejects(
        () => cli.executeStaticContentCommand({ command: "create", id: "no-root", persistent: true }),
        (error) => {
          assert.equal(error.status, 400);
          assert.equal(error.field, "projectRoot");
          return true;
        },
      );
      for (const bad of ["relative/path", "\\opt\\proj"]) {
        await assert.rejects(
          () => cli.executeStaticContentCommand({ command: "create", id: "bad-root", persistent: true, projectRoot: bad }),
          (error) => {
            assert.equal(error.status, 400);
            assert.equal(error.field, "projectRoot");
            return true;
          },
        );
      }
      assert.equal(store.getStaticMapping("no-root"), null);
      assert.equal(store.getStaticMapping("bad-root"), null);
    });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("local JSON CLI collapses a worktree projectRoot to the canonical main checkout", async () => {
  const paths = isolatedStore();
  const repo = mkdtempSync(join(tmpdir(), "omp-static-cli-repo-"));
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

    await withStore(paths, async () => {
      const fromWorktree = await cli.executeStaticContentCommand({
        command: "create",
        id: "wt-report",
        persistent: true,
        projectRoot: worktree,
      });
      assert.equal(fromWorktree.mapping.projectRoot, repo);

      const fromMain = await cli.executeStaticContentCommand({
        command: "create",
        id: "main-report",
        persistent: true,
        projectRoot: repo,
      });
      assert.equal(fromMain.mapping.projectRoot, repo);
    });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}-worktrees`, { recursive: true, force: true });
  }
});
