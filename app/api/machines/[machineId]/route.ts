import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import {
  LOCAL_MACHINE_ID,
  MachineValidationError,
  deleteMachine,
  toSafeMachine,
  updateMachine,
  type MachineAuthMode,
  type MachinePatch,
} from "@/lib/machines/machine-store";
import { FLEET_CONFIGURATION_DENIED_MESSAGE, isFleetConfigurationAllowed } from "@/lib/machines/fleet-gate";
import { jsonError, readJsonBody, requireAdminApi } from "../../web-users/_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const AUTH_MODES: Record<string, MachineAuthMode> = {
  bearer: "bearer",
  basic: "basic",
  none: "none",
};

interface RouteContext {
  params: Promise<{ machineId: string }>;
}

// PATCH /api/machines/[machineId] — partial update; `token: null` clears the
// credential, omitted `token` keeps it.
export async function PATCH(req: Request, context: RouteContext) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!isFleetConfigurationAllowed()) return jsonError(403, FLEET_CONFIGURATION_DENIED_MESSAGE);
  if (!hasJsonContentType(req)) {
    return jsonError(415, "Content-Type must be application/json");
  }

  const { machineId } = await context.params;
  if (machineId === LOCAL_MACHINE_ID) {
    return jsonError(400, "The local machine cannot be modified");
  }

  const body = await readJsonBody(req);
  if (!body) return jsonError(400, "Invalid JSON body");

  const { name, baseUrl, fallbackUrls, authMode, token, username, headers } = body;
  const parsedAuthMode = typeof authMode === "string" ? AUTH_MODES[authMode] : undefined;
  if (authMode !== undefined && !parsedAuthMode) {
    return jsonError(400, "authMode must be \"bearer\", \"basic\" or \"none\"");
  }
  if (name !== undefined && typeof name !== "string") {
    return jsonError(400, "name must be a string");
  }
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    return jsonError(400, "baseUrl must be a string");
  }
  if (
    fallbackUrls !== undefined &&
    (!Array.isArray(fallbackUrls) || fallbackUrls.some((entry) => typeof entry !== "string"))
  ) {
    return jsonError(400, "fallbackUrls must be an array of strings");
  }
  if (token !== undefined && token !== null && typeof token !== "string") {
    return jsonError(400, "token must be a string or null");
  }
  if (username !== undefined && username !== null && typeof username !== "string") {
    return jsonError(400, "username must be a string or null");
  }
  if (headers !== undefined && (typeof headers !== "object" || headers === null)) {
    return jsonError(400, "headers must be an object");
  }

  const patch: MachinePatch = {};
  if (name !== undefined) patch.name = name;
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;
  if (Array.isArray(fallbackUrls)) patch.fallbackUrls = fallbackUrls as string[];
  if (parsedAuthMode !== undefined) patch.authMode = parsedAuthMode;
  if (token !== undefined) patch.token = token;
  if (username !== undefined) patch.username = username;
  if (headers !== undefined) patch.headers = headers as Record<string, string>;

  try {
    const machine = updateMachine(machineId, patch);
    if (!machine) return jsonError(404, "Machine not found");
    return NextResponse.json(toSafeMachine(machine), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof MachineValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400, headers: NO_STORE });
    }
    return jsonError(500, "Failed to update machine");
  }
}

// DELETE /api/machines/[machineId] → 204
export async function DELETE(req: Request, context: RouteContext) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;

  const { machineId } = await context.params;
  if (machineId === LOCAL_MACHINE_ID) {
    return jsonError(400, "The local machine cannot be deleted");
  }
  if (!deleteMachine(machineId)) return jsonError(404, "Machine not found");
  return new NextResponse(null, { status: 204 });
}
