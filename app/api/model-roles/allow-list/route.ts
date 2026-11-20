import { NextResponse } from "next/server";
import { resolve } from "path";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getOmpRuntime, getSettingsForCwd } from "@/lib/omp-runtime";
import { resolveVisibleModels } from "@/lib/model-scope";
import { getOmpSetting, setOmpSetting } from "@/lib/omp-setting-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * The `enabledModels` allow-list — which models the picker and the CLI offer.
 *
 * omp registers this setting with no `ui` metadata, so `/api/settings` refuses
 * it (`app/api/settings/route.ts` requires `ui`), and nothing in the browser
 * could read or write it. That is how a configured provider's models vanish
 * from the picker with no way to find out why, let alone fix it (#111).
 *
 * `enabledModels` is `pathScoped: { valuesKey: "models" }`, so a project's
 * `.omp/config.yml` can override the global list. Writes here are global, and
 * the response reports `projectOverride` when the effective list for `cwd`
 * differs from what was written — otherwise the panel edits a list that does
 * nothing in that project.
 */

interface AllowListPayload {
  patterns: string[];
  warnings: string[];
  projectOverride: boolean;
  globalPatterns: string[];
}

function readGlobalPatterns(settings: Awaited<ReturnType<typeof getSettingsForCwd>>): string[] {
  const patterns = getOmpSetting<string[] | undefined>(settings, "enabledModels");
  return Array.isArray(patterns) ? [...patterns] : [];
}

async function buildPayload(
  cwd: string,
  globalPatterns: string[],
): Promise<AllowListPayload> {
  const { modelRegistry } = await getOmpRuntime();
  const settings = await getSettingsForCwd(cwd);
  const effective = readGlobalPatterns(settings);
  const { warnings } = await resolveVisibleModels(modelRegistry, effective, settings);
  return {
    patterns: effective,
    warnings,
    globalPatterns,
    projectOverride: effective.join("\n") !== globalPatterns.join("\n"),
  };
}

function parsePatterns(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return { error: "patterns must be an array of strings" };
  }
  const cleaned: string[] = [];
  for (const raw of value as string[]) {
    const pattern = raw.trim();
    if (!pattern) continue;
    // A pattern with whitespace can never match a `provider/modelId`, so it is a
    // typo the user would otherwise only discover as a silent no-op.
    if (/\s/.test(pattern)) return { error: `Pattern contains whitespace: ${pattern}` };
    if (!cleaned.includes(pattern)) cleaned.push(pattern);
  }
  return cleaned;
}

async function requireAllowedCwd(rawCwd: string | null): Promise<{ cwd: string } | { error: NextResponse }> {
  if (!rawCwd) return { error: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  const cwd = resolve(rawCwd);
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

// GET /api/model-roles/allow-list?cwd=<path>
export async function GET(req: Request) {
  const result = await requireAllowedCwd(new URL(req.url).searchParams.get("cwd"));
  if ("error" in result) return result.error;

  try {
    const runtime = await getOmpRuntime();
    const globalPatterns = readGlobalPatterns(runtime.settings);
    return NextResponse.json(await buildPayload(result.cwd, globalPatterns));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// PUT /api/model-roles/allow-list  body: { cwd, patterns: string[] }
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { cwd?: string; patterns?: unknown };
    const result = await requireAllowedCwd(body.cwd ?? null);
    if ("error" in result) return result.error;

    const parsed = parsePatterns(body.patterns);
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const runtime = await getOmpRuntime();
    // Written through the canonical process-wide Settings so every live session
    // sees the list the panel just saved, exactly as the role writes do.
    setOmpSetting(runtime.settings, "enabledModels", parsed);
    await runtime.settings.flush();
    invalidateModelsCache();

    return NextResponse.json(await buildPayload(result.cwd, parsed));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}