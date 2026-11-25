import { filterVisibleSessions } from "../web-visibility";
import { canManageStaticMapping, filterVisibleStaticMappings } from "../static-mapping-visibility";
import type { WebUser } from "../web-users";

const NO_STORE = { "Cache-Control": "no-store" };

/** True for exactly the proxied session-LIST route (detail routes stay ungated by design). */
export function isSessionListProxyPath(method: string, remotePathname: string): boolean {
  return method === "GET" && remotePathname === "/api/sessions";
}

interface RemoteSessionEntry { id?: string; cwd?: string; projectRoot?: string }

/**
 * Issue #14: a machine-granted non-admin must not see sessions outside their
 * granted project paths in a proxied session list. The remote cannot filter
 * (no per-user identity crosses the proxy — it sees its own env-bridge admin),
 * so the gateway filters the response. Everything else (admins, `"*"`
 * visibility, non-JSON, non-200, any parse surprise) streams through untouched.
 */
export async function applySessionListVisibilityFilter(user: WebUser, response: Response): Promise<Response> {
  if (user.role === "admin" || user.visibleProjects === "*") return response;
  if (response.status !== 200) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const text = await response.text();
  let payload: { sessions?: RemoteSessionEntry[]; runningSessionIds?: string[] };
  try {
    payload = JSON.parse(text);
  } catch {
    return unbuffered(text, response.status);
  }
  if (!payload || !Array.isArray(payload.sessions)) return unbuffered(text, response.status);

  // Anchor guard: an entry with neither a `cwd` nor a `projectRoot` string
  // has nothing to test grants against — drop it rather than throw (one
  // malformed remote entry must never 500 the whole list). An entry with
  // only a `projectRoot` stays: `filterVisibleSessions` treats either as a
  // visibility anchor, and a coerced empty cwd matches no grant by itself.
  const anchored = payload.sessions.filter(
    (s) => typeof s.cwd === "string" || typeof s.projectRoot === "string",
  ) as { id?: string; cwd: string; projectRoot?: string }[];
  const candidates = anchored.map((s) => (typeof s.cwd === "string" ? s : { ...s, cwd: "" }));

  const visible = filterVisibleSessions(user, candidates);
  const visibleIds = new Set(visible.map((s) => s.id).filter((id): id is string => typeof id === "string"));
  const runningSessionIds = Array.isArray(payload.runningSessionIds)
    ? payload.runningSessionIds.filter((id) => visibleIds.has(id))
    : undefined;
  const body = JSON.stringify(runningSessionIds === undefined ? { ...payload, sessions: visible } : { ...payload, sessions: visible, runningSessionIds });
  return new Response(body, {
    status: response.status,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}

function unbuffered(text: string, status: number): Response {
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...NO_STORE } });
}

/** True for exactly the proxied static-mapping LIST route. */
export function isStaticMappingListProxyPath(method: string, remotePathname: string): boolean {
  return method === "GET" && remotePathname === "/api/static-mappings";
}

/** True for proxied static-mapping item reads (`GET /api/static-mappings/:id`). */
export function isStaticMappingItemReadProxyPath(method: string, remotePathname: string): boolean {
  if (method !== "GET") return false;
  const segments = remotePathname.split("/").filter(Boolean);
  return segments.length === 3 && segments[0] === "api" && segments[1] === "static-mappings";
}

/** True for the proxied static-mapping item routes that mutate a row. */
export function isStaticMappingMutationProxyPath(method: string, remotePathname: string): boolean {
  if (method !== "PATCH" && method !== "DELETE") return false;
  const segments = remotePathname.split("/").filter(Boolean);
  return segments.length === 3 && segments[0] === "api" && segments[1] === "static-mappings";
}

/** True for the proxied static-mapping CREATE route (`POST /api/static-mappings`). */
export function isStaticMappingCreateProxyPath(method: string, remotePathname: string): boolean {
  return method === "POST" && remotePathname === "/api/static-mappings";
}

interface RemoteMappingEntry { projectRoot?: unknown }

/**
 * Issue #136: a machine-granted non-admin must not discover static mappings
 * outside their granted project roots in a proxied mapping list. The remote
 * cannot filter (no per-user identity crosses the proxy — it sees the
 * machine credential, typically its own env-bridge admin), so the gateway
 * filters the response with the signed-in user's grants. Legacy rows without
 * a projectRoot stay admin-only even for `"*"` visibility. Non-JSON /
 * non-200 / unparseable payloads pass through untouched.
 */
export async function applyStaticMappingListVisibilityFilter(user: WebUser, response: Response): Promise<Response> {
  if (user.role === "admin") return response;
  if (response.status !== 200) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const text = await response.text();
  let payload: { mappings?: RemoteMappingEntry[] };
  try {
    payload = JSON.parse(text);
  } catch {
    return unbuffered(text, response.status);
  }
  if (!payload || !Array.isArray(payload.mappings)) return unbuffered(text, response.status);

  const candidates = payload.mappings.filter(
    (mapping): mapping is { projectRoot?: string } => typeof mapping === "object" && mapping !== null,
  );
  const visible = filterVisibleStaticMappings(user, candidates);
  const body = JSON.stringify({ ...payload, mappings: visible });
  return new Response(body, {
    status: response.status,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}

/**
 * Issue #136: a proxied item read must not hand a non-admin a row outside
 * their project grants (the remote answers under the machine credential).
 * A hidden or legacy row reads as 404 so its existence is not confirmed.
 */
export async function applyStaticMappingItemVisibilityFilter(user: WebUser, response: Response): Promise<Response> {
  if (user.role === "admin") return response;
  if (response.status !== 200) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const text = await response.text();
  let payload: { mapping?: RemoteMappingEntry };
  try {
    payload = JSON.parse(text);
  } catch {
    return unbuffered(text, response.status);
  }
  const mapping = payload?.mapping;
  if (mapping && typeof mapping === "object" && canManageStaticMapping(user, mapping as { projectRoot?: string })) {
    return unbuffered(text, response.status);
  }
  return new Response(JSON.stringify({ error: "Static mapping not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}

/**
 * Issue #136: management authorization for proxied item mutations
 * (`PATCH`/`DELETE /api/static-mappings/:id`). Reads the row through the same
 * machine-credential boundary the mutation will use, then applies the
 * signed-in user's project grant before anything is forwarded. Admins skip
 * the probe. Fail-closed: a row that cannot be confirmed visible is never
 * mutated on the user's behalf.
 */
export async function staticMappingMutationGate(
  user: WebUser,
  fetchRow: () => Promise<Response>,
): Promise<Response | null> {
  if (user.role === "admin") return null;
  let row: Response;
  try {
    row = await fetchRow();
  } catch {
    return new Response(JSON.stringify({ error: "Machine unreachable", code: "machine_unreachable" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...NO_STORE },
    });
  }
  if (row.status !== 200) return row;
  const contentType = row.headers.get("content-type") ?? "";
  const text = await row.text();
  let payload: { mapping?: RemoteMappingEntry } | null = null;
  if (contentType.includes("application/json")) {
    try {
      payload = JSON.parse(text) as { mapping?: RemoteMappingEntry };
    } catch {
      payload = null;
    }
  }
  const mapping = payload?.mapping;
  if (mapping && typeof mapping === "object" && canManageStaticMapping(user, mapping as { projectRoot?: string })) {
    return null;
  }
  // Fail-closed: a probe that cannot confirm a visible row (non-JSON,
  // unparseable, or missing mapping) must never let the mutation proceed.
  return new Response(JSON.stringify({ error: "Static mapping not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...NO_STORE },
  });
}