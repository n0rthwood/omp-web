import { stat } from "fs/promises";
import { resolve } from "path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelCatalogEntry,
  type ModelHealth,
  type ModelsData,
} from "@/lib/models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { getOmpSetting } from "@/lib/omp-setting-access";
import { listModelRoles, readDefaultModelRole } from "@/lib/model-roles";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import { ensureModelsHealthSnapshot, refreshModelsFreshness } from "@/lib/models-health";

export const dynamic = "force-dynamic";

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string }
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

/**
 * Catalog facts of one registry row (#144). A `null` window means the
 * catalog does not know it, so it is left out instead of being sent as 0.
 */
function toCatalogEntry(model: Model<Api>): ModelCatalogEntry {
  const { id, name, provider, input, reasoning, cost, contextWindow, maxTokens } = model;
  return {
    id,
    name,
    provider,
    input: [...input],
    reasoning,
    cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite },
    ...(contextWindow !== null ? { contextWindow } : {}),
    ...(maxTokens !== null ? { maxTokens } : {}),
  };
}

async function loadModels(cwd: string | undefined, includeHidden = false): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};

  const runtime = await getOmpRuntime();
  const { modelRegistry } = runtime;
  // External changes (CLI login/logout, a credential disabled by a failed
  // OAuth refresh, a hand-edited models.yml) must be visible on the next
  // request, not after a web-tier restart (#139). Both calls are incremental:
  // a `data_version` read plus a models.yml mtime check.
  await refreshModelsFreshness(runtime);
  const settings = await getSettingsForCwd(cwd);
  const modelError = modelRegistry.getError()?.message;
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally. The
  // allow-list picker asks for `?all=1`: it must offer every configured model
  // (including ones the current scope hides), otherwise a pattern that would
  // widen the scope can never be discovered (#140).
  const scoped = includeHidden
    ? null
    : await resolveVisibleModels(modelRegistry, getOmpSetting(settings, "enabledModels"), settings);
  const visible = scoped ? scoped.visible : modelRegistry.getAvailable();
  const thinkingLevelPins = scoped?.thinkingLevelPins ?? {};
  const warnings = scoped?.warnings ?? [];
  const modelList = visible.map(toCatalogEntry).sort(compareModelEntries);
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = [...getSupportedEfforts(m)];
  }

  const defaultRole = readDefaultModelRole(settings, visible);
  const initial = selectInitialModelScope({ visible, scopedModels: scoped?.scopedModels ?? [], thinkingLevelPins, warnings }, {
    ...(defaultRole ? { defaultModel: defaultRole } : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }

  // omp assigns a model per scope of work; ship the whole role table so the
  // browser's selector can group models the same way `/model` does.
  const roles = listModelRoles(settings, [...visible]);

  // A scoped install silently hides every model the allow-list omits, which is
  // how a configured provider can vanish from the picker with no signal (#111).
  // Report the shortfall so the composer can say so; say nothing when no scope
  // is in effect, where "0 hidden" would be misleading noise.
  const hiddenModelCount = scoped && scoped.scopedModels.length > 0
    ? modelRegistry.getAvailable().length - visible.length
    : undefined;

  // Per-model credential health for the health bar (#139). Only the models
  // this response actually lists are copied, so the payload stays proportional
  // to the picker. Absent when the first scan has not produced a snapshot.
  const health = await ensureModelsHealthSnapshot();
  const modelHealth: Record<string, ModelHealth> = {};
  if (health) {
    for (const m of visible) {
      const entry = health.modelHealth[`${m.provider}/${m.id}`];
      if (entry) modelHealth[`${m.provider}/${m.id}`] = entry;
    }
  }

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      thinkingLevels,
      thinkingLevelMaps: {},
      thinkingLevelPins,
      roles,
      ...(hiddenModelCount !== undefined ? { hiddenModelCount } : {}),
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
      ...(Object.keys(modelHealth).length > 0 ? { modelHealth } : {}),
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
  roles: [],
};

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const includeHidden = params.get("all") === "1";
  const requestedCwd = params.get("cwd");
  // `?all=1` is a catalog read (allow-list picker, provider tables), not a
  // scope decision. With no `cwd` to scope it, it reads the default settings
  // and needs no directory access check: falling back to the server's own
  // working directory instead turned every project-less request into a 403
  // and left the provider table empty (#144).
  const unscoped = includeHidden && !requestedCwd;
  const cwd = unscoped ? null : resolve(requestedCwd || process.cwd());

  if (cwd) {
    let cwdStat;
    try {
      cwdStat = await stat(cwd);
    } catch {
      return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }
    if (!cwdStat.isDirectory()) {
      return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }
  }

  try {
    // The unfiltered list is a picker input, not a scope decision: it is never
    // cached, so a freshly added provider shows up immediately.
    const data = cwd === null
      ? await loadModels(undefined, true)
      : includeHidden
        ? await loadModels(cwd, true)
        : await loadModelsWithCache(cwd, () => loadModels(cwd));
    return Response.json(data);
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
