import type { ModelEntry, ModelOption, ModelOverridePatch, ProviderEntry } from "./types";

/** One row of a provider's model table, merged from the registry and `models.yml`. */
export interface ModelRow {
  id: string;
  /** Where the row's values come from after the merge. */
  source: "catalog" | "config" | "merged";
  /** Index in the provider's `models` array, or null when the row is not a definition. */
  configIndex: number | null;
  /** The sparse `modelOverrides` patch on a catalog row. */
  override?: ModelOverridePatch;
  /** Effective values: what the row shows and where editing starts. */
  entry: ModelEntry;
  /** Efforts the registry says the model supports, least → most intensive. */
  efforts?: readonly string[];
}

/** The values a sparse override contributes; an absent field keeps the row's own. */
function patchedEntry(entry: ModelEntry, patch: ModelOverridePatch): ModelEntry {
  const next: ModelEntry = { ...entry };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.input !== undefined) next.input = patch.input;
  if (patch.contextWindow !== undefined) next.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
  if (patch.cost) next.cost = { ...(entry.cost ?? {}), ...patch.cost };
  return next;
}

/**
 * Every model `provider` serves, as the runtime resolves them.
 *
 * `models` are untrimmed registry rows: their values already include the saved
 * `models.yml`, so the only thing folded in here is the panel's own unsaved
 * state — a `models[]` definition and a `modelOverrides` patch. A definition
 * owns its row; an override for an id the registry does not serve has no row
 * to patch and is dropped.
 */
export function buildProviderModelRows(
  provider: { id: string; config?: ProviderEntry },
  models: readonly ModelOption[],
  thinkingLevels: Readonly<Record<string, readonly string[]>>,
): ModelRow[] {
  const byId = new Map<string, ModelRow>();
  for (const model of models) {
    if (model.provider !== provider.id) continue;
    const efforts = thinkingLevels[`${model.provider}:${model.id}`];
    byId.set(model.id, {
      id: model.id,
      source: "catalog",
      configIndex: null,
      entry: {
        id: model.id,
        name: model.name,
        input: model.input,
        reasoning: model.reasoning,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      ...(efforts ? { efforts } : {}),
    });
  }
  (provider.config?.models ?? []).forEach((entry, index) => {
    const existing = byId.get(entry.id);
    byId.set(entry.id, {
      id: entry.id,
      source: existing ? "merged" : "config",
      configIndex: index,
      entry,
      ...(existing?.efforts ? { efforts: existing.efforts } : {}),
    });
  });
  for (const [id, patch] of Object.entries(provider.config?.modelOverrides ?? {})) {
    const row = byId.get(id);
    if (!row || row.configIndex !== null) continue;
    byId.set(id, { ...row, source: "merged", override: patch, entry: patchedEntry(row.entry, patch) });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
