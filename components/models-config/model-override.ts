import type { ModelEntry, ModelOverridePatch, ModelsJson } from "./types";

/**
 * Writing a catalog row back to `models.yml` (issue #144).
 *
 * omp applies `providers.<id>.modelOverrides.<modelId>` as a sparse patch over
 * the catalog model: a field that is present wins, an absent one keeps
 * following the catalog. That is the only models.yml shape that can override
 * one value of a catalog row without redefining the model — a same-id entry in
 * `models[]` needs a provider `baseUrl` + `api` + credential and replaces the
 * model's transport wholesale, and without them the whole file fails
 * validation. So an edit writes just the fields that changed.
 */

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The fields of `next` that differ from `seed`, the values the row showed when
 * editing began. A field set to `undefined` was cleared. `cost` reports only
 * the changed rates, because an override may patch one rate and inherit the
 * rest.
 */
export function changedModelFields(seed: ModelEntry, next: ModelEntry): ModelOverridePatch {
  const patch: ModelOverridePatch = {};
  // A blank name is a cleared one: the schema rejects an empty `name`.
  const name = next.name?.trim() || undefined;
  if ((seed.name ?? undefined) !== name) patch.name = name;
  if (!sameValue(seed.input, next.input)) patch.input = next.input;
  if (!sameValue(seed.contextWindow, next.contextWindow)) patch.contextWindow = next.contextWindow;
  if (!sameValue(seed.maxTokens, next.maxTokens)) patch.maxTokens = next.maxTokens;
  const cost: NonNullable<ModelOverridePatch["cost"]> = {};
  if (seed.cost?.input !== next.cost?.input) cost.input = next.cost?.input;
  if (seed.cost?.output !== next.cost?.output) cost.output = next.cost?.output;
  if ("input" in cost || "output" in cost) patch.cost = cost;
  return patch;
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

/**
 * Fold `changed` into `providers.<providerId>.modelOverrides.<modelId>`.
 *
 * Only the keys of `changed` are touched; a key holding `undefined` clears
 * that override, so the row returns to the catalog value. Fields this panel
 * does not edit (headers, compat, promptCache…) are kept as authored. When
 * the last patch disappears its containers go too: the schema rejects an
 * empty `modelOverrides` map and an empty provider block outright, which
 * would take every models.yml provider down with it.
 */
export function withModelOverride(
  config: ModelsJson,
  providerId: string,
  modelId: string,
  changed: ModelOverridePatch,
): ModelsJson {
  if (!hasKeys(changed)) return config;

  const providers = config.providers ?? {};
  const provider = providers[providerId];
  const next: ModelOverridePatch = { ...(provider?.modelOverrides?.[modelId] ?? {}) };
  if ("name" in changed) {
    if (changed.name === undefined) delete next.name;
    else next.name = changed.name;
  }
  if ("input" in changed) {
    if (changed.input === undefined) delete next.input;
    else next.input = changed.input;
  }
  if ("contextWindow" in changed) {
    if (changed.contextWindow === undefined) delete next.contextWindow;
    else next.contextWindow = changed.contextWindow;
  }
  if ("maxTokens" in changed) {
    if (changed.maxTokens === undefined) delete next.maxTokens;
    else next.maxTokens = changed.maxTokens;
  }
  if (changed.cost) {
    const rates = { ...(next.cost ?? {}) };
    if ("input" in changed.cost) {
      if (changed.cost.input === undefined) delete rates.input;
      else rates.input = changed.cost.input;
    }
    if ("output" in changed.cost) {
      if (changed.cost.output === undefined) delete rates.output;
      else rates.output = changed.cost.output;
    }
    if (hasKeys(rates)) next.cost = rates;
    else delete next.cost;
  }

  const overrides = { ...(provider?.modelOverrides ?? {}) };
  if (hasKeys(next)) overrides[modelId] = next;
  else delete overrides[modelId];

  const entry = { ...provider };
  if (hasKeys(overrides)) entry.modelOverrides = overrides;
  else delete entry.modelOverrides;

  const nextProviders = { ...providers };
  if (hasKeys(entry)) nextProviders[providerId] = entry;
  else delete nextProviders[providerId];
  return { ...config, providers: nextProviders };
}

/**
 * Normalize a drafted `models[]` definition. Unlike an override patch, a
 * definition's `cost` is all-or-nothing in the schema — a partial one fails
 * the whole file — and an empty `name` is rejected, so both are completed or
 * dropped rather than written as typed.
 */
export function toModelDefinition(entry: ModelEntry): ModelEntry {
  const next: ModelEntry = { ...entry };
  const name = entry.name?.trim();
  if (name) next.name = name;
  else delete next.name;

  const { input, output, cacheRead, cacheWrite } = entry.cost ?? {};
  if (input === undefined && output === undefined) delete next.cost;
  else next.cost = { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
  return next;
}
