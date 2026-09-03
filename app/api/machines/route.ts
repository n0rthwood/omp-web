import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import type { SafeMachine, UserVisibleMachine } from "@/lib/api-types";
import {
  MachineValidationError,
  createMachine,
  listSafeMachines,
  toSafeMachine,
  toUserVisibleMachine,
  type MachineAuthMode,
  type MachineInput,
} from "@/lib/machines/machine-store";
import { grantedMachineIds } from "@/lib/machines/machine-grants";
import { FLEET_CONFIGURATION_DENIED_MESSAGE, isFleetConfigurationAllowed } from "@/lib/machines/fleet-gate";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import { jsonError, readJsonBody, requireAdminApi } from "../web-users/_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const AUTH_MODES: Record<string, MachineAuthMode> = {
  bearer: "bearer",
  basic: "basic",
  none: "none",
};

// GET /api/machines — list machines (local first). Admin sees the full safe
// projection; a user role sees only granted machines (+local), slimmed of
// baseUrl/headerNames (`lib/api-types.ts#UserVisibleMachine`).
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return jsonError(403, "Untrusted API request");
  const user = await getWebUserOrSynthetic(req);
  if (!user) return jsonError(401, "Authentication required");

  if (user.role === "admin") {
    const machines: SafeMachine[] = listSafeMachines();
    return NextResponse.json({ machines }, { headers: NO_STORE });
  }

  const granted = new Set(grantedMachineIds(user));
  const machines: UserVisibleMachine[] = listSafeMachines()
    .filter((machine) => granted.has(machine.id))
    .map(toUserVisibleMachine);
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

  const { id, name, baseUrl, fallbackUrls, authMode, token, username, headers } = body;
  const parsedAuthMode = typeof authMode === "string" ? AUTH_MODES[authMode] : undefined;
  if (!parsedAuthMode) {
    return jsonError(400, "authMode must be \"bearer\", \"basic\" or \"none\"");
  }
  if (typeof name !== "string") return jsonError(400, "name is required");
  if (typeof baseUrl !== "string") return jsonError(400, "baseUrl is required");
  if (id !== undefined && typeof id !== "string") return jsonError(400, "id must be a string");
  if (
    fallbackUrls !== undefined &&
    (!Array.isArray(fallbackUrls) || fallbackUrls.some((entry) => typeof entry !== "string"))
  ) {
    return jsonError(400, "fallbackUrls must be an array of strings");
  }
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
    ...(Array.isArray(fallbackUrls) ? { fallbackUrls: fallbackUrls as string[] } : {}),
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
