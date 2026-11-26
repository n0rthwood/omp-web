import type { ModelRoleAssignment } from "./model-roles";
import type { ModelHealth } from "./models-health";

export type { ModelHealth };

/**
 * Catalog facts of one listed model, copied from its registry row (#144).
 * Every field is optional so a payload written before it existed still parses.
 */
export interface ModelCatalogFields {
  input?: string[];
  reasoning?: boolean;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelCatalogEntry extends ModelCatalogFields {
  id: string;
  name: string;
  provider: string;
  /**
   * Whether the `enabledModels` allow-list currently hides this model. Only the
   * unscoped listing (`?all=1`) sets it, and only while a scope resolves; a
   * remote on an older release omits it (#147).
   */
  hidden?: boolean;
}

export interface ModelsData {
  models: Record<string, string>;
  modelList: ModelCatalogEntry[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  /** omp's model roles (default/smol/slow/plan/commit/…) with their assignments. */
  roles: ModelRoleAssignment[];
  /** Chat models that credential-wise exist but the `enabledModels` allow-list hides. */
  hiddenModelCount?: number;
  /**
   * Per-provider split of the models the allow-list hides: most hidden first,
   * then by provider name, listing only providers with a hidden model. Present
   * exactly when `hiddenModelCount` is (#147).
   */
  hiddenByProvider?: { provider: string; hidden: number; visible: number }[];
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: string[];
  /** `provider/modelId` → credential health for the listed models (issue #139). */
  modelHealth?: Record<string, ModelHealth>;
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __ompModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__ompModelsCacheState) {
    globalThis.__ompModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__ompModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    state.entries.delete(cwd);
  }

  const existingLoad = state.inFlight.get(cwd);
  if (existingLoad) return existingLoad;

  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        const now = Date.now();
        for (const [key, entry] of state.entries) {
          if (entry.expiresAt <= now) state.entries.delete(key);
        }
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: now + MODELS_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}
