import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import type { SafeMachine } from "@/lib/api-types";
import {
  MachineValidationError,
  createMachine,
  listSafeMachines,
  toSafeMachine,
  type MachineAuthMode,
  type MachineInput,
} from "@/lib/machines/machine-store";
import { FLEET_CONFIGURATION_DENIED_MESSAGE, isFleetConfigurationAllowed } from "@/lib/machines/fleet-gate";
import { jsonError, readJsonBody, requireAdminApi } from "../web-users/_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const AUTH_MODES: Record<string, MachineAuthMode> = {
  bearer: "bearer",
  basic: "basic",
  none: "none",
};

// GET /api/machines — list machines (safe fields only; local first)
export async function GET(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  const machines: SafeMachine[] = listSafeMachines();
  return NextResponse.json({ machines }, { headers: NO_STORE });
}

// POST /api/machines  body: { id?, name, baseUrl, authMode, token?, username?, headers? }
export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!isFleetConfigurationAllowed()) return jsonError(403, FLEET_CONFIGURATION_DENIED_MESSAGE);
  if (!hasJsonContentType(req)) {
    return jsonError(415, "Content-Type must be application/json");
  }

  const body = await readJsonBody(req);
  if (!body) return jsonError(400, "Invalid JSON body");

  const { id, name, baseUrl, authMode, token, username, headers } = body;
  const parsedAuthMode = typeof authMode === "string" ? AUTH_MODES[authMode] : undefined;
  if (!parsedAuthMode) {
    return jsonError(400, "authMode must be \"bearer\", \"basic\" or \"none\"");
  }
  if (typeof name !== "string") return jsonError(400, "name is required");
  if (typeof baseUrl !== "string") return jsonError(400, "baseUrl is required");
  if (id !== undefined && typeof id !== "string") return jsonError(400, "id must be a string");
  if (token !== undefined && token !== null && typeof token !== "string") {
    return jsonError(400, "token must be a string");
  }
  if (username !== undefined && username !== null && typeof username !== "string") {
    return jsonError(400, "username must be a string");
  }
  if (headers !== undefined && (typeof headers !== "object" || headers === null)) {
    return jsonError(400, "headers must be an object");
  }

  const input: MachineInput = {
    name,
    baseUrl,
    authMode: parsedAuthMode,
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof token === "string" ? { token } : {}),
    ...(typeof username === "string" ? { username } : {}),
    ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
  };

  try {
    const machine = createMachine(input);
    return NextResponse.json(toSafeMachine(machine), { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof MachineValidationError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400, headers: NO_STORE });
    }
    return jsonError(500, "Failed to create machine");
  }
}
