/**
 * Structured diff between two snapshots of one provider's model list.
 *
 * The Models panel used to report a refresh as a bare "success", so a provider
 * that silently dropped a model or changed a context window looked identical to
 * one that did nothing. `POST /api/models-config/refresh-provider` snapshots the
 * registry before and after the refresh and returns this shape, which the panel
 * renders as added / removed / parameter-changed rows.
 *
 * Pure and dependency-free so the route and the tests share one definition.
 */

/** The subset of a registry model the diff compares. */
export interface ModelSnapshot {
  id: string;
  name?: string;
  contextWindow?: number | null;
  maxTokens?: number | null;
  input?: readonly string[];
  reasoning?: boolean;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null;
}

export interface ModelDiffFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ModelDiffChange {
  id: string;
  fields: ModelDiffFieldChange[];
}

export interface ProviderModelDiff {
  added: { id: string; name: string }[];
  removed: { id: string; name: string }[];
  changed: ModelDiffChange[];
}

/** Fields compared for a model that exists on both sides of the refresh. */
const COMPARED_FIELDS = [
  "name",
  "contextWindow",
  "maxTokens",
  "input",
  "reasoning",
  "cost",
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

/** Stable string form so `undefined`, absent, and empty stay distinguishable. */
function comparable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(comparable).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${key}:${comparable(entry)}`).join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function indexById(models: readonly ModelSnapshot[]): Map<string, ModelSnapshot> {
  const byId = new Map<string, ModelSnapshot>();
  for (const model of models) byId.set(model.id, model);
  return byId;
}

/**
 * Compare the same provider's models before and after a refresh.
 *
 * `added`/`removed` carry the display name so the panel can show something
 * human-readable without a second lookup; `changed` reports only the fields
 * that actually differ, in `COMPARED_FIELDS` order.
 */
export function diffProviderModels(
  before: readonly ModelSnapshot[],
  after: readonly ModelSnapshot[],
): ProviderModelDiff {
  const beforeById = indexById(before);
  const afterById = indexById(after);

  const added: { id: string; name: string }[] = [];
  for (const model of after) {
    if (!beforeById.has(model.id)) added.push({ id: model.id, name: model.name?.trim() || model.id });
  }

  const removed: { id: string; name: string }[] = [];
  for (const model of before) {
    if (!afterById.has(model.id)) removed.push({ id: model.id, name: model.name?.trim() || model.id });
  }

  const changed: ModelDiffChange[] = [];
  for (const model of after) {
    const previous = beforeById.get(model.id);
    if (!previous) continue;
    const fields: ModelDiffFieldChange[] = [];
    for (const field of COMPARED_FIELDS) {
      const beforeValue = previous[field as ComparedField];
      const afterValue = model[field as ComparedField];
      if (comparable(beforeValue) === comparable(afterValue)) continue;
      fields.push({
        field,
        before: beforeValue === undefined ? null : beforeValue,
        after: afterValue === undefined ? null : afterValue,
      });
    }
    if (fields.length > 0) changed.push({ id: model.id, fields });
  }

  return { added, removed, changed };
}

/** True when the refresh actually changed anything worth showing. */
export function hasModelDiff(diff: ProviderModelDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}