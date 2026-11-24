import {
  isLocalStaticMachineId,
  LOCAL_STATIC_MACHINE_ID,
  StaticMappingError,
  validateStaticAssetSegments,
  validateStaticMappingId,
} from "@/lib/static-mapping-store";
import { getMachine } from "@/lib/machines/machine-store";
import { enforceStaticDocumentPolicy, serveStaticMappingFile } from "@/lib/static-mapping-content";
import { isProxyablePath, proxyToMachine } from "@/lib/machines/remote-request";
import { jsonError, requireMachineGrant } from "@/app/api/web-users/_guard";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ machineId: string; mappingId: string; path?: string[] }>;
}

function encodedPathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

export async function GET(request: Request, context: RouteContext) {
  const { machineId, mappingId, path: rawPath } = await context.params;
  // A bare mapping URL (`/static/<machine>/<mapping>`) carries no catch-all
  // segments; it resolves to index.html/index.htm in the shared resolver.
  const path = rawPath ?? [];
  const local = isLocalStaticMachineId(machineId);
  const denied = await requireMachineGrant(
    request,
    local ? LOCAL_STATIC_MACHINE_ID : machineId,
    `/api/static/${mappingId}${path.length ? `/${path.join("/")}` : ""}`,
  );
  if (denied) return denied;

  try {
    validateStaticMappingId(mappingId);
    validateStaticAssetSegments(path);
  } catch (error) {
    if (error instanceof StaticMappingError) return jsonError(error.status, error.message);
    return jsonError(400, "Invalid static path");
  }

  if (local) return serveStaticMappingFile(request, mappingId, path);

  const machine = getMachine(machineId);
  if (!machine) return jsonError(404, "Machine not found");
  const remotePathname = `/api/static/${encodedPathSegment(mappingId)}${path.length ? `/${path.map(encodedPathSegment).join("/")}` : ""}`;
  if (!isProxyablePath(request.method, remotePathname)) return jsonError(403, "Proxy path not allowed");
  const response = await proxyToMachine(machine, request, remotePathname, new URL(request.url).search);
  return enforceStaticDocumentPolicy(response);
}


