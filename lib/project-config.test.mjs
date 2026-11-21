import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectConfigValue, updateProjectConfigValue, writeProjectConfigValue } from "./project-config.ts";

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "omp-injection-config-"));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("project injection edits preserve unrelated YAML and comments; removal restores inheritance", () => fixture((root) => {
  mkdirSync(join(root, ".omp"));
  const path = join(root, ".omp/config.yml");
  writeFileSync(path, "# keep user notes\nmodelRoles:\n  default: test/model\ntodo:\n  reminders: true\n");
  writeProjectConfigValue(root, "todo.reminders", false);
  assert.equal(readProjectConfigValue(root, "todo.reminders"), false);
  assert.equal(readProjectConfigValue(root, "modelRoles.default"), "test/model");
  assert.match(readFileSync(path, "utf8"), /# keep user notes/);
  writeProjectConfigValue(root, "todo.reminders", undefined);
  assert.equal(readProjectConfigValue(root, "todo.reminders"), undefined);
  assert.equal(readProjectConfigValue(root, "modelRoles.default"), "test/model");
}));

test("disabled-rule updates use the latest list under the lock rather than a stale caller snapshot", () => fixture((root) => {
  writeProjectConfigValue(root, "ttsr.disabledRules", ["first"]);
  updateProjectConfigValue(root, "ttsr.disabledRules", (current) => [...current, "second"]);
  updateProjectConfigValue(root, "ttsr.disabledRules", (current) => current.filter((name) => name !== "first"));
  assert.deepEqual(readProjectConfigValue(root, "ttsr.disabledRules"), ["second"]);
}));

test("project config rejects symlinked config directories without changing the outside file", () => fixture((root) => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  const project = join(root, "project");
  mkdirSync(project);
  const target = join(outside, "config.yml");
  writeFileSync(target, "todo:\n  reminders: true\n");
  symlinkSync(outside, join(project, ".omp"), "dir");
  assert.throws(() => writeProjectConfigValue(project, "todo.reminders", false), /symbolic link/);
  assert.equal(readFileSync(target, "utf8"), "todo:\n  reminders: true\n");
}));

test("malformed YAML refuses a write and retains original bytes", () => fixture((root) => {
  mkdirSync(join(root, ".omp"));
  const path = join(root, ".omp/config.yml");
  const original = "todo: [unterminated\n";
  writeFileSync(path, original);
  assert.throws(() => writeProjectConfigValue(root, "todo.reminders", false), /valid YAML/);
  assert.equal(readFileSync(path, "utf8"), original);
}));
