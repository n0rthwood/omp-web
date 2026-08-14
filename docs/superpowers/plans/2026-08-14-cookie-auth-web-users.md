# Cookie Auth + Web Users + Project Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Basic-Auth-only auth with cookie login (browser/PWA) + Bearer tokens (CLI), a multi-user store with admin/user roles, and UI-level project-visibility filtering (explicitly NOT a sandbox).

**Architecture:** Server-side opaque sessions (cookie = random id; store = hash→record JSON file). Identity resolution unifies cookie / Bearer / legacy Basic into one `WebUser`. `proxy.ts` stays the auth gate; visibility is per-request intersection in routes (never mutate the process-global `getAllowedFileRoots()` cache). Users stored in `~/.omp/agent/omp-web-users.yml` (scrypt hashes, atomic 0600 writes).

**Tech Stack:** Next.js (Bun runtime only), `node:crypto` scrypt, `yaml` pkg, `writePrivateFileAtomicSync` from `lib/atomic-file.ts`.

**Decisions locked with user (2026-08-14):**
- CLI auth = **Bearer token only**. NO loopback/no-auth exception — every request needs a valid credential when auth is enabled.
- Cookies (HttpOnly, SameSite=Lax, Secure off-loopback) for browser + iOS Home Screen PWA.
- Basic Auth via `OMP_WEB_PASSWORD` = **migration bridge**: works only while env var set, maps to implicit admin user `omp`.
- Worktree management **allowed inside visible projects** for user role.
- Canonical hosts in docs: `omp.joyai.dev` and `omp.joysort.cn` (production); `ompdev.joyai.dev` is temp/dev.

---

## Global contracts (defined once, used by every task)

### Types — `lib/web-users.ts`

```ts
export type WebUserRole = "admin" | "user";
export type StoredWebUser = {
  username: string;            // unique, [a-z0-9_-]{1,32}, lowercase
  role: WebUserRole;
  passwordHash: string;        // "scrypt$N$r$p$saltB64$hashB64"
  projects: string[] | "*";    // canonical absolute roots; "*" = all (admin-ish visibility)
  tokens: { name: string; tokenHash: string; created: string }[]; // sha256 hex of raw token
};
export type WebUser = {        // SAFE, resolved identity — never contains hashes
  username: string;
  role: WebUserRole;
  visibleProjects: string[] | "*";
};
export type WebUsersConfig = {
  users: StoredWebUser[];
  sessions: { secret: string; ttlDays: number };  // secret: 32-byte base64, auto-generated
};
```

- scrypt params: N=16384, r=8, p=1, keylen=64. Format `scrypt$16384$8$1$<saltB64>$<hashB64>`. Verify with `timingSafeEqual`.
- Store path: `getAgentDir() + "/omp-web-users.yml"` (from `@oh-my-pi/pi-coding-agent`). Read: yaml parse with candidate fallback (none — single path). Write: sanitize → `writePrivateFileAtomicSync` (mode 0600) → invalidate `globalThis.__ompWebUsersCache`.
- Migration: `getEffectiveUsers()` returns users from file PLUS, when file has no users and `process.env.OMP_WEB_PASSWORD` is set, a synthetic admin `{ username: "omp", role: "admin", passwordHash: null, envBacked: true }`. Env-backed user verifies against the env password (reuse timing-safe compare idiom from `lib/web-auth.ts`), never persisted.
- Token creation: raw token = `web_<32 bytes base64url>`; store sha256 hex only; return raw exactly once.
- `authEnabled()`: true iff users file has ≥1 user OR env password set. When false, `resolveWebUser` returns a synthetic admin `__anonymous` (current no-auth behavior preserved).

### Sessions — `lib/web-sessions.ts`

```ts
export const WEB_SESSION_COOKIE = "omp-web-session";
export function createWebSession(username: string): { raw: string; cookieAttrs: string };
export function lookupWebSession(raw: string): { username: string } | null; // refreshes sliding TTL
export function revokeWebSession(raw: string): void;
export function purgeExpiredWebSessions(): void;
```

- Store: `~/.omp/agent/omp-web-sessions.json`, shape `{ sessions: { [sha256hex(raw)]: { username, created, expires, lastUsed } } }`, atomic write, `globalThis.__ompWebSessions` cache.
- TTL: sliding — `expires = now + ttlDays*86400s` refreshed on lookup when `lastUsed` older than 1h (throttled disk writes).
- Cookie attrs: `Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>` + `; Secure` unless request host is loopback (`localhost`, `127.0.0.1`, `::1` — dev). Cookie domain: none (host-only).
- All auth endpoints set `Cache-Control: no-store`.

### Identity resolution — `lib/web-auth-context.ts`

```ts
export function getWebUserFromRequest(request: Request): Promise<WebUser | null>;
// Order: cookie session → Bearer token → legacy Basic (env migration).
// Returns null when auth enabled and no valid credential.
export function getWebUserOrSynthetic(request: Request): Promise<WebUser>; // __anonymous admin when auth disabled
```

Reads `cookie` header + `authorization` header from the raw Request — works in both middleware (`NextRequest`) and route handlers.

### Visibility — `lib/web-visibility.ts`

```ts
export function isAdmin(user: WebUser): boolean;
export function isPathVisible(user: WebUser, absPath: string): boolean; // "*" → true; else realpath-insensitive prefix match on normalized slash-trailing paths
export function filterVisibleSessions<S extends { cwd: string; projectRoot?: string }>(user: WebUser, sessions: S[]): S[];
export function visibleRootsForUser(user: WebUser, allRoots: Set<string>): string[];
```

### proxy.ts flow (order matters)

1. Trust gate (unchanged: `isApiRequestAllowed` / `isApiRequestHostAllowed`).
2. `/api/auth/web-login`, `/api/auth/web-me` skip auth (login must be reachable; web-me returns `{ user: null }` when unauthenticated, 200). `/login` page is outside the matcher already (`matcher = ["/", "/api/:path*"]`) — no change needed.
3. Resolve user. Valid → attach nothing to the request (routes re-resolve; identity file I/O is cached) → `NextResponse.next()`.
4. Unauthenticated + auth enabled:
   - API (`/api/*`) → `401 {"error":"Authentication required"}`, `Cache-Control: no-store`, plus `WWW-Authenticate: Basic` ONLY when env password set (migration bridge visibility).
   - `/` (HTML) → `302 /login?next=/`.
5. Authenticated but `role: user` hitting an admin-only prefix → `403 {"error":"Admin access required"}`.
   `ADMIN_ONLY_API_PREFIXES = ["/api/auth/all-providers", "/api/auth/api-key", "/api/auth/login", "/api/auth/logout", "/api/plugins", "/api/mcp", "/api/project-trust", "/api/settings", "/api/updates", "/api/models-config", "/api/git", "/api/web-users"]`.
6. CSRF: cookie is ambient → `isApiRequestAllowed` (existing origin check) already runs BEFORE auth and stays for all `/api/*`. Do not reorder.

### Terminal gate

`lib/terminals/terminal-gate.ts`: `isTerminalHostGateSatisfied` additionally returns true when web users file has ≥1 user (auth exists beyond env password). Keep existing branches.

### Test conventions

`node:test` + `node:assert/strict`, dynamic `import("./subject.ts")` per test (see `lib/web-auth.test.mjs`). Env-dependent cases use save/restore `withEnv` (see `lib/terminals/terminal-service.test.ts:21-45`). Point file paths at a temp dir by overriding the store path via injectable param or env (`OMP_WEB_USERS_FILE` env override — add it, it makes everything testable; also `OMP_WEB_SESSIONS_FILE`).

---

## Task 1: `lib/web-users.ts` — user store, scrypt, migration, tokens

**Files:** Create `lib/web-users.ts`, `lib/web-users.test.mjs`.

- [ ] Write failing tests: hash/verify roundtrip; wrong password fails; yaml file write→read roundtrip via `OMP_WEB_USERS_FILE` temp path; migration user appears only when env password set and file empty; token create→verify-by-hash; username validation regex; `projects: "*"` vs roots roundtrip; secret auto-generated 32B on first write.
- [ ] Implement module per contracts above. Copy atomic-write + yaml idioms from `app/api/models-config/route.ts` (read it first). Cache: `globalThis.__ompWebUsersCache = { value, mtimeMs }` — invalidate on write; re-read when file mtime changes.
- [ ] Run `bun test lib/web-users.test.mjs` — pass. `bun run typecheck` — clean.
- [ ] Commit: `feat: web user store with scrypt hashes and env migration (refs #7)`

## Task 2: `lib/web-sessions.ts` — opaque server-side sessions

**Files:** Create `lib/web-sessions.ts`, `lib/web-sessions.test.mjs`.

- [ ] Failing tests: create→lookup roundtrip; unknown/expired rejected; revoke kills lookup; sliding TTL refresh advances `expires` but only rewrites after 1h; purge removes expired; cookie attr string correct for loopback (no Secure) vs public host (Secure); store path overridable via `OMP_WEB_SESSIONS_FILE`.
- [ ] Implement per contracts. Note: `lookupWebSession` needs request host only for cookie *serialization* — split `cookieAttrs(host)` helper so lookup stays pure.
- [ ] `bun test lib/web-sessions.test.mjs` pass; typecheck clean. Commit: `feat: server-side opaque web sessions (refs #7)`

## Task 3: `lib/web-auth-context.ts` + `lib/web-visibility.ts`

**Files:** Create `lib/web-auth-context.ts`, `lib/web-visibility.ts`, `lib/web-auth-context.test.mjs`.

- [ ] Failing tests: cookie session resolves user; Bearer raw token resolves stored user (and its `visibleProjects`); Basic migration resolves env admin while env set; auth disabled → `__anonymous` admin; enabled + no credential → null. Visibility: `isPathVisible` prefix semantics (`/home/a/b` under `/home/a`, NOT `/home/abc` under `/home/a/b` — slash-terminate); `filterVisibleSessions` keeps session when `projectRoot ?? cwd` visible; admin keeps all; `visibleRootsForUser` intersects.
- [ ] Implement. Import order in resolution: cookie → bearer → basic (cheap → cheap → env).
- [ ] Tests pass, typecheck clean. Commit: `feat: unified web auth context and visibility helpers (refs #7)`

## Task 4: `proxy.ts` auth flow + terminal gate

**Files:** Modify `proxy.ts`, `lib/terminals/terminal-gate.ts`, tests `lib/web-proxy.test.mjs` (new; check whether an existing proxy test file exists first and extend it instead).

- [ ] Failing tests: unauthenticated `/api/x` → 401 JSON + no-store; unauth `/` → 302 `/login?next=/`; valid cookie → next(); user role on `/api/plugins` → 403; admin → next(); auth disabled entirely → next() (backward compat no-env installs); trust gate still runs FIRST (403 Untrusted before any 401).
- [ ] Implement flow per contracts (order: trust → login-exempt → resolve → 401/302 → admin prefixes → next).
- [ ] Terminal gate: users-file branch. Extend `terminal-gate` test.
- [ ] Tests pass, typecheck. Commit: `feat: cookie/bearer auth gate in proxy with admin-only prefixes (refs #7)`

## Task 5: `/login` page + auth API routes

**Files:** Create `app/login/page.tsx` (+ client form component), `app/api/auth/web-login/route.ts`, `app/api/auth/web-me/route.ts`, `app/api/auth/web-logout/route.ts`, tests.

- [ ] `POST /api/auth/web-login` `{username, password}`: validate → create session → `Set-Cookie` (attrs from Task 2, `Secure` by host) → `{user: WebUser}`; 401 `{error:"Invalid credentials"}`; `no-store`; rate-limit: in-memory per-username counter (5 fails → 30s lockout, `globalThis` map — good enough, document).
- [ ] `GET /api/auth/web-me`: `{user: WebUser | null}`; `no-store`. Route does NOT require auth (returns null user).
- [ ] `POST /api/auth/web-logout`: revoke + clear cookie (`Max-Age=0`); `no-store`; CSRF: require `isApiRequestAllowed` (origin check) — logout is state-changing.
- [ ] `/login` page: server component wrapper + client form (username/password, error state, `next` param sanitized to same-origin path, redirect via `window.location`). Follow existing styling (dark theme vars from `app/globals.css`); standalone page, no AppShell. Button + inputs match `--bg-panel`/`--accent` palette.
- [ ] Tests: route-level unit tests where feasible (login validate/lockout via direct handler invocation); page renders (skip if no existing page-test convention). Commit: `feat: /login page and web auth API routes (refs #7)`

## Task 6: Session visibility filtering

**Files:** Modify `app/api/sessions/route.ts`, `app/api/sessions/[id]/route.ts` (+ `context/`, `state/`, `export/`, `auto-name/`, `entries/` subroutes), tests.

- [ ] `GET /api/sessions`: resolve user (synthetic when disabled); `filterVisibleSessions(user, sessions)` on the merged list before response. runningSessionIds filtered too (intersection with visible ids).
- [ ] `GET /api/sessions/[id]` (+ subroutes): resolve session cwd → `isPathVisible` else `404 {error:"Session not visible for this user"}` (404 not 403 — do not confirm existence). PATCH/DELETE same gate.
- [ ] Failing tests first: user with one root sees only that project's sessions; hidden id GET → 404; admin sees all; disabled-auth behavior unchanged.
- [ ] Commit: `feat: per-user session visibility filtering (refs #7)`

## Task 7: cwd/agent gating

**Files:** Modify `app/api/cwd/browse/route.ts`, `app/api/cwd/validate/route.ts`, `app/api/default-cwd/route.ts`, `app/api/agent/new/route.ts`, `app/api/home/route.ts`, tests.

- [ ] browse: user role → `getBrowseStartDirectory` clamped to first visible root; `resolveDirectory` rejects paths outside visible roots (403); admin unchanged.
- [ ] validate: user role → canonical cwd must be `isPathVisible` else 403 (and do NOT `allowFileRoot`).
- [ ] default-cwd: user role → dir created under first visible root instead of `~/omp-cwd-*`? NO — simpler: 403 for user role (non-technical users pick from visible projects; scratch-cwd creation is admin). Document in code comment.
- [ ] agent/new: existing `isExistingFilePathAllowed` check AND (user role → `isPathVisible(cwd)` else 403).
- [ ] home: unchanged (needed for `~` display; harmless).
- [ ] Tests: browse clamp/reject, validate reject, agent/new 403 for hidden cwd. Commit: `feat: gate cwd browsing and session creation to visible roots (refs #7)`

## Task 8: Worktrees + files filtering

**Files:** Modify `app/api/worktrees/route.ts`, `app/api/files/[...path]/route.ts`, tests.

- [ ] worktrees: GET — user role: `cwd`/`projectRoot` must be visible else 404/403; list filtered to worktrees under visible roots (skip the `allowFileRoot` call for hidden ones). POST/DELETE — allowed when target cwd visible (per user decision), keep `checkCwdAllowed` as-is.
- [ ] files: user role → per-request intersect: `isFilePathAllowed(path, visibleRootsForUser(user, getAllowedFileRoots()))` — NEVER mutate the shared cache. Upload POST same.
- [ ] Tests: user cannot read file under hidden-but-allowed-root; worktree list filtered. Commit: `feat: per-user worktree and file visibility (refs #7)`

## Task 9: Web users admin API

**Files:** Create `app/api/web-users/route.ts`, `app/api/web-users/[username]/route.ts`, tests.

- [ ] GET: list users (safe fields only: username, role, projects, token names/created — never hashes). POST: create `{username, password, role, projects}` → returns generated... no token by default; tokens via subroute. PATCH `[username]`: `{role?, projects?, password?}` — password change re-hashes; prevent demoting/deleting the LAST admin (409). DELETE: same last-admin guard; revoke that user's sessions. `POST [username]/tokens` `{name}` → returns raw token once; `DELETE [username]/tokens/[name]`.
- [ ] All routes: `isApiRequestAllowed` + `hasJsonContentType` (repo idiom) + admin-only (defense in depth — middleware already blocks user role).
- [ ] Tests: CRUD, last-admin guard, safe-field listing, token lifecycle. Commit: `feat: admin web-users management API (refs #7)`

## Task 10: Client UI — web-me gating + WebUsersConfig

**Files:** Create `components/WebUsersConfig.tsx`; modify `components/SettingsConfig.tsx`, `components/AppShell.tsx`, `hooks/` (new `hooks/useWebUser.ts`).

- [ ] `useWebUser`: fetch `/api/auth/web-me` once, expose `{user, refresh}`. AppShell: when `user === null` and auth required (distinguish from auth-disabled via a `authRequired` flag from web-me response), redirect to `/login`. Hide admin UI surfaces for `role: user`: settings sections (models/plugins/mcp/settings/project-trust), worktree controls stay (allowed), custom-cwd picker hidden for user role.
- [ ] SettingsConfig: add `users` to `SettingsSection` union + `CORE_SECTIONS` entry `requiresAdmin: true` (extend the entry type; gate on `useWebUser`), render `<WebUsersConfig cwd={cwd} embedded onClose={...}/>` — copy the McpSettings list/editor layout (SettingsConfig.tsx:339+).
- [ ] WebUsersConfig: user list, create/edit form (username, role select, projects textarea — one absolute root per line, "*" for all), reset password, token create (show raw token once with copy button + "store it now" hint), delete. Uses Task 9 API.
- [ ] Logout control: add to settings modal footer (visible for non-`__anonymous` users) → POST web-logout → `/login`.
- [ ] Verify in browser (Task 12 covers). Commit: `feat: web users admin UI and client role gating (refs #7)`

## Task 11: Docs

**Files:** Modify `README.md` (auth section rewrite), `docs/` (add `docs/web-users.md`).

- [ ] README: cookie + Bearer + migration bridge (`OMP_WEB_PASSWORD`), first-admin setup (env password → login as `omp` → create admin in Web users → remove env var), config file format, TTL, "visibility is UI-level, not a sandbox" warning with per-user-instance recommendation. Canonical hosts: `omp.joyai.dev`, `omp.joysort.cn`.
- [ ] Commit: `docs: web auth and user visibility guide (refs #7)`

## Task 12: Verification & QA

- [ ] `bun run typecheck`, `bun run lint`, `bun test` full suite — compare against baseline (4 pre-existing failures on main: 3 rpc-manager-shutdown, 1 http-dispatcher).
- [ ] Browser smoke on dev instance (5020 or a `next start` worktree build — NEVER `next dev` for latency claims, and never rebuild in the working tree): unauthenticated `/` → /login; login as admin → full UI; create user with one project → login in second context → sees only that project; direct hidden session URL → not-visible state; Bearer curl works; logout clears cookie; terminals still available on 5010 config.
- [ ] Evidence captured; issue #7 progress comment; then finishing-a-development-branch flow (merge to main, deploy 5010+5020 via `systemctl --user restart omp-web.service omp-web-dev.service` from OUTSIDE the hosted session if needed).
