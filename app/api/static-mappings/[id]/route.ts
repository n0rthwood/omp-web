import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import {
  getStaticMapping,
  LOCAL_STATIC_MACHINE_ID,
  revokeStaticMapping,
  staticMappingResponse,
  StaticMappingError,
  updateStaticMapping,
} from "@/lib/static-mapping-store";
import { parseStaticMappingPatchInput } from "@/lib/static-mapping-http";
import { jsonError, readJsonBody, requireMachineGrant } from "@/app/api/web-users/_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function requireLocalStaticAccess(request: Request): Promise<NextResponse | null> {
  return requireMachineGrant(request, LOCAL_STATIC_MACHINE_ID, "/api/static-mappings/item");
}

export async function GET(request: Request, context: RouteContext) {
  const denied = await requireLocalStaticAccess(request);
  if (denied) return denied;
  const { id } = await context.params;
  try {
    const mapping = getStaticMapping(id);
    if (!mapping) return jsonError(404, "Static mapping not found");
    const response = staticMappingResponse(mapping);
    return NextResponse.json(
      { mapping: response, writeDir: response.writeDir, publicPath: response.publicPath },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof StaticMappingError) return jsonError(error.status, error.message);
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
    const mapping = updateStaticMapping(id, parseStaticMappingPatchInput(body));
    if (!mapping) return jsonError(404, "Static mapping not found");
    const response = staticMappingResponse(mapping);
    return NextResponse.json(
      { mapping: response, writeDir: response.writeDir, publicPath: response.publicPath },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof StaticMappingError) {
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
    if (error instanceof StaticMappingError) return jsonError(error.status, error.message);
    console.error("static mapping revoke failed", error);
    return jsonError(500, "Unable to revoke static mapping");
  }
}
