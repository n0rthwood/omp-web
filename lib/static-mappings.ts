/**
 * Browser-safe contract shared by the static-content API and Settings UI.
 * Keep this module free of Node-only imports and runtime filesystem work.
 */

export const STATIC_MAPPING_LIFECYCLES = ["persistent", "temporary"] as const;
export type StaticMappingLifecycle = typeof STATIC_MAPPING_LIFECYCLES[number];

export const STATIC_MAPPING_STATES = ["active", "revoked", "expired"] as const;
export type StaticMappingState = typeof STATIC_MAPPING_STATES[number];

/** A mapping as returned by the management API. */
export interface StaticMapping {
  id: string;
  label: string;
  lifecycle: StaticMappingLifecycle;
  persistent: boolean;
  state: StaticMappingState;
  /**
   * Normalized absolute main-project root registered at creation (issue
   * #136). Worktrees collapse to the main checkout root. Absent on
   * historical rows; those are admin-only in discovery and management.
   */
  projectRoot?: string;
  /** Session provenance only; it is never an authorization boundary. */
  sessionId?: string;
  /** Relative entry file used to form `publicPath`. */
  entryFile: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  /** True when the content directory is retained; revoke responses are snapshots. */
  contentRetained: boolean;
  /** Absolute directory where the owning agent may write static files. */
  writeDir: string;
  /** Origin-relative authenticated URL for the entry file. */
  publicPath: string;
}

export interface StaticMappingListResponse {
  machineId: string;
  mappings: StaticMapping[];
}

export interface StaticMappingMutationResponse {
  mapping: StaticMapping;
  writeDir: string;
  publicPath: string;
}

export interface StaticMappingDeleteResponse {
  ok: true;
  id: string;
  contentDeleted: boolean;
  /** Revocation snapshot; the metadata row is removed and is not persisted. */
  mapping: StaticMapping;
  writeDir: string;
  publicPath: string;
}

export interface StaticMappingCreateInput {
  id?: string;
  label?: string;
  lifecycle?: StaticMappingLifecycle;
  /** Alias accepted by the API and skill for lifecycle selection. */
  persistent?: boolean;
  ttlSeconds?: number;
  expiresAt?: string;
  sessionId?: string | null;
  entryFile?: string;
  /** Required: absolute main-project root; worktree roots collapse to the main checkout. */
  projectRoot: string;
}

export interface StaticMappingPatchInput {
  label?: string;
  lifecycle?: StaticMappingLifecycle;
  persistent?: boolean;
  ttlSeconds?: number | null;
  expiresAt?: string | null;
  entryFile?: string;
}
