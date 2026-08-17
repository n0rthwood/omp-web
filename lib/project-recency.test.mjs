import assert from "node:assert/strict";
import test from "node:test";
import { mostRecentProjectRoots } from "./project-recency.ts";

function session(id, cwd, opts = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd,
    projectRoot: "projectRoot" in opts ? opts.projectRoot : cwd,
    created: opts.modified ?? "2026-01-01T00:00:00.000Z",
    modified: opts.modified ?? "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
  };
}

test("orders project roots by most-recently-modified session, descending", () => {
  const sessions = [
    session("a", "/repo-a", { modified: "2026-01-01T00:00:00.000Z" }),
    session("b", "/repo-b", { modified: "2026-03-01T00:00:00.000Z" }),
    session("c", "/repo-c", { modified: "2026-02-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(mostRecentProjectRoots(sessions), ["/repo-b", "/repo-c", "/repo-a"]);
});

test("dedupes worktrees of the same repo by projectRoot, keeping the latest modification", () => {
  const sessions = [
    session("a", "/worktree-1", { projectRoot: "/main-repo", modified: "2026-01-01T00:00:00.000Z" }),
    session("b", "/worktree-2", { projectRoot: "/main-repo", modified: "2026-03-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(mostRecentProjectRoots(sessions), ["/main-repo"]);
});

test("falls back to cwd when projectRoot is null on the session", () => {
  const sessions = [session("a", "/plain-dir", { projectRoot: null })];
  assert.deepEqual(mostRecentProjectRoots(sessions), ["/plain-dir"]);
});

test("an empty session list yields an empty list", () => {
  assert.deepEqual(mostRecentProjectRoots([]), []);
});
