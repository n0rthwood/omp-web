import type { WebUser } from "./web-users";

/**
 * UI-level project visibility for web users (issue #7).
 *
 * Pure string semantics: no realpath/symlink resolution — paths are compared
 * as normalized, slash-terminated prefixes. This is filtering, NOT a sandbox.
 */

export function isAdmin(user: WebUser): boolean {
  return user.role === "admin";
}

function normalizePath(path: string): string {
  let normalized = path;
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** True when `path` equals `root` or lies beneath it (`/home/abc` is NOT under `/home/a`). */
function isWithin(path: string, root: string): boolean {
  if (root === "") return false;
  if (root === "/") return path.startsWith("/");
  return path === root || path.startsWith(`${root}/`);
}

/**
 * `"*"` visibility sees everything. Otherwise the absolute path must lie
 * beneath one of the user's visible project roots.
 */
export function isPathVisible(user: WebUser, absPath: string): boolean {
  if (user.visibleProjects === "*") return true;
  const path = normalizePath(absPath);
  return user.visibleProjects.some((root) => isWithin(path, normalizePath(root)));
}

/** Keep sessions whose `projectRoot ?? cwd` is visible to the user. */
export function filterVisibleSessions<S extends { cwd: string; projectRoot?: string }>(
  user: WebUser,
  sessions: S[],
): S[] {
  return sessions.filter((session) => isPathVisible(user, session.projectRoot ?? session.cwd));
}

/**
 * Intersect the process-wide allowed file roots with the user's visibility.
 * Admins (and `"*"` visibility) keep every root.
 */
export function visibleRootsForUser(user: WebUser, allRoots: Set<string>): string[] {
  if (isAdmin(user) || user.visibleProjects === "*") return [...allRoots];
  const visible = user.visibleProjects.map(normalizePath);
  return [...allRoots].filter((root) => {
    const candidate = normalizePath(root);
    return visible.some((v) => isWithin(candidate, v));
  });
}
