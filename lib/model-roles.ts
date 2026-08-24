import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import {
  getKnownRoleIds,
  getRoleInfo,
  MODEL_ROLES,
  MODEL_ROLE_IDS,
  type ModelRole,
} from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
  getRetryFallbackChains,
  isKnownProvider,
  isRetryFallbackWildcardKey,
  parseRetryFallbackSelector,
  parseRetryFallbackWildcard,
  validateRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type {
  ModelRoleAssignment,
  ModelRoleModelRef,
  ModelRoleScope,
  RoleFallbackChain,
} from "./api-types";

export type { ModelRoleAssignment, ModelRoleModelRef, ModelRoleScope, RoleFallbackChain };

/**
 * omp's model roles, projected onto the web UI.
 *
 * omp does not have "the" model: it has a model per *scope of work* — `default`
 * for normal turns, `smol` for cheap subagent work, `slow` for deep reasoning,
 * `plan` for plan mode, `commit` for changelog generation, and so on. The TUI
 * exposes these through `/model` and Ctrl+P; this module is the equivalent data
 * source for the browser, so both surfaces read and write the same
 * `modelRoles` record in `~/.omp/agent/config.yml`.
 */

/** Description shown under each role in the web selector. */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  default: "Model used for ordinary turns.",
  smol: "Cheap, fast model for subagent and background work.",
  slow: "Deep-reasoning model for hard problems.",
  vision: "Model used when a turn carries images.",
  plan: "Model that drives plan mode.",
  designer: "Model used for UI and design work.",
  commit: "Model that writes commit messages and changelogs.",
  tiny: "Smallest model, used for classification and routing.",
  task: "Model subagents spawn with by default.",
  advisor: "Second model that reviews every turn inline.",
};

export function describeModelRole(role: string): string | undefined {
  return ROLE_DESCRIPTIONS[role];
}

function toModelRef(model: Model<Api>, thinkingLevel?: string): ModelRoleModelRef {
  return {
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/**
 * The `default` role as a plain model reference.
 *
 * Session startup uses this the way pi-web used `settings.defaultModel`: as the
 * preferred model when the browser did not pick one explicitly.
 */
export function readDefaultModelRole(settings: Settings): { provider: string; modelId: string } | undefined {
  const selector = settings.getModelRole("default");
  if (!selector) return undefined;
  const slash = selector.indexOf("/");
  if (slash <= 0) return undefined;
  // Strip a `:thinkingLevel` suffix; startup applies thinking separately.
  const modelId = selector.slice(slash + 1).split(":")[0];
  if (!modelId) return undefined;
  return { provider: selector.slice(0, slash), modelId };
}

/**
 * Every role omp knows about, with its configured selector and what that
 * selector resolves to against the currently available models.
 */
export function listModelRoles(
  settings: Settings,
  availableModels: Model<Api>[],
): ModelRoleAssignment[] {
  const builtinIds = new Set<string>(MODEL_ROLE_IDS);
  return getKnownRoleIds(settings).map((role) => {
    const info = getRoleInfo(role, settings);
    const selector = settings.getModelRole(role);
    const resolution = selector
      ? resolveModelRoleValue(selector, availableModels, { settings })
      : undefined;

    return {
      role,
      ...(info.tag ? { tag: info.tag } : {}),
      name: info.name,
      ...(info.color ? { color: String(info.color) } : {}),
      builtin: builtinIds.has(role),
      hidden: Boolean(MODEL_ROLES[role as ModelRole]?.hidden),
      ...(selector ? { selector } : {}),
      source: settings.getModelRoleSource(role),
      provenance: settings.getModelRoleProvenance(role),
      ...(resolution?.model ? { resolved: toModelRef(resolution.model, resolution.thinkingLevel) } : {}),
      ...(resolution?.warning ? { warning: resolution.warning } : {}),
    };
  });
}

/**
 * Assign (or clear) a role's model.
 *
 * `scope: "project"` writes `.omp/config.yml` next to the project so a
 * repository can pin its own reviewer or commit model; `"global"` writes the
 * user's `~/.omp/agent/config.yml`. Passing `selector: undefined` clears the
 * assignment at that layer and lets the next layer down take over.
 */
export function writeModelRole(
  settings: Settings,
  role: string,
  selector: string | undefined,
  scope: ModelRoleScope,
): void {
  if (scope === "project") {
    if (selector) settings.setProjectModelRole(role, selector);
    else settings.clearProjectModelRole(role);
    return;
  }
  settings.setModelRole(role, selector);
}

/** Format a model plus optional thinking level back into a role selector. */
export function formatRoleSelector(
  model: { provider: string; modelId: string },
  thinkingLevel?: string,
): string {
  const base = `${model.provider}/${model.modelId}`;
  return thinkingLevel && thinkingLevel !== "off" ? `${base}:${thinkingLevel}` : base;
}

/**
 * Every role's backup models.
 *
 * `retry.fallbackChains` is keyed by role name, by exact `provider/modelId`, by
 * `provider/*` wildcard, or by `default`. This projection covers only the role
 * keys, because that is what the panel edits; the other key kinds are read and
 * written back untouched by {@link writeRoleFallbackChain}.
 *
 * `effective` is what omp actually uses — omp's own
 * `getRetryFallbackChains` folds the `default` chain onto every role that has
 * no entry of its own. An explicitly empty array is preserved and means "no
 * backups", which is deliberately distinct from an absent key.
 */
export function listRoleFallbackChains(settings: Settings): RoleFallbackChain[] {
  const configured = settings.get("retry.fallbackChains") ?? {};
  const effective = getRetryFallbackChains(settings);
  return getKnownRoleIds(settings).map((role) => {
    const own = configured[role];
    return {
      role,
      ...(Array.isArray(own) ? { configured: [...own] } : {}),
      effective: [...(effective[role] ?? [])],
      inherited: !Array.isArray(own) && Array.isArray(effective[role]),
    };
  });
}

/**
 * Rewrite one role's chain, leaving every other key alone.
 *
 * Preserving the rest matters: the live config also carries exact-selector and
 * `provider/*` keys that this role-centric panel never shows, and dropping them
 * on write would silently delete failover routing the TUI depends on. Passing
 * `null` removes the role's key so the `default` chain takes over again.
 */
export function writeRoleFallbackChain(
  settings: Settings,
  role: string,
  chain: readonly string[] | null,
): void {
  const existing = settings.get("retry.fallbackChains") ?? {};
  const next: Record<string, string[]> = {};
  for (const key in existing) {
    const value = existing[key];
    if (key !== role && Array.isArray(value)) next[key] = [...value];
  }
  if (chain !== null) next[role] = [...chain];
  settings.set("retry.fallbackChains", next);
}

/**
 * Reject a chain entry omp could not route to, before it reaches config.
 *
 * Uses omp's own selector parser and provider check rather than a second
 * validator, so the browser accepts exactly what `validateRetryFallbackChains`
 * accepts. Returns one message per bad entry; empty means the chain is good.
 */
export function checkFallbackChainEntries(
  chain: readonly string[],
  modelRegistry: ModelRegistry,
): string[] {
  const problems: string[] = [];
  for (const entry of chain) {
    if (typeof entry !== "string" || !entry.trim()) {
      problems.push("Empty selector in chain.");
      continue;
    }
    if (isRetryFallbackWildcardKey(entry)) {
      const { provider } = parseRetryFallbackWildcard(entry, (candidate) =>
        isKnownProvider(modelRegistry, candidate));
      if (!isKnownProvider(modelRegistry, provider)) {
        problems.push(`Unknown provider: ${entry}`);
      }
      continue;
    }
    const parsed = parseRetryFallbackSelector(entry, modelRegistry);
    if (!parsed) {
      problems.push(`Invalid model selector: ${entry}`);
      continue;
    }
    if (!modelRegistry.find(parsed.provider, parsed.id)) {
      problems.push(`Unknown model: ${entry}`);
    }
  }
  return problems;
}

/** Warnings omp itself reports for the whole persisted record. */
export function collectFallbackChainWarnings(
  settings: Settings,
  modelRegistry: ModelRegistry,
): string[] {
  const warnings: string[] = [];
  validateRetryFallbackChains(settings, modelRegistry, (message) => warnings.push(message));
  return warnings;
}
