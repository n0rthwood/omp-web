import { NextResponse } from "next/server";
import {
  LOCAL_MACHINE_ID,
  getMachine,
} from "@/lib/machines/machine-store";
import { isProxyablePath, proxyToMachine } from "@/lib/machines/remote-request";
import { applySessionListVisibilityFilter, isSessionListProxyPath } from "@/lib/machines/proxy-response-filter";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { jsonError, requireMachineGrant } from "../../../web-users/_guard";

interface RouteContext {
  params: Promise<{ machineId: string; path: string[] }>;
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The catch-all fleet proxy: `/api/machines/<id>/api/...` is forwarded to
 * machine `<id>`'s `/api/...`. `requireMachineGrant` owns admin bypass,
 * unknown-machine (404) vs ungranted-machine (403), and the inner-path
 * admin-only check; everything else about the shape (first segment must be
 * `api`, allow-list, `local`) is handled here so the transport logic in
 * `lib/machines/remote-request.ts` stays pure.
 */
async function handle(req: Request, context: RouteContext): Promise<NextResponse | Response> {
  const { machineId, path } = await context.params;
  const remotePathname = `/${path.map(encodeURIComponent).join("/")}`;

  const denied = await requireMachineGrant(req, machineId, remotePathname);
  if (denied) return denied;

  if (path.length === 0 || path[0] !== "api") {
    return jsonError(404, "Not found");
  }
  if (machineId === LOCAL_MACHINE_ID) {
    return jsonError(400, "Cannot proxy to the local machine");
  }
  const machine = getMachine(machineId);
  if (!machine) return jsonError(404, "Machine not found");

  if (!isProxyablePath(req.method, remotePathname)) {
    return NextResponse.json(
      { error: "Proxy path not allowed" },
      { status: 403, headers: NO_STORE },
    );
  }

  const search = new URL(req.url).search;
  const response = await proxyToMachine(machine, req, remotePathname, search);
  if (isSessionListProxyPath(req.method, remotePathname)) {
    const user = await getWebUserOrSynthetic(req);
    if (user) return applySessionListVisibilityFilter(user, response);
  }
  return response;
}

export async function GET(req: Request, context: RouteContext) {
  return handle(req, context);
}

export async function POST(req: Request, context: RouteContext) {
  return handle(req, context);
}

export async function PUT(req: Request, context: RouteContext) {
  return handle(req, context);
}

export async function PATCH(req: Request, context: RouteContext) {
  return handle(req, context);
}

export async function DELETE(req: Request, context: RouteContext) {
  return handle(req, context);
}
