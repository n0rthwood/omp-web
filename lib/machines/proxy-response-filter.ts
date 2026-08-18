import { filterVisibleSessions } from "../web-visibility";
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
