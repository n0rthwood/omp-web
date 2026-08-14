import { getRpcSession } from "./rpc-manager";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import { resolveProject } from "./worktree";
import { getWebUserOrSynthetic } from "./web-auth-context";
import type { WebUser } from "./web-users";
import { isPathVisible } from "./web-visibility";

/**
 * Per-user session visibility gate for /api/sessions/[id]* and /api/agent/[id]
 * routes (issue #7).
 *
 * The 404 (not 403) response never confirms that a session exists — it is
 * indistinguishable from the route's own "Session not found".
 */

function visibilityError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Resolve a session's recorded cwd, preferring a live in-process session's header. */
export async function resolveSessionCwd(sessionId: string): Promise<string | null> {
  const rpc = getRpcSession(sessionId);
  if (rpc?.isAlive()) {
    const cwd = rpc.inner.sessionManager.getHeader()?.cwd ?? rpc.cwd;
    if (cwd) return cwd;
  }
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;
  try {
    return readSessionHeader(filePath)?.cwd ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the project root grouping a session's cwd belongs to, so visibility
 * can match `filterVisibleSessions` (a worktree session groups under its main
 * repo root while its cwd is the checkout itself).
 */
export async function resolveSessionProjectRoot(sessionId: string): Promise<string | null> {
  const cwd = await resolveSessionCwd(sessionId);
  if (cwd === null) return null;
  try {
    return (await resolveProject(cwd)).projectRoot;
  } catch {
    return null;
  }
}

/**
 * True when a session file exists for the id (or a live wrapper holds it),
 * independent of whether its cwd could be read.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  if (getRpcSession(sessionId)?.isAlive()) return true;
  const filePath = await resolveSessionPath(sessionId);
  return filePath !== null;
}

/**
 * Visibility of one session to one user: cwd OR project root must be visible
 * (matching `filterVisibleSessions`). Fail-closed: an existing session whose
 * cwd cannot be read is treated as not visible for non-admins.
 */
export async function isSessionVisibleToUser(user: WebUser, sessionId: string): Promise<boolean> {
  if (user.role === "admin" || user.visibleProjects === "*") return true;
  const cwd = await resolveSessionCwd(sessionId);
  if (cwd === null) return false;
  if (isPathVisible(user, cwd)) return true;
  const projectRoot = await resolveSessionProjectRoot(sessionId);
  return projectRoot !== null && isPathVisible(user, projectRoot);
}

/**
 * Returns the blocking Response when the session is outside the requester's
 * visible projects, 401 when auth is enabled but no valid credential is
 * present (middleware normally rejects those earlier), and null when the
 * request may proceed. Unknown sessions return null so the route's own
 * not-found handling applies unchanged.
 */
export async function requireVisibleSession(req: Request, sessionId: string): Promise<Response | null> {
  const user = await getWebUserOrSynthetic(req);
  if (!user) return visibilityError(401, "Authentication required");

  if (await isSessionVisibleToUser(user, sessionId)) return null;
  // Distinguish "unknown session" from "hidden session" only to preserve the
  // route's own not-found response for ids that genuinely don't exist.
  if (!(await sessionExists(sessionId))) return null;
  return visibilityError(404, "Session not visible for this user");
}

/**
 * Filter a set of session ids down to those visible to the user. Used by the
 * global running-session feeds so hidden live ids are never discoverable.
 */
export async function filterVisibleSessionIds(user: WebUser, ids: string[]): Promise<string[]> {
  if (user.role === "admin" || user.visibleProjects === "*") return ids;
  const visible: string[] = [];
  for (const id of ids) {
    if (await isSessionVisibleToUser(user, id)) visible.push(id);
  }
  return visible;
}
