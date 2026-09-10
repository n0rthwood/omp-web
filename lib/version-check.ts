/**
 * Pure decision helpers for the version-staleness banner (issue #63).
 *
 * After a `.deb` upgrade the server restarts onto the new build while open
 * tabs keep running the old client bundle. The banner component polls
 * `GET /api/health` and compares the server's `ompWebVersion` against the
 * `NEXT_PUBLIC_APP_VERSION` baked into the loaded bundle; these helpers keep
 * that decision testable without a browser:
 *
 * - `serverVersionFromHealth` validates the polled payload (any shape off
 *   the wire is possible when a stale tab hits a changed/older server).
 * - `shouldShowBanner` encodes the visibility rule: show only when both
 *   versions are known and differ, and the mismatching server version isn't
 *   the one the user already dismissed. Plain string inequality — it also
 *   covers a rollback — per the issue's design notes.
 */

/** Extract a usable `ompWebVersion` from a `/api/health` JSON payload. */
export function serverVersionFromHealth(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  if (!("ompWebVersion" in payload)) return undefined;
  // `in`-narrowed above; typed as `unknown` — no cast needed.
  const version = payload.ompWebVersion;
  if (typeof version !== "string" || version.length === 0) return undefined;
  return version;
}

/**
 * Whether the staleness banner should be visible.
 *
 * @param clientVersion  Version baked into the loaded JS bundle
 *                       (`NEXT_PUBLIC_APP_VERSION`), constant per page load.
 * @param serverVersion  Latest `ompWebVersion` observed from `/api/health`.
 * @param dismissedServerVersion Server version the user dismissed, if any;
 *                       the banner re-shows only once the server version
 *                       differs from the dismissed one (a later upgrade or a
 *                       rollback), not on every poll.
 */
export function shouldShowBanner(
  clientVersion: string | null | undefined,
  serverVersion: string | null | undefined,
  dismissedServerVersion: string | null | undefined,
): boolean {
  if (!clientVersion || !serverVersion) return false;
  if (clientVersion === serverVersion) return false;
  return serverVersion !== dismissedServerVersion;
}
