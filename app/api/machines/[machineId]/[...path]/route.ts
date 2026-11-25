import { NextResponse } from "next/server";
import {
  LOCAL_MACHINE_ID,
  getMachine,
} from "@/lib/machines/machine-store";
import { isProxyablePath, proxyToMachine } from "@/lib/machines/remote-request";
import { enforceStaticDocumentPolicy } from "@/lib/static-mapping-content";
import {
  applySessionListVisibilityFilter,
  isSessionListProxyPath,
  applyStaticMappingListVisibilityFilter,
  isStaticMappingListProxyPath,
  applyStaticMappingItemVisibilityFilter,
  isStaticMappingItemReadProxyPath,
  isStaticMappingMutationProxyPath,
  isStaticMappingCreateProxyPath,
  staticMappingMutationGate,
} from "@/lib/machines/proxy-response-filter";
import { canManageStaticMapping } from "@/lib/static-mapping-visibility";
import { parseStaticMappingCreateInput } from "@/lib/static-mapping-http";
import { resolveStaticProjectRoot, isStaticMappingError } from "@/lib/static-mapping-store";
import { getWebUserOrSynthetic, type WebUser } from "@/lib/web-auth-context";
import { jsonError, requireMachineGrant } from "../../../web-users/_guard";

interface RouteContext {
  params: Promise<{ machineId: string; path: string[] }>;
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Issue #136: a machine-granted non-admin must not create a remote mapping
 * outside their visible project grants. The remote runs under the machine
 * credential, so the gateway parses and normalizes the requested
 * `projectRoot`, rejects an invisible root before anything is forwarded, and
 * forwards the normalized root. Admins (and the auth-disabled synthetic
 * admin) keep the existing pass-through behavior — the remote normalizes the
 * root on its side, so every path persists a canonical main-project root.
 *
 * Returns a rejection response, or a rewritten request to forward.
 */
async function gateStaticMappingCreate(
  req: Request,
  user: WebUser,
): Promise<{ denied: NextResponse } | { forward: Request }> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { denied: jsonError(400, "Invalid JSON body") };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return { denied: jsonError(400, "Invalid JSON body") };
  }

  let projectRoot: string;
  try {
    const parsed = parseStaticMappingCreateInput(body);
    projectRoot = await resolveStaticProjectRoot(parsed.projectRoot);
  } catch (error) {
    if (isStaticMappingError(error)) {
      return {
        denied: NextResponse.json(
          { error: error.message, ...(error.field ? { field: error.field } : {}) },
          { status: error.status, headers: NO_STORE },
        ),
      };
    }
    throw error;
  }

  if (!canManageStaticMapping(user, { projectRoot })) {
    return {
      denied: NextResponse.json(
        { error: "No permission for this project", field: "projectRoot" },
        { status: 403, headers: NO_STORE },
      ),
    };
  }

  // Forward the normalized root so the persisted row is canonical regardless
  // of what the remote's own normalization would produce. Cookie and
  // authorization headers are dropped by the transport allow-list.
  const forwardBody = JSON.stringify({ ...body, projectRoot });
  const forward = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: forwardBody,
    signal: req.signal,
  });
  return { forward };
}

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
  let forwardReq = req;

  // Issue #136: proxied create is project-gated before anything is forwarded
  // — the remote runs under the machine credential, so the signed-in user's
  // grants must be applied here and the normalized root forwarded.
  if (isStaticMappingCreateProxyPath(req.method, remotePathname)) {
    const user = await getWebUserOrSynthetic(req);
    if (user && user.role !== "admin") {
      const gated = await gateStaticMappingCreate(req, user);
      if ("denied" in gated) return gated.denied;
      forwardReq = gated.forward;
    }
  }

  // Issue #136: proxied item mutations are project-gated before anything is
  // forwarded — the remote runs under the machine credential, so the
  // signed-in user's grants must be applied here.
  if (isStaticMappingMutationProxyPath(req.method, remotePathname)) {
    const user = await getWebUserOrSynthetic(req);
    if (user) {
      const rowPath = `/api/static-mappings/${encodeURIComponent(path[2])}`;
      const denied = await staticMappingMutationGate(user, () => {
        const probe = new Request(req.url, { method: "GET", headers: { accept: "application/json" }, signal: req.signal });
        return proxyToMachine(machine, probe, rowPath, "");
      });
      if (denied) return denied;
    }
  }

  const proxied = await proxyToMachine(machine, forwardReq, remotePathname, search);
  const response = remotePathname.startsWith("/api/static/")
    ? enforceStaticDocumentPolicy(proxied)
    : proxied;
  if (isSessionListProxyPath(req.method, remotePathname)) {
    const user = await getWebUserOrSynthetic(req);
    if (user) return applySessionListVisibilityFilter(user, response);
  }
  if (isStaticMappingListProxyPath(req.method, remotePathname) || isStaticMappingItemReadProxyPath(req.method, remotePathname)) {
    const user = await getWebUserOrSynthetic(req);
    if (user) {
      return isStaticMappingListProxyPath(req.method, remotePathname)
        ? applyStaticMappingListVisibilityFilter(user, response)
        : applyStaticMappingItemVisibilityFilter(user, response);
    }
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