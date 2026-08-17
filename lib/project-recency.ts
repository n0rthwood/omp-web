/**
 * All project roots in a session-list snapshot (deduped so worktrees collapse
 * into their main repo), most-recently-modified first.
 *
 * Shared by two call sites that used to duplicate this exact computation
 * (issue #10 stage-3 review, minor #8): `lib/nav-state.ts`'s pipeline
 * default-project pick, and `SessionSidebar`'s workspace-selector dropdown
 * (`getRecentProjects`, pre-#10). Pure module: no React, no fs.
 */

import type { SessionInfo } from "./types";

export function mostRecentProjectRoots(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>(); // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || s.modified > prev) latestByRoot.set(root, s.modified);
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([root]) => root);
}
