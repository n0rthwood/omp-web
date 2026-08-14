import { OMP_WEB_AUTH_USERNAME, isValidBasicAuthorization } from "./web-auth";
import { WEB_SESSION_COOKIE, lookupWebSession } from "./web-sessions";
import {
  authEnabled,
  getEffectiveWebUsers,
  toSafeWebUser,
  verifyWebBearerToken,
  type EffectiveWebUser,
  type WebUser,
} from "./web-users";

/**
 * Unified identity resolution for web auth (issue #7).
 *
 * Resolution order: cookie session → Bearer token → legacy Basic (env
 * migration bridge). Reads headers off the raw `Request`, which also works
 * for `NextRequest` in middleware (same Headers instance).
 */

export type { WebUser } from "./web-users";

/** Synthetic identity used while auth is disabled (previous no-auth behavior). */
const ANONYMOUS_WEB_USER: WebUser = {
  username: "__anonymous",
  role: "admin",
  visibleProjects: "*",
};

function parseCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function findEffectiveUser(username: string): EffectiveWebUser | null {
  return getEffectiveWebUsers().find((user) => user.username === username) ?? null;
}

/**
 * Resolve the request credential to a safe `WebUser`, or null when auth is
 * enabled and no valid credential is present.
 */
export async function getWebUserFromRequest(request: Request): Promise<WebUser | null> {
  // 1. Cookie session (browser/PWA).
  const sessionRaw = parseCookieValue(request.headers.get("cookie"), WEB_SESSION_COOKIE);
  if (sessionRaw) {
    const session = lookupWebSession(sessionRaw);
    if (session) {
      const user = findEffectiveUser(session.username);
      if (user) return toSafeWebUser(user);
    }
  }

  // 2. Bearer token (CLI).
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (bearer) {
      const user = verifyWebBearerToken(bearer[1]);
      if (user) return toSafeWebUser(user);
    } else if (isValidBasicAuthorization(authorization)) {
      // 3. Legacy Basic auth — the OMP_WEB_PASSWORD migration bridge. Valid
      // credentials map to the implicit env-backed admin.
      return { username: OMP_WEB_AUTH_USERNAME, role: "admin", visibleProjects: "*" };
    }
  }

  return null;
}

/**
 * Resolve with the `__anonymous` admin substituted when auth is disabled.
 * When auth is enabled, delegates to `getWebUserFromRequest` (may be null —
 * the middleware gate rejects unauthenticated traffic before routes run).
 */
export async function getWebUserOrSynthetic(request: Request): Promise<WebUser | null> {
  if (!authEnabled()) return { ...ANONYMOUS_WEB_USER };
  return getWebUserFromRequest(request);
}
