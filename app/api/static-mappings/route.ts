import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { getStaticPublicMachineId, listStaticMappings, createStaticMapping, staticMappingResponse, StaticMappingError, LOCAL_STATIC_MACHINE_ID } from "@/lib/static-mapping-store";
import { parseStaticMappingCreateInput } from "@/lib/static-mapping-http";
import { jsonError, readJsonBody, requireMachineGrant } from "@/app/api/web-users/_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function requireLocalStaticAccess(request: Request): Promise<NextResponse | null> {
  // The local synthetic machine is always the guard target. The configured
  // public identity is an alias for this process, not a registry machine.
  return requireMachineGrant(request, LOCAL_STATIC_MACHINE_ID, "/api/static-mappings");
}

export async function GET(request: Request) {
  const denied = await requireLocalStaticAccess(request);
  if (denied) return denied;
  const mappings = listStaticMappings().map(staticMappingResponse);
  return NextResponse.json(
    { machineId: getStaticPublicMachineId(), mappings },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const denied = await requireLocalStaticAccess(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return jsonError(415, "Content-Type must be application/json");
  const body = await readJsonBody(request);
  if (!body || Array.isArray(body)) return jsonError(400, "Invalid JSON body");

  try {
    const mapping = staticMappingResponse(createStaticMapping(parseStaticMappingCreateInput(body)));
    return NextResponse.json(
      { mapping, writeDir: mapping.writeDir, publicPath: mapping.publicPath },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof StaticMappingError) return jsonError(error.status, error.message);
    console.error("static mapping create failed", error);
    return jsonError(500, "Unable to create static mapping");
  }
}
