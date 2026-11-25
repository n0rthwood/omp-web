import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import {
  getStaticMapping,
  LOCAL_STATIC_MACHINE_ID,
  revokeStaticMapping,
  staticMappingResponse,
  isStaticMappingError,
  updateStaticMapping,
  type StaticMappingRecord,
} from "@/lib/static-mapping-store";
import { parseStaticMappingPatchInput } from "@/lib/static-mapping-http";
import { canManageStaticMapping } from "@/lib/static-mapping-visibility";
import { getWebUserOrSynthetic, type WebUser } from "@/lib/web-auth-context";
import { jsonError, readJsonBody, requireMachineGrant } from "@/app/api/web-users/_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function requireLocalStaticAccess(request: Request): Promise<NextResponse | null> {
  return requireMachineGrant(request, LOCAL_STATIC_MACHINE_ID, "/api/static-mappings/item");
}

/**
 * Project-matched management gate (issue #136): non-admin discovery and
 * update/revoke require the mapping's registered projectRoot to be visible;
 * historical rows without a project key stay admin-only. Admins keep full
 * access. A hidden mapping reads as 404 so its existence is not confirmed.
 */
async function requireStaticManagementAccess(request: Request, mapping: StaticMappingRecord): Promise<NextResponse | null> {
  const user: WebUser | null = await getWebUserOrSynthetic(request);
  if (!user) return jsonError(401, "Authentication required");
  if (!canManageStaticMapping(user, mapping)) return jsonError(404, "Static mapping not found");
  return null;
}

export async function GET(request: Request, context: RouteContext) {
  const denied = await requireLocalStaticAccess(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const mapping = getStaticMapping(id);
    if (!mapping) return jsonError(404, "Static mapping not found");
    const hidden = await requireStaticManagementAccess(request, mapping);
    if (hidden) return hidden;
    const response = staticMappingResponse(mapping);
    return NextResponse.json(
      { mapping: response, writeDir: response.writeDir, publicPath: response.publicPath },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (isStaticMappingError(error)) return jsonError(error.status, error.message);
    console.error("static mapping read failed", error);
    return jsonError(500, "Unable to read static mapping");
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const denied = await requireLocalStaticAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return jsonError(415, "Content-Type must be application/json");
  const body = await readJsonBody(request);
  if (!body || Array.isArray(body)) return jsonError(400, "Invalid JSON body");
  const { id } = await context.params;

  try {
    const current = getStaticMapping(id);
    if (!current) return jsonError(404, "Static mapping not found");
    const hidden = await requireStaticManagementAccess(request, current);
    if (hidden) return hidden;
    const mapping = updateStaticMapping(id, parseStaticMappingPatchInput(body));
    if (!mapping) return jsonError(404, "Static mapping not found");
    const response = staticMappingResponse(mapping);
    return NextResponse.json(
      { mapping: response, writeDir: response.writeDir, publicPath: response.publicPath },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (isStaticMappingError(error)) {
      return NextResponse.json(
        { error: error.message, ...(error.field ? { field: error.field } : {}) },
        { status: error.status, headers: NO_STORE },
      );
    }
    console.error("static mapping update failed", error);
    return jsonError(500, "Unable to update static mapping");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const denied = await requireLocalStaticAccess(request);
  if (denied) return denied;
  const { id } = await context.params;
  const rawContent = new URL(request.url).searchParams.get("content") ?? "retain";
  if (rawContent !== "delete" && rawContent !== "retain") {
    return jsonError(400, "content must be delete or retain");
  }

  try {
    const current = getStaticMapping(id);
    if (!current) return jsonError(404, "Static mapping not found");
    const hidden = await requireStaticManagementAccess(request, current);
    if (hidden) return hidden;
    const result = revokeStaticMapping(id, rawContent);
    if (!result) return jsonError(404, "Static mapping not found");
    const response = staticMappingResponse(result.mapping);
    return NextResponse.json({
      ok: true,
      id,
      contentDeleted: result.contentDeleted,
      mapping: response,
      writeDir: response.writeDir,
      publicPath: response.publicPath,
    }, { headers: NO_STORE });
  } catch (error) {
    if (isStaticMappingError(error)) return jsonError(error.status, error.message);
    console.error("static mapping revoke failed", error);
    return jsonError(500, "Unable to revoke static mapping");
  }
}
