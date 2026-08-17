/**
 * Local API path/method admin-only policy (issue #10, stage 1).
 *
 * Shared between `proxy.ts` (the outer Next middleware gate) and
 * `app/api/web-users/_guard.ts` (route-level defense in depth, plus the
 * machine-grant inner-path check for the fleet proxy catch-all). Zero
 * imports on purpose: `proxy.ts` is edge-flavored Next middleware and must
 * stay import-safe — this module can never pull in node:fs/crypto-backed
 * code, directly or transitively.
 */

/**
 * API prefixes only the admin role may touch, on any machine (local or
 * proxied through the fleet gateway). `/api/machines` is handled separately
 * by `isAdminOnlyLocalApiPath` below — its listing surface (`GET`) is open to
 * any authenticated user, filtered and slimmed per-route.
 */
export const ADMIN_ONLY_API_PREFIXES = [
  "/api/auth/all-providers",
  "/api/auth/api-key",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/plugins",
  "/api/mcp",
  "/api/project-trust",
  "/api/settings",
  "/api/updates",
  "/api/models-config",
  "/api/git",
  // skills install/update are admin-only at both layers: `update` reinstalls
  // with `force` (install power), and the settings UI already marks the
  // skills section requiresAdmin. Listing/toggling stays user-accessible.
  "/api/skills/install",
  "/api/skills/update",
  "/api/web-users",
];

function matchesAdminOnlyPrefix(pathname: string): boolean {
  return ADMIN_ONLY_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Local pathname + method admin gate (`proxy.ts` step 5). `/api/machines`
 * gets a special case instead of a blanket prefix match:
 *
 * - `/api/machines` itself: admin-only for every method except `GET` (the
 *   listing is open to any authenticated user; the route filters + slims it).
 * - `/api/machines/<id>` (one extra segment): always admin-only — machine
 *   PATCH/DELETE stays fleet-configuration, never grantable.
 * - `/api/machines/<id>/...` (two or more extra segments): the fleet proxy
 *   catch-all. NOT blocked here — `requireMachineGrant`
 *   (`app/api/web-users/_guard.ts`) owns unknown-machine (404),
 *   ungranted-machine (403) and inner-admin-path (403) decisions.
 */
export function isAdminOnlyLocalApiPath(method: string, pathname: string): boolean {
  if (matchesAdminOnlyPrefix(pathname)) return true;
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "machines") return false;
  const rest = segments.slice(2);
  if (rest.length === 0) return method !== "GET";
  return rest.length === 1;
}

/**
 * Inner decoded remote-pathname admin gate. Used by `requireMachineGrant` to
 * keep the fleet proxy catch-all from reaching admin-only surfaces on a
 * remote machine on behalf of a granted non-admin user (e.g. `PUT
 * /api/models-config`, `POST /api/auth/api-key/<provider>`).
 *
 * `/api/machines` and `/api/web-users` are included here even though the
 * transport allow-list (`lib/machines/proxy-allowlist.ts`) already denies
 * them for everyone: the route guard must refuse fleet-management surfaces
 * independently, so the two-layer discipline holds even if a future
 * `proxyToMachine` call site forgets the allow-list.
 */
export function isAdminOnlyRemoteApiPath(pathname: string): boolean {
  return (
    matchesAdminOnlyPrefix(pathname)
    || pathname === "/api/machines"
    || pathname.startsWith("/api/machines/")
    || pathname === "/api/web-users"
    || pathname.startsWith("/api/web-users/")
  );
}
