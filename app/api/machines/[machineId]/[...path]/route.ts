import { NextResponse } from "next/server";
import {
  LOCAL_MACHINE_ID,
  getMachine,
} from "@/lib/machines/machine-store";
import { isProxyablePath, proxyToMachine } from "@/lib/machines/remote-request";
import { jsonError, requireAdminApi } from "../../../web-users/_guard";

interface RouteContext {
  params: Promise<{ machineId: string; path: string[] }>;
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The catch-all fleet proxy: `/api/machines/<id>/api/...` is forwarded to
 * machine `<id>`'s `/api/...`. Everything else about the shape (first segment
 * must be `api`, allow-list, unknown machine, `local`) is handled here so the
 * transport logic in `lib/machines/remote-request.ts` stays pure.
 */
async function handle(req: Request, context: RouteContext): Promise<NextResponse | Response> {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  const { machineId, path } = await context.params;
  if (path.length === 0 || path[0] !== "api") {
    return jsonError(404, "Not found");
  }
  if (machineId === LOCAL_MACHINE_ID) {
    return jsonError(400, "Cannot proxy to the local machine");
  }
  const machine = getMachine(machineId);
  if (!machine) return jsonError(404, "Machine not found");

  // Reconstruct the remote pathname, re-encoding each decoded segment.
  const remotePathname = `/${path.map(encodeURIComponent).join("/")}`;
  if (!isProxyablePath(req.method, remotePathname)) {
    return NextResponse.json(
      { error: "Proxy path not allowed" },
      { status: 403, headers: NO_STORE },
    );
  }

  const search = new URL(req.url).search;
  return proxyToMachine(machine, req, remotePathname, search);
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
