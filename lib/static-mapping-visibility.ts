import { isAdmin, isPathVisible } from "./web-visibility";
import type { WebUser } from "./web-users";
import type { StaticMappingRecord } from "./static-mapping-store";

/**
 * Project-aware discovery and management authorization for static mappings
 * (issue #136).
 *
 * Discovery is the intersection of the machine grant (enforced by the caller
 * via `grantedMachineIds` / `requireMachineGrant`) and the user's project
 * visibility on the mapping's registered main-project `projectRoot`.
 * Historical rows without a project key are admin-only. Direct serving of a
 * known mapping URL deliberately stays auth + machine-only and must NOT use
 * these helpers.
 */

type ProjectAnchored = Pick<StaticMappingRecord, "projectRoot">;

/**
 * Project-grant predicate shared by discovery filtering and management
 * authorization (update/revoke): admins pass everything; a historical row
 * without a project key passes only admins; otherwise the registered root
 * must be visible under the user's `visibleProjects` prefixes.
 */
export function canManageStaticMapping(user: WebUser, mapping: ProjectAnchored): boolean {
  if (isAdmin(user)) return true;
  const root = mapping.projectRoot;
  if (typeof root !== "string" || root.length === 0) return false;
  return isPathVisible(user, root);
}

/**
 * Keep only the mappings whose registered project root is visible to `user`.
 * Admins keep everything, including historical rows without a project key.
 * Order is preserved; callers that aggregate machines sort by `createdAt`.
 */
export function filterVisibleStaticMappings<M extends ProjectAnchored>(user: WebUser, mappings: readonly M[]): M[] {
  if (isAdmin(user)) return [...mappings];
  return mappings.filter((mapping) => canManageStaticMapping(user, mapping));
}
