import assert from "node:assert/strict";
import test from "node:test";
import { loadRemovedProjects, normalizeProjectKey, saveRemovedProjects } from "./removed-projects.ts";

test("normalizeProjectKey lowercases a Windows drive-letter path and normalizes backslashes to forward slashes", () => {
  assert.equal(normalizeProjectKey("C:\\Users\\alice\\repo"), "c:/users/alice/repo");
});

test("normalizeProjectKey leaves a POSIX path untouched", () => {
  assert.equal(normalizeProjectKey("/home/alice/repo"), "/home/alice/repo");
});

test("loadRemovedProjects returns an empty set when window is unavailable (no DOM in this test runtime)", () => {
  assert.deepEqual(loadRemovedProjects(), new Set());
});

test("saveRemovedProjects no-ops when window is unavailable", () => {
  assert.doesNotThrow(() => saveRemovedProjects(new Set(["/proj"])));
});
