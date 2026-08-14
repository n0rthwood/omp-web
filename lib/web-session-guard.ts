import { getRpcSession } from "./rpc-manager";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import { getWebUserOrSynthetic } from "./web-auth-context";
import { isPathVisible } from "./web-visibility";

/**
 * Per-user session visibility gate for /api/sessions/[id]* routes (issue #7).
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
 * Returns the blocking Response when the session's cwd lies outside the
 * requester's visible projects, 401 when auth is enabled but no valid
 * credential is present (middleware normally rejects those earlier), and
 * null when the request may proceed. Unknown sessions return null so the
 * route's own not-found handling applies unchanged.
 */
export async function requireVisibleSession(req: Request, sessionId: string): Promise<Response | null> {
  const user = await getWebUserOrSynthetic(req);
  if (!user) return visibilityError(401, "Authentication required");
  const cwd = await resolveSessionCwd(sessionId);
  if (cwd === null) return null;
  if (!isPathVisible(user, cwd)) {
    return visibilityError(404, "Session not visible for this user");
  }
  return null;
}
