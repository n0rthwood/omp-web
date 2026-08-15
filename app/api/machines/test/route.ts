import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import type { MachineHealth } from "@/lib/api-types";
import {
  MachineValidationError,
  getMachine,
  normalizeBaseUrl,
  type MachineAuthMode,
  type StoredMachine,
} from "@/lib/machines/machine-store";
import { authHeader } from "@/lib/machines/remote-request";
import { FLEET_CONFIGURATION_DENIED_MESSAGE, isFleetConfigurationAllowed } from "@/lib/machines/fleet-gate";
import { jsonError, readJsonBody, requireAdminApi } from "../../web-users/_guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const AUTH_MODES: Record<string, MachineAuthMode> = {
  bearer: "bearer",
  basic: "basic",
  none: "none",
};

const PROBE_TIMEOUT_MS = 10_000;

/** Cap on any upstream body this route reads — a hostile remote must not be able
 *  to OOM a process that also hosts live agent sessions. Content-Length is not a
 *  usable gate: omp-web answers chunked, so the header is absent. */
const BODY_READ_LIMIT = 16 * 1024;

async function readCappedText(upstream: Response): Promise<string> {
  if (!upstream.body) return "";
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    while (read < BODY_READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return text.slice(0, BODY_READ_LIMIT);
}

async function upstreamError(upstream: Response, fallback: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readCappedText(upstream));
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // fall through to the fixed message
  }
  return fallback;
}

function probeFailure(
  code: "machine_unauthorized" | "machine_unreachable" | "machine_error",
  error: string,
  status?: number,
): NextResponse {
  return NextResponse.json({ ok: false, code, ...(status === undefined ? {} : { status }), error }, { headers: NO_STORE });
}

// POST /api/machines/test  body: { baseUrl, authMode, token?, username?, headers?, id? }
//
// Probes a draft (or existing, via `id`) machine's /api/health server-to-server.
// A failed probe is a successful API call: the result is always HTTP 200 with
// `ok: false` and a `code`. The credential never crosses back to the browser.
export async function POST(req: Request) {
  const denied = await requireAdminApi(req);
  if (denied) return denied;
  if (!isFleetConfigurationAllowed()) return jsonError(403, FLEET_CONFIGURATION_DENIED_MESSAGE);
  if (!hasJsonContentType(req)) {
    return jsonError(415, "Content-Type must be application/json");
  }

  const body = await readJsonBody(req);
  if (!body) return jsonError(400, "Invalid JSON body");

  const { baseUrl, authMode, token, username, headers, id } = body;
  if (typeof baseUrl !== "string") return jsonError(400, "baseUrl is required");
  const parsedAuthMode = typeof authMode === "string" ? AUTH_MODES[authMode] : undefined;
  if (!parsedAuthMode) {
    return jsonError(400, "authMode must be \"bearer\", \"basic\" or \"none\"");
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
  if (id !== undefined && typeof id !== "string") return jsonError(400, "id must be a string");

  let origin: string;
  try {
    origin = normalizeBaseUrl(baseUrl);
  } catch (error) {
    if (error instanceof MachineValidationError) {
      return jsonError(400, error.message);
    }
    return jsonError(500, "Failed to validate baseUrl");
  }

  // `id` without a typed `token` means the user is editing a stored machine and
  // did not retype the secret — reuse the server-held credential (and static
  // headers / basic username) as-is.
  const stored = typeof id === "string" ? getMachine(id) : null;
  if (typeof id === "string" && !stored) return jsonError(404, "Unknown machine");

  // ...but only against the origin that credential was stored for. Otherwise
  // this route would deliver a stored token to any origin the caller names,
  // which turns a write-only secret into a readable one.
  if (stored && !token && stored.baseUrl !== origin) {
    return jsonError(
      400,
      "Re-enter the credential when probing a different base URL than the one stored for this machine",
    );
  }

  const effectiveToken = typeof token === "string" && token ? token : stored?.token;
  const effectiveUsername = typeof username === "string" && username ? username : stored?.username;
  const effectiveHeaders = headers === undefined
    ? stored?.headers
    : headers as Record<string, string>;

  if (parsedAuthMode !== "none" && !effectiveToken) {
    return jsonError(400, `token is required when authMode is "${parsedAuthMode}"`);
  }

  const draft: StoredMachine = {
    id: stored?.id ?? "draft",
    name: stored?.name ?? "draft",
    baseUrl: origin,
    authMode: parsedAuthMode,
    ...(effectiveToken ? { token: effectiveToken } : {}),
    ...(effectiveUsername ? { username: effectiveUsername } : {}),
    ...(effectiveHeaders ? { headers: effectiveHeaders } : {}),
    createdAt: stored?.createdAt ?? "",
    updatedAt: stored?.updatedAt ?? "",
  };

  const outbound = new Headers({ accept: "application/json", "accept-encoding": "identity" });
  try {
    for (const [name, value] of Object.entries({ ...authHeader(draft), ...draft.headers })) {
      outbound.set(name, value);
    }
  } catch {
    // A credential or static header carrying a control character. The store
    // rejects these on save; a hand-edited file or an untrusted draft can
    // still reach here, and it is a bad request, not a crash.
    return jsonError(400, "A credential or static header contains characters that cannot be sent");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${origin}/api/health`, {
      headers: outbound,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return probeFailure("machine_unreachable", "Connection timed out.");
    }
    return probeFailure("machine_unreachable", error instanceof Error ? error.message : String(error));
  }

  if (upstream.status === 401 || upstream.status === 403) {
    const error = await upstreamError(upstream, "The machine rejected this credential.");
    return probeFailure("machine_unauthorized", error, upstream.status);
  }
  if (!upstream.ok) {
    const error = await upstreamError(upstream, `HTTP ${upstream.status}`);
    return probeFailure("machine_error", error, upstream.status);
  }

  // Same cap as the error path: /api/health is tiny, and a hostile or merely
  // broken remote must not be able to OOM a process that also hosts live
  // agent sessions.
  let parsedHealth: unknown;
  try {
    parsedHealth = JSON.parse(await readCappedText(upstream));
  } catch {
    return probeFailure("machine_error", "Unexpected /api/health response", upstream.status);
  }
  if (parsedHealth === null || typeof parsedHealth !== "object" || !("ok" in parsedHealth) || parsedHealth.ok !== true) {
    return probeFailure("machine_error", "Unexpected /api/health response", upstream.status);
  }
  // Shape-checked above; the remaining MachineHealth fields are advisory display data.
  const health = parsedHealth as MachineHealth;
  return NextResponse.json({ ok: true, health }, { headers: NO_STORE });
}
