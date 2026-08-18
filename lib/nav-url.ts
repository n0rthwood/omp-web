/**
 * The deeplink URL codec (issue #10, stage 2; issue #15 "Always Home").
 *
 * Pure functions between `window.location` and `NavigationTarget`s:
 * `parseLocation` turns a raw pathname + search into either an explicit
 * deeplink target (`{kind:"target"}` — `/m/...`, `/p/...`, legacy
 * `?machine=`/`?session=`/`?cwd=` queries) or the Home entry
 * (`{kind:"home"}` — bare `/`, bare `/m` / `/p`, and every malformed
 * shape). `buildUrl` is the exact inverse for targets. Home replaced the
 * pre-#15 `"resume"`/`"root"` kinds: the entry path never auto-resumes a
 * conversation anymore, so those kinds no longer exist.
 */

// Mirrors `LOCAL_MACHINE_ID` in ./api-path.ts. Duplicated (not imported) so
// this module never depends on api-path.ts, which itself builds URLs via
// `buildUrl` below — an import the other way would be circular.
const LOCAL_MACHINE_ID = "local";

export interface NavigationTarget {
  machineId: string;
  project: string | null;
  session: string | null;
}

export type ParsedLocation =
  | { kind: "target"; target: NavigationTarget }
  | { kind: "home" };

export const ROOT_URL = "/";

function trimmedOrNull(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Legacy `?machine=` / `?session=` / `?cwd=` deeplinks, preserved forever so
 * old bookmarks and shared links keep working. Reachable from ANY pathname,
 * including "/". `cwd` wins over `session`, matching the pre-#10 behavior
 * this parser subsumes (the module that used to own this logic was deleted
 * in stage 3). Absent/empty (post-trim) keys fall through to path parsing.
 */
function parseLegacyQuery(params: URLSearchParams): ParsedLocation | null {
  const machine = trimmedOrNull(params.get("machine"));
  const session = trimmedOrNull(params.get("session"));
  const cwd = trimmedOrNull(params.get("cwd"));
  if (machine === null && session === null && cwd === null) return null;

  return {
    kind: "target",
    target: {
      machineId: machine ?? LOCAL_MACHINE_ID,
      project: cwd,
      session: cwd ? null : session,
    },
  };
}

/** `/p/<proj>` or `/p/<proj>/s/<sid>` after the leading "p" segment (already stripped). */
function parseAfterProject(rest: string[], machineId: string): ParsedLocation {
  if (rest.length === 0) return { kind: "home" };
  const [project, ...tail] = rest;
  if (tail.length === 0) {
    return { kind: "target", target: { machineId, project, session: null } };
  }
  if (tail.length === 2 && tail[0] === "s") {
    return { kind: "target", target: { machineId, project, session: tail[1] } };
  }
  return { kind: "home" };
}

/** `/m/<id>[/p/...]` after the leading "m" segment (already stripped, non-empty). */
function parseAfterMachine(rest: string[]): ParsedLocation {
  const [machineId, ...tail] = rest;
  if (tail.length === 0) {
    return { kind: "target", target: { machineId, project: null, session: null } };
  }
  if (tail[0] !== "p") return { kind: "home" };
  return parseAfterProject(tail.slice(1), machineId);
}

function parsePath(pathname: string): ParsedLocation {
  if (pathname === "/" || pathname === "") return { kind: "home" };
  if (!pathname.startsWith("/")) return { kind: "home" };

  const raw = pathname.slice(1).split("/");
  // A single trailing slash ("/m/x/") is tolerated; anything else that
  // produces an empty segment (leading "//", interior "//") is malformed.
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();

  let segments: string[];
  try {
    segments = raw.map((segment) => {
      if (segment === "") throw new Error("empty path segment");
      return decodeURIComponent(segment);
    });
  } catch {
    return { kind: "home" };
  }

  const [head, ...rest] = segments;
  if (head === "m") {
    return rest.length === 0 ? { kind: "home" } : parseAfterMachine(rest);
  }
  if (head === "p") {
    return rest.length === 0 ? { kind: "home" } : parseAfterProject(rest, LOCAL_MACHINE_ID);
  }
  return { kind: "home" };
}

/**
 * `pathname` MUST be the raw `window.location.pathname` (percent-encoded
 * segments) — never the decoded value from `usePathname()`, which would
 * corrupt any project path containing "/" (already decoded to a literal
 * slash, indistinguishable from a segment boundary).
 */
export function parseLocation(pathname: string, search: string | URLSearchParams): ParsedLocation {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return parseLegacyQuery(params) ?? parsePath(pathname);
}

/**
 * The inverse of `parseLocation`'s path branch. Local machine is omitted;
 * a session is never emitted without its project (defensive — the shapes
 * above never allow it, but a caller could still construct such a target).
 */
export function buildUrl(target: NavigationTarget): string {
  const segments: string[] = [];
  if (target.machineId !== LOCAL_MACHINE_ID) {
    segments.push("m", encodeURIComponent(target.machineId));
  }
  if (target.project) {
    segments.push("p", encodeURIComponent(target.project));
    if (target.session) {
      segments.push("s", encodeURIComponent(target.session));
    }
  }
  return segments.length === 0 ? ROOT_URL : `/${segments.join("/")}`;
}
