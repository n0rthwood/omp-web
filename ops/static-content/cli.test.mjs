import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      const created = cli.executeStaticContentCommand({
        command: "create",
        input: { id: "cli-report", persistent: true, entryFile: "index.html" },
      });
      assert.equal(created.publicPath, "/static/cli-host/cli-report/index.html");
      assert.equal(typeof created.writeDir, "string");
      writeFileSync(join(created.writeDir, "index.html"), "<h1>cli</h1>");

      const listed = cli.executeStaticContentCommand({ op: "list" });
      assert.equal(listed.machineId, "cli-host");
      assert.equal(listed.mappings.length, 1);

      const updated = cli.executeStaticContentCommand({
        action: "update",
        mappingId: "cli-report",
        patch: { label: "Updated report" },
      });
      assert.equal(updated.mapping.label, "Updated report");

      const retained = cli.executeStaticContentCommand({ command: "revoke", id: "cli-report", content: "retain" });
      assert.equal(retained.mapping.state, "revoked");
      assert.equal(store.getStaticMapping("cli-report"), null);
      assert.equal(existsSync(join(paths.root, "cli-report")), true);

      const deleted = cli.executeStaticContentCommand({ command: "create", id: "delete-me", persistent: true });
      const deletedResult = cli.executeStaticContentCommand({ command: "revoke", id: "delete-me", content: "delete" });
      assert.equal(deletedResult.contentDeleted, true);
      assert.equal(existsSync(deleted.writeDir), false);
    });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("local JSON CLI rejects non-static fields", () => {
  assert.throws(
    () => cli.executeStaticContentCommand({ command: "create", project: "/tmp/project" }),
    /unsupported field: project/,
  );
});
