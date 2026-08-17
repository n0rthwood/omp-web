import { NextResponse } from "next/server";
import { isAdminOnlyRemoteApiPath } from "@/lib/admin-api-policy";
import { isValidMachineId, LOCAL_MACHINE_ID, getMachine } from "@/lib/machines/machine-store";
import { isMachineGranted } from "@/lib/machines/machine-grants";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getWebUserOrSynthetic } from "@/lib/web-auth-context";
import type { WebUserRole } from "@/lib/web-users";

/**
 * Shared guards + input validation for every /api/web-users route handler.
 * `proxy.ts` already blocks `role: user` on this prefix — the explicit admin
 * check here is defense in depth (routes stay safe if the middleware changes).
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Trust gate + admin check. Returns a rejection response, or null to proceed. */
export async function requireAdminApi(request: Request): Promise<NextResponse | null> {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  const user = await getWebUserOrSynthetic(request);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403, headers: NO_STORE });
  }
  return null;
}

/**
 * Trust gate + auth + per-machine grant check for the fleet proxy catch-all
 * (`app/api/machines/[machineId]/[...path]/route.ts`). Distinguishes an
 * unknown machine (404) from an existing-but-ungranted one (403) on purpose
 * — machine-id existence is not treated as a secret on this fleet. `local`
 * always passes here; the route's own `machineId === LOCAL_MACHINE_ID` check
 * governs what happens next. `remotePathname` is the reconstructed inner
 * path on the remote — a granted non-admin caller still may not reach an
 * admin-only surface there (e.g. `PUT /api/models-config`).
 */
export async function requireMachineGrant(
  request: Request,
  machineId: string,
  remotePathname: string,
): Promise<NextResponse | null> {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  const user = await getWebUserOrSynthetic(request);
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: NO_STORE });
  }
  if (user.role === "admin") return null;
  if (machineId === LOCAL_MACHINE_ID) return null;
  if (!getMachine(machineId)) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404, headers: NO_STORE });
  }
  if (!isMachineGranted(user, machineId)) {
    return NextResponse.json({ error: "No permission for this machine" }, { status: 403, headers: NO_STORE });
  }
  if (isAdminOnlyRemoteApiPath(remotePathname)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403, headers: NO_STORE });
  }
  return null;
}

export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export function parseRole(value: unknown): WebUserRole | null {
  return value === "admin" || value === "user" ? value : null;
}

/**
 * `"*"` or an array of absolute canonical paths. Trailing slashes are
 * normalized away; duplicates collapse. Paths are validated for shape only —
 * `lib/web-visibility.ts` does realpath-insensitive prefix matching later.
 */
export function parseProjects(
  value: unknown,
): { ok: true; projects: string[] | "*" } | { ok: false } {
  if (value === "*") return { ok: true, projects: "*" };
  if (!Array.isArray(value)) return { ok: false };
  const roots: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || !entry.startsWith("/")) {
      return { ok: false };
    }
    roots.push(entry === "/" ? "/" : entry.replace(/\/+$/, ""));
  }
  return { ok: true, projects: [...new Set(roots)] };
}

/** `"*"` or an array of valid, deduped machine ids. */
export function parseMachines(
  value: unknown,
): { ok: true; machines: string[] | "*" } | { ok: false } {
  if (value === "*") return { ok: true, machines: "*" };
  if (!Array.isArray(value)) return { ok: false };
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || !isValidMachineId(entry)) {
      return { ok: false };
    }
    ids.push(entry);
  }
  return { ok: true, machines: [...new Set(ids)] };
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
