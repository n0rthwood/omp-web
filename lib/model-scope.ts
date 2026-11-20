import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { resolveModelScope, type ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import type { Api, Model } from "@oh-my-pi/pi-ai";

/**
 * Model scoping shared by the UI selector and AgentSession startup.
 *
 * The `enabledModels` setting uses the same syntax as omp's `--models` flag:
 * globs matched against `provider/modelId` or a bare `modelId`, fuzzy matching
 * for non-glob patterns, plus an optional `:thinkingLevel` suffix
 * (`anthropic/*:high`). Exact string comparison silently drops every model
 * behind a pattern like `my-gateway/*`, so delegate to omp's own resolver
 * instead of reimplementing the matching rules here.
 */

/** The slice of `ModelRegistry` model scoping needs. */
export type ModelScopeRegistry = Pick<ModelRegistry, "getAvailable">;

/**
 * Keep cross-provider glob leakage out of the visible list.
 *
 * omp's resolver globs a pattern against `provider/modelId` *and* the bare
 * `modelId`, so `anthropic/claude-opus-5*` also matches
 * `openrouter/anthropic/claude-opus-5` — the same logical model re-sold by a
 * proxy. A pattern that names a real provider is a statement about that
 * provider only, so anchor it. Exact references already behave this way; only
 * globs leak (#111).
 */
function anchorToNamedProvider(
  pattern: string,
  models: readonly ScopedModel[],
  providerIds: ReadonlySet<string>,
): ScopedModel[] {
  const slash = pattern.indexOf("/");
  if (slash <= 0) return [...models];
  const providerId = pattern.slice(0, slash);
  if (!providerIds.has(providerId)) return [...models];
  return models.filter((scoped) => scoped.model.provider === providerId);
}

export interface ModelScopeResult {
  /** Models the UI should offer, in resolver order (all available when unscoped). */
  visible: readonly Model<Api>[];
  /** SDK-native scope retained for AgentSession model cycling and extensions. */
  scopedModels: readonly ScopedModel[];
  /** `provider/modelId` → thinking level pinned with a `:level` pattern suffix. */
  thinkingLevelPins: Record<string, string>;
  /** Resolver diagnostics, e.g. a pattern that matched no model. */
  warnings: string[];
}

export interface InitialModelScopeOptions {
  requestedModel?: { provider: string; modelId: string };
  defaultModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface InitialModelScopeResult {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  scopedModels: ScopedModel[];
}

function matchesModel(
  model: { provider: string; id: string },
  ref: { provider: string; modelId: string },
): boolean {
  return model.provider === ref.provider && model.id === ref.modelId;
}

/**
 * Resolve the visible model list for `patterns`.
 *
 * Falls back to every available model when no patterns are configured or when
 * the patterns resolve to nothing, so a stale or typo'd setting can never leave
 * the UI without any selectable model.
 */
export async function resolveVisibleModels(
  modelRegistry: ModelScopeRegistry,
  patterns: readonly string[] | undefined,
  settings?: Settings,
): Promise<ModelScopeResult> {
  const cleaned = (patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return {
      visible: modelRegistry.getAvailable(),
      scopedModels: [],
      thinkingLevelPins: {},
      warnings: [],
    };
  }

  const providerIds = new Set(modelRegistry.getAvailable().map((model) => model.provider));
  // Resolve one pattern at a time: anchoring is a per-pattern decision, and it
  // also subsumes the old re-resolve pass that surfaced omp's silent drops.
  const scopedModels: ScopedModel[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let runnerModels: Model<Api>[] | undefined;
  for (const pattern of cleaned) {
    const matched = await resolveModelScope([pattern], modelRegistry, undefined, settings);
    const anchored = anchorToNamedProvider(pattern, matched, providerIds);
    if (anchored.length === 0) {
      // A pattern naming a non-chat runner (judge, search, image, …) is not a
      // typo; omp keeps those out of the chat scope by design.
      runnerModels ??= modelRegistry.getAvailable("all").filter((model) => modelKind(model) !== "chat");
      const runnerRegistry: ModelScopeRegistry = { getAvailable: () => runnerModels ?? [] };
      const namesRunner = runnerModels.length > 0
        && (await resolveModelScope([pattern], runnerRegistry, undefined, settings)).length > 0;
      if (!namesRunner) warnings.push(`No model matches "${pattern}" in enabledModels.`);
      continue;
    }
    for (const scoped of anchored) {
      const key = `${scoped.model.provider}/${scoped.model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scopedModels.push(scoped);
    }
  }

  if (scopedModels.length === 0) {
    return {
      visible: modelRegistry.getAvailable(),
      scopedModels: [],
      thinkingLevelPins: {},
      warnings,
    };
  }

  // `anthropic/*:high` pins a thinking level on every model the glob matched.
  // omp applies the pin of the model a new session starts with; report them all
  // so the client can look up whichever model it pre-selects.
  const thinkingLevelPins: Record<string, string> = {};
  for (const scoped of scopedModels) {
    if (scoped.thinkingLevel) {
      thinkingLevelPins[`${scoped.model.provider}/${scoped.model.id}`] = scoped.thinkingLevel;
    }
  }
  return {
    visible: scopedModels.map((scoped) => scoped.model),
    scopedModels,
    thinkingLevelPins,
    warnings,
  };
}

/**
 * Select the model and thinking level used to create a new AgentSession.
 *
 * This mirrors omp's startup rule: prefer an explicit selection, otherwise use
 * the `default` model role when it is in scope, then the first resolver-ordered
 * model. A scoped-model thinking pin is applied unless the caller supplied an
 * explicit thinking level.
 */
export function selectInitialModelScope(
  scope: ModelScopeResult,
  options: InitialModelScopeOptions = {},
): InitialModelScopeResult {
  const requestedRef = options.requestedModel;
  const defaultRef = options.defaultModel;
  const requested = requestedRef
    ? scope.visible.find((model) => matchesModel(model, requestedRef))
    : undefined;
  if (requestedRef && !requested) {
    throw new Error(
      `Model is not available in the enabled scope: ${requestedRef.provider}/${requestedRef.modelId}`,
    );
  }

  const requestedScoped = requested
    ? scope.scopedModels.find((scoped) => scoped.model === requested
      || matchesModel(scoped.model, { provider: requested.provider, modelId: requested.id }))
    : undefined;
  const defaultScoped = !requested && defaultRef
    ? scope.scopedModels.find((scoped) => matchesModel(scoped.model, defaultRef))
    : undefined;
  const fallbackScoped = !requested ? (defaultScoped ?? scope.scopedModels[0]) : undefined;
  const defaultVisible = !requested && !fallbackScoped && defaultRef
    ? scope.visible.find((model) => matchesModel(model, defaultRef))
    : undefined;
  const selectedModel = requested ?? fallbackScoped?.model ?? defaultVisible;
  const scopedSelection = requestedScoped ?? fallbackScoped;
  const thinkingLevel = options.thinkingLevel ?? scopedSelection?.thinkingLevel;

  return {
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    scopedModels: [...scope.scopedModels],
  };
}
