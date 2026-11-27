import { LOCAL_STATIC_MACHINE_ID } from "@/lib/static-mapping-store";
import { serveStaticMappingRequest } from "@/lib/static-mapping-content";
import { requireMachineGrant } from "@/app/api/web-users/_guard";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ mappingId: string; path?: string[] }>;
}

export async function GET(request: Request, context: RouteContext) {
  const { mappingId, path } = await context.params;
  const denied = await requireMachineGrant(request, LOCAL_STATIC_MACHINE_ID, `/api/static/${mappingId}`);
  if (denied) return denied;
  // Bare mapping URLs and directory paths redirect to their index document so
  // the browser's base URL is the page file; the fleet proxy rewrites the
  // `/api/static` prefix of that Location to the public `/static` path.
  return serveStaticMappingRequest(
    request,
    mappingId,
    path ?? [],
    `/api/static/${encodeURIComponent(mappingId)}`,
  );
}
