/**
 * Explicit allow-list of omp-web API routes that may be proxied to a remote
 * machine through `/api/machines/<id>/api/...`.
 *
 * The table is a hardcoded inventory of the route files under `app/api`
 * (templates mirror the filesystem; `:param` matches one segment, `*` matches
 * the files catch-all tail). A method+path is proxyable only when both match
 * a template row — everything else, including every route not listed, is
 * denied. Fleet-management surfaces (`/api/machines`, `/api/web-users`,
 * web-login/logout) and the self-updating POST /api/updates are denied
 * outright so a gateway can never be used to reconfigure another machine's
 * fleet, users, or its own binary.
 */

interface RouteRule {
  template: string;
  methods: readonly string[];
}

const ALLOWED_ROUTES: readonly RouteRule[] = [
  { template: "/api/agent/:id/bash-output", methods: ["GET"] },
  { template: "/api/agent/:id/events", methods: ["GET"] },
  { template: "/api/agent/:id/uploads", methods: ["POST"] },
  { template: "/api/agent/:id", methods: ["GET", "POST"] },
  { template: "/api/agent/new", methods: ["POST"] },
  { template: "/api/agent/running/events", methods: ["GET"] },
  { template: "/api/agent/running", methods: ["GET"] },
  { template: "/api/auth/all-providers", methods: ["GET"] },
  { template: "/api/auth/api-key/:provider", methods: ["GET", "POST", "DELETE"] },
  { template: "/api/auth/login/:provider", methods: ["GET", "POST"] },
  { template: "/api/auth/logout/:provider", methods: ["POST"] },
  { template: "/api/auth/providers", methods: ["GET"] },
  { template: "/api/cwd/browse", methods: ["GET"] },
  { template: "/api/cwd/validate", methods: ["POST"] },
  { template: "/api/default-cwd", methods: ["POST"] },
  { template: "/api/file-index", methods: ["GET"] },
  { template: "/api/files/*", methods: ["GET", "POST"] },
  { template: "/api/git/diff", methods: ["GET"] },
  { template: "/api/git/status", methods: ["GET"] },
  { template: "/api/health", methods: ["GET"] },
  { template: "/api/home", methods: ["GET"] },
  { template: "/api/mcp", methods: ["GET", "PATCH", "PUT"] },
  { template: "/api/model-roles", methods: ["GET", "PUT"] },
  { template: "/api/models-config/catalog", methods: ["GET"] },
  { template: "/api/models-config/discover", methods: ["POST"] },
  { template: "/api/models-config/test", methods: ["POST"] },
  { template: "/api/models-config", methods: ["GET", "PUT"] },
  { template: "/api/models", methods: ["GET"] },
  { template: "/api/plugins", methods: ["GET", "POST"] },
  { template: "/api/project-trust", methods: ["GET", "POST"] },
  { template: "/api/sessions/:id/auto-name", methods: ["POST"] },
  { template: "/api/sessions/:id/context", methods: ["GET"] },
  { template: "/api/sessions/:id/entries/:entryId/thinking", methods: ["GET"] },
  { template: "/api/sessions/:id/export", methods: ["GET"] },
  { template: "/api/sessions/:id/state", methods: ["GET"] },
  { template: "/api/sessions/:id", methods: ["GET", "PATCH", "DELETE"] },
  { template: "/api/sessions", methods: ["GET"] },
  { template: "/api/settings", methods: ["GET", "PATCH"] },
  { template: "/api/skills/check", methods: ["POST"] },
  { template: "/api/skills/install", methods: ["POST"] },
  { template: "/api/skills/search", methods: ["POST"] },
  { template: "/api/skills/update", methods: ["POST"] },
  { template: "/api/skills", methods: ["GET", "PATCH"] },
  { template: "/api/terminals/:id/events", methods: ["GET"] },
  { template: "/api/terminals/:id/input", methods: ["POST"] },
  { template: "/api/terminals/:id/resize", methods: ["POST"] },
  { template: "/api/terminals/status", methods: ["GET"] },
  { template: "/api/terminals/:id", methods: ["DELETE"] },
  { template: "/api/terminals", methods: ["GET", "POST"] },
  { template: "/api/theme", methods: ["GET"] },
  { template: "/api/updates", methods: ["GET"] },
  { template: "/api/worktrees", methods: ["GET", "POST", "DELETE"] },
];

/** Never proxied, no matter what any future route table says. */
const DENIED_PREFIXES = ["/api/machines", "/api/web-users"] as const;
const DENIED_EXACT: Record<string, true> = {
  "/api/auth/web-login": true,
  "/api/auth/web-logout": true,
};
const DENIED_EXACT_METHOD: Record<string, true> = {
  "POST /api/updates": true,
};

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}

function matchesTemplate(template: string, segments: string[]): boolean {
  const parts = template.split("/").slice(1); // drop the leading ""
  if (parts[parts.length - 1] === "*") {
    const fixed = parts.slice(0, -1);
    if (segments.length < fixed.length) return false;
    return fixed.every((part, i) => part.startsWith(":") || part === segments[i]);
  }
  if (parts.length !== segments.length) return false;
  return parts.every((part, i) => part.startsWith(":") || part === segments[i]);
}

export function isProxyablePath(method: string, pathname: string): boolean {
  const path = normalize(pathname);
  const upperMethod = method.toUpperCase();
  const segments = path.split("/").slice(1);

  // Authorize the path that will actually be requested. `fetch` resolves the
  // URL with the WHATWG parser, which strips "." and ".." segments, so a table
  // match on the unresolved string would authorize one route and request
  // another: "/api/files/../../api/web-users" matches the files wildcard here
  // and arrives at the remote as "/api/web-users". Empty segments are refused
  // for the same reason — they are not a path this gateway can reason about.
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }

  if (Object.hasOwn(DENIED_EXACT_METHOD, `${upperMethod} ${path}`)) return false;
  if (Object.hasOwn(DENIED_EXACT, path)) return false;
  // Deny "/api/machines" and anything beneath it — no fleet-in-fleet recursion,
  // and no reconfiguring another gateway's machine registry.
  if (DENIED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return false;
  }

  return ALLOWED_ROUTES.some(
    (rule) => rule.methods.includes(upperMethod) && matchesTemplate(rule.template, segments),
  );
}
