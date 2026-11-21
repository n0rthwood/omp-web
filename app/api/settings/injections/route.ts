import { NextResponse } from "next/server";
import { requireAdminApi } from "@/app/api/web-users/_guard";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { applyInjectionSetting, InjectionSettingError, readInjectionSettings } from "@/lib/injection-settings";
import type { InjectionSettingPatch } from "@/lib/settings-api";

export const dynamic = "force-dynamic";

// #116: injection switches. Admin-only through the `/api/settings` prefix
// (lib/admin-api-policy.ts); proxied to remotes via proxy-allowlist.ts.

async function validateCwd(cwd: unknown): Promise<string | null> {
  if (cwd === undefined || cwd === null || cwd === "") return null;
  if (typeof cwd !== "string") throw new InjectionSettingError("Invalid cwd");
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) throw new Error("Access denied");
  return cwd;
}

function errorResponse(error: unknown, fallbackStatus: number) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message === "Access denied" ? 403 : error instanceof InjectionSettingError ? 400 : fallbackStatus;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  try {
    const cwd = await validateCwd(new URL(req.url).searchParams.get("cwd"));
    return NextResponse.json(await readInjectionSettings(cwd));
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function PATCH(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  try {
    const body = await req.json() as Partial<InjectionSettingPatch>;
    if (typeof body.path !== "string") throw new InjectionSettingError("Unknown setting");
    const cwd = await validateCwd(body.cwd);
    const result = await applyInjectionSetting(body as InjectionSettingPatch, cwd);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
