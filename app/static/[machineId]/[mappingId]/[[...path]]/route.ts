import {
  isLocalStaticMachineId,
  LOCAL_STATIC_MACHINE_ID,
  isStaticMappingError,
  validateStaticAssetSegments,
  validateStaticMappingId,
} from "@/lib/static-mapping-store";
import { getMachine } from "@/lib/machines/machine-store";
import { enforceStaticDocumentPolicy, serveStaticMappingRequest } from "@/lib/static-mapping-content";
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
  // segments; it resolves to index.html/index.htm in the shared resolver, and
  // any other path falls back to `.html`/`.htm`/`<dir>/index.*` there too.
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
    if (isStaticMappingError(error)) return jsonError(error.status, error.message);
    return jsonError(400, "Invalid static path");
  }

  if (local) {
    return serveStaticMappingRequest(
      request,
      mappingId,
      path,
      `/static/${encodedPathSegment(machineId)}/${encodedPathSegment(mappingId)}`,
    );
  }

  const machine = getMachine(machineId);
  if (!machine) return jsonError(404, "Machine not found");
  const remotePathname = `/api/static/${encodedPathSegment(mappingId)}${path.length ? `/${path.map(encodedPathSegment).join("/")}` : ""}`;
  if (!isProxyablePath(request.method, remotePathname)) return jsonError(403, "Proxy path not allowed");
  const response = await proxyToMachine(machine, request, remotePathname, new URL(request.url).search);
  return publicStaticRedirect(response, machineId, mappingId);
}

/**
 * A remote instance canonicalizes its own URLs as `/api/static/<id>/…`, but the
 * browser only knows `/static/<machine>/<id>/…`. Rewrite that prefix so the
 * directory redirect works across the fleet proxy instead of pointing at an
 * internal path the browser cannot reach.
 */
function publicStaticRedirect(response: Response, machineId: string, mappingId: string): Response {
  const location = response.headers.get("location");
  const remotePrefix = `/api/static/${encodedPathSegment(mappingId)}/`;
  if (
    !location
    || !location.startsWith(remotePrefix)
    || (response.status !== 302 && response.status !== 307 && response.status !== 308)
  ) {
    return enforceStaticDocumentPolicy(response);
  }
  const headers = new Headers(response.headers);
  const target = location.slice("/api/static".length);
  headers.set("location", `/static/${encodedPathSegment(machineId)}${target}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


