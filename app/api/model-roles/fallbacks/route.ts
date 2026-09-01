import { NextResponse } from "next/server";
import { resolve } from "path";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import {
  checkFallbackChainEntries,
  collectFallbackChainWarnings,
  listModelRoles,
  listRoleFallbackChains,
  writeRoleFallbackChain,
} from "@/lib/model-roles";
import { resolveVisibleModels } from "@/lib/model-scope";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * PUT /api/model-roles/fallbacks  body: { cwd, role, chain }
 *
 * Writes one role's backup models into omp's `retry.fallbackChains`, the same
 * record the TUI reads, so a chain configured here is what the next terminal
 * session fails over to.
 *
 * `chain: null` removes the role's key so the `default` chain covers it again.
 * `chain: []` persists an explicitly empty chain, which omp reads as "this role
 * has no backups" — deliberately different from an absent key.
 *
 * Global only. `retry.*` has no project layer in omp, and inventing one here
 * would produce a chain the TUI never applies.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { cwd?: string; role?: string; chain?: unknown };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    const cwd = resolve(body.cwd);
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const role = body.role?.trim();
    if (!role) return NextResponse.json({ error: "role required" }, { status: 400 });

    let chain: string[] | null;
    if (body.chain === null || body.chain === undefined) {
      chain = null;
    } else if (Array.isArray(body.chain) && body.chain.every((e) => typeof e === "string")) {
      chain = body.chain.map((entry) => entry.trim()).filter(Boolean);
    } else {
      return NextResponse.json({ error: "chain must be an array of selectors, or null" }, { status: 400 });
    }

    const runtime = await getOmpRuntime();
    const { modelRegistry } = runtime;

    // Reject before persisting: a chain omp cannot route to is worse than no
    // chain, because failover silently skips it at the moment it is needed.
    if (chain) {
      const problems = checkFallbackChainEntries(chain, modelRegistry);
      if (problems.length > 0) {
        return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
      }
    }

    // `retry.fallbackChains` lives in the global layer, so it is written through
    // the canonical process-wide Settings — the same instance every live session
    // reads, which is why no runtime invalidation is needed for it to take hold.
    writeRoleFallbackChain(runtime.settings, role, chain);
    await runtime.settings.flush();
    invalidateModelsCache();

    const settings = await getSettingsForCwd(cwd);
    const { visible } = await resolveVisibleModels(modelRegistry, settings.get("enabledModels"), settings);
    return NextResponse.json({
      roles: listModelRoles(settings, [...visible]),
      fallbackChains: listRoleFallbackChains(settings),
      fallbackWarnings: collectFallbackChainWarnings(settings, modelRegistry),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
