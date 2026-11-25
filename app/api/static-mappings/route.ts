import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { getStaticPublicMachineId, listStaticMappings, createStaticMapping, resolveStaticProjectRoot, staticMappingResponse, isStaticMappingError, LOCAL_STATIC_MACHINE_ID } from "@/lib/static-mapping-store";
import { parseStaticMappingCreateInput } from "@/lib/static-mapping-http";
import { canManageStaticMapping, filterVisibleStaticMappings } from "@/lib/static-mapping-visibility";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
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
  // Discovery is project-aware (issue #136): non-admins see only rows whose
  // registered projectRoot is visible; historical rows stay admin-only.
  // requireMachineGrant guarantees an identity here (synthetic admin when
  // auth is disabled).
  const user = await getWebUserOrSynthetic(request);
  if (!user) return jsonError(401, "Authentication required");
  const mappings = filterVisibleStaticMappings(user, listStaticMappings())
    .map(staticMappingResponse)
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      const va = Number.isFinite(ta) ? ta : null;
      const vb = Number.isFinite(tb) ? tb : null;
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return vb - va;
    });
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
    const parsed = parseStaticMappingCreateInput(body);
    const input = { ...parsed, projectRoot: await resolveStaticProjectRoot(parsed.projectRoot) };
    // Registration is project-gated too: a non-admin may only register under
    // a root they can see, so they can never create an undiscoverable row.
    const user = await getWebUserOrSynthetic(request);
    if (!user) return jsonError(401, "Authentication required");
    if (!canManageStaticMapping(user, input)) {
      return NextResponse.json(
        { error: "No permission for this project", field: "projectRoot" },
        { status: 403, headers: NO_STORE },
      );
    }
    const mapping = staticMappingResponse(createStaticMapping(input));
    return NextResponse.json(
      { mapping, writeDir: mapping.writeDir, publicPath: mapping.publicPath },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    if (isStaticMappingError(error)) {
      return NextResponse.json(
        { error: error.message, ...(error.field ? { field: error.field } : {}) },
        { status: error.status, headers: NO_STORE },
      );
    }
    console.error("static mapping create failed", error);
    return jsonError(500, "Unable to create static mapping");
  }
}
