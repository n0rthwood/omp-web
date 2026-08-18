# Issues #14 + #15: Fleet proxy project visibility + Home landing page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Machine-granted users see only their granted projects in proxied session lists (#14), and the app lands on a full-page Home with quick access + weekly calendar + GitHub-issue-aware titles (#15).

**Architecture:** #14 adds a gateway-side response filter at the fleet proxy route: after `proxyToMachine` returns, a `GET /api/sessions` response for a non-admin user with concrete project roots is buffered, filtered through the existing `filterVisibleSessions` predicate, and re-serialized; everything else streams through untouched. #15 introduces a `{kind:"home"}` location: bare `/` (and bare `/m`, `/p`, malformed) resolve through a short `boot → auth → settled(home)` pipeline; `AppShellMachineKey` forks to render `HomePage` (no sidebar, no file panel) which fans out `fetchSessionsFor` over all granted machines. localStorage last-location resume is deleted outright (owner decision "Always Home"; deeplinks still resolve from the URL). Titles: `lib/session-title.ts` passes a web-owned `customSystemPrompt` to the SDK's `generateSessionTitle` (param #7) producing the `Human title (#12 · rel #10, #7)` suffix convention; a pure parser splits that suffix for distinct rendering.

**Tech Stack:** Next.js 16 + Bun, node:test files run with `bun test`, jiti-loaded route tests, hand-rolled i18n registry (en + zh-CN), inline-style components against `app/globals.css` CSS vars.

**Working tree:** `.worktrees/omp14-15`, branch `feature/omp14-15-home-landing` (both issues, one PR).

**Owner decisions locked (do not relitigate):** #14 scope is *list filter only* — session-scoped proxy routes (detail/context/agent/export) stay ungated. #15: "Always Home" (resume retired from the ENTRY path; deeplinks still work); title suffix format `(#12 · rel #10, #7)`; none-or-many for both main and related.

---

### Task 1: #14 — proxied session-list visibility filter (TDD)

**Files:**
- Test: `app/api/machines/[machineId]/proxy-route.test.mjs` (extend existing harness)
- Create: `lib/machines/proxy-response-filter.ts`
- Modify: `app/api/machines/[machineId]/[...path]/route.ts`
- Test: `lib/machines/proxy-response-filter.test.mjs` (pure unit tests)

- [ ] **Step 1.1: Write failing tests** — extend `proxy-route.test.mjs` (reuse `freshStores`, `seed`, `loginAs`, `apiRequest`, `params`, `withStubbedFetch`; add a `limited` user: `projects: ["/opt/granted/a", "/opt/granted/b"]`, `machines: ["gpu-1"]`, and seed machine + sessions exactly like existing tests):

```js
// helper added next to withStubbedFetch — returns a remote /api/sessions payload
async function withStubbedSessionList(payload, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try { return { result: await body(), calls }; } finally { globalThis.fetch = original; }
}

const REMOTE_SESSIONS = {
  sessions: [
    { id: "s-granted", cwd: "/opt/granted/a", projectRoot: "/opt/granted/a", name: "granted one" },
    { id: "s-other", cwd: "/opt/other/wsc_dev", projectRoot: "/opt/other/wsc_dev", name: "wsc dev" },
    { id: "s-worktree", cwd: "/opt/granted/b-wt", projectRoot: "/opt/granted/b", name: "worktree" },
  ],
  runningSessionIds: ["s-granted", "s-other"],
};
```

Cases (one `test(...)` each, `GET` `/api/machines/gpu-1/api/sessions` unless noted):
1. **limited granted user** → `s-other` absent, `s-granted` AND `s-worktree` present (projectRoot anchor counts), `runningSessionIds` = `["s-granted"]`, status 200, content-type json.
2. **admin (`root`)** → body byte-identical to the stub payload (parse and deep-equal `REMOTE_SESSIONS`).
3. **user with `projects: "*"` (`granted`)** → body unchanged.
4. **stub returns `content-type: text/event-stream`** (pass a custom stub) → response body stream passes through untouched (assert the streamed text equals the stub text, and that no filtering error occurs).
5. **stub returns 502 json error** → body passed through unchanged.
6. **session detail path** `/api/machines/gpu-1/api/sessions/some-id` → stub body unfiltered (limited user).
7. **`?force=1` search** → still filtered (route composes search; filter must still apply).

Also create `lib/machines/proxy-response-filter.test.mjs` unit tests for the pure module:
- admin user / `"*"` projects → returns the *same Response object* (no buffering).
- non-json content-type → same object.
- status 404/502 → same object.
- valid payload → filtered sessions + runningSessionIds; `sessions` missing key → passthrough of original text; invalid JSON → original text re-wrapped with same status.

- [ ] **Step 1.2: Run tests, watch them fail**

```bash
cd .worktrees/omp14-15 && bun test "app/api/machines/[machineId]/proxy-route.test.mjs"
```
Expected: new cases fail (unfiltered body leaks `s-other`).

- [ ] **Step 1.3: Implement `lib/machines/proxy-response-filter.ts`**

```ts
import { filterVisibleSessions, type WebUserLike } from "./visibility-shim"; // see note
```
Actually — reuse directly: `import { filterVisibleSessions } from "../web-visibility"; import type { WebUser } from "../web-users";`. Module content:

```ts
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

  const visible = filterVisibleSessions(user, payload.sessions as { cwd: string; projectRoot?: string }[]);
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
```

- [ ] **Step 1.4: Wire into the proxy route** — `app/api/machines/[machineId]/[...path]/route.ts`, replace the final two lines of `handle`:

```ts
const search = new URL(req.url).search;
const response = await proxyToMachine(machine, req, remotePathname, search);
if (isSessionListProxyPath(req.method, remotePathname)) {
  const user = await getWebUserOrSynthetic(req);
  if (user) return applySessionListVisibilityFilter(user, response);
}
return response;
```
with imports `applySessionListVisibilityFilter, isSessionListProxyPath` from `@/lib/machines/proxy-response-filter` and `getWebUserOrSynthetic` from `@/lib/web-auth-context`. (`requireMachineGrant` already proved auth; the re-resolve is a cheap cached lookup and keeps that guard's signature untouched.)

- [ ] **Step 1.5: Watch tests pass**

```bash
bun test "app/api/machines/[machineId]/proxy-route.test.mjs" lib/machines/proxy-response-filter.test.mjs lib/machines/remote-request.test.mjs lib/machines/fleet-gate.test.mjs
```

- [ ] **Step 1.6: Commit** `fix: filter proxied session lists by the caller's project grants (#14)`

---

### Task 2: #15 — title annotations: parser, prompt, cap (TDD)

**Files:**
- Create: `lib/title-annotations.ts` + `lib/title-annotations.test.mjs`
- Modify: `lib/session-title.ts`, `lib/session-title.test.mjs`
- No change needed in `app/api/sessions/[id]/auto-name/route.ts` (prompt lives in the lib wrapper)

- [ ] **Step 2.1: Write failing parser tests** (`lib/title-annotations.test.mjs`) covering: no suffix → `{text: full, annotations: null}`; `(#12)`; `(#12 · #13)`; `(rel #10)`; `(rel #10, #7)`; `(#12 · rel #10, #7)`; suffix not at end → treated as plain text; plain parenthetical `(v2)` → no annotations; empty parens `()` → none; numbers extracted as `number[]`; whitespace before suffix stripped from text.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseTitleAnnotations } from "./title-annotations.ts";

test("combined suffix splits main and related", () => {
  const r = parseTitleAnnotations("Fix fleet proxy visibility (#14 · rel #10, #7)");
  assert.deepEqual(r.annotations, { main: [14], related: [10, 7] });
  assert.equal(r.text, "Fix fleet proxy visibility");
});
// …plus every case above
```

- [ ] **Step 2.2: Run, watch fail** (`bun test lib/title-annotations.test.mjs`)

- [ ] **Step 2.3: Implement `lib/title-annotations.ts`** (pure, no SDK imports — client-safe):

```ts
/** Suffix grammar: `(` mains? (` · `)? related? `)` with at least one part present.
 *  mains: `#12` joined by " · " (bare). related: `rel #10` then ", #7" (prefixed). */
export interface TitleAnnotations { main: number[]; related: number[] }

export function parseTitleAnnotations(name: string): { text: string; annotations: TitleAnnotations | null } {
  const match = name.match(/\s+\(([^()]*)\)\s*$/);
  if (!match) return { text: name, annotations: null };
  const parts = match[1].split(" · ").filter((p) => p.length > 0);
  const main: number[] = [];
  const related: number[] = [];
  let seenRelated = false;
  for (const part of parts) {
    if (part.startsWith("rel ")) {
      seenRelated = true;
      for (const item of part.slice(4).split(",")) {
        const n = parseBareIssue(item.trim());
        if (n === null) return { text: name, annotations: null };
        related.push(n);
      }
    } else {
      if (seenRelated) return { text: name, annotations: null }; // related must be last
      const n = parseBareIssue(part);
      if (n === null) return { text: name, annotations: null };
      main.push(n);
    }
  }
  if (main.length === 0 && related.length === 0) return { text: name, annotations: null };
  return { text: name.slice(0, match.index).trimEnd(), annotations: { main, related } };
}

function parseBareIssue(value: string): number | null {
  const m = value.match(/^#(\d+)$/);
  return m ? Number(m[1]) : null;
}
```

- [ ] **Step 2.4: session-title changes** — in `lib/session-title.ts`:
  - `MAX_TITLE_LENGTH = 80` → `120` (suffix `(#12 · rel #10, #7)` costs ~25 chars on top of a 3-7 word title).
  - Add the web-owned system prompt constant:

```ts
/**
 * Web-owned title prompt (issue #15). The SDK appends its own marker
 * instruction after this (answer inside <title>...</title>; no-task →
 * <title>none</title>) — our no-task wording uses <title/> per the agreed
 * protocol, and `isDeclinedTitle` treats a literal "none" as a decline so
 * whichever instruction the model follows converges on the same outcome.
 */
const WEB_TITLE_SYSTEM_PROMPT = [
  "Write a concise 3-10 word title for the task in <user>.",
  "Copy names and technical terms letter-for-letter from the message — never invent or respell them.",
  "When the user's message references GitHub issues, append an issue annotation suffix inside the same <title> tags, after the human title:",
  "- the issue(s) this task is mainly about: bare numbers prefixed with #, joined by \" · \" — e.g. #12 or #12 · #13;",
  "- issues mentioned only as related context: after \"rel \", prefixed with #, comma-joined — e.g. rel #10, #7;",
  "- both kinds may be absent, single, or multiple; never invent issue numbers — only use numbers literally present in the message;",
  "- example result: Fix login redirect (#12 · rel #10, #7).",
  "If there is no task (a bare greeting or small talk), answer <title/>.",
].join("\n");

/** The SDK's appended marker instruction tells the model to answer <title>none</title> for no-task; treat that literal as a decline. */
function isDeclinedTitle(title: string): boolean {
  return title.toLowerCase() === "none";
}
```
  - In `generateSessionTitle`: pass the prompt as SDK param #7 — `generateOmpSessionTitle(firstMessage, session.modelRegistry, session.settings, session.sessionId, session.model, undefined, WEB_TITLE_SYSTEM_PROMPT)` — and after `truncateTitle`, `if (isDeclinedTitle(cleaned)) return null;` before the letter/number validation.
- [ ] **Step 2.5: Update `lib/session-title.test.mjs`** — the existing 80-cap assertion becomes 120; add `truncateTitle` whitespace-collapse case unchanged; add a unit for `isDeclinedTitle` behavior via a tiny exported helper if needed (export `isDeclinedTitle` for testability).
- [ ] **Step 2.6: Run** `bun test lib/title-annotations.test.mjs lib/session-title.test.mjs` — all pass.
- [ ] **Step 2.7: Commit** `feat: GitHub-issue-aware session titles via SDK customSystemPrompt (#15)`

---

### Task 3: #15 — Always Home navigation (TDD)

**Files:**
- Modify: `lib/nav-url.ts`, `lib/nav-state.ts`, `components/NavigationProvider.tsx`, `components/AppShell.tsx`, `components/SessionSidebar.tsx`
- Test: `lib/nav-url.test.mjs` (create if absent), `lib/nav-state.test.mjs` (rewrite resume cases), `components/AppShell.navigation.test.mjs` (lockstep check only — must keep passing)

Contract (fixed up front, Task 4 depends on it):
- `ParsedLocation` kind `"resume"`/`"root"` are REPLACED by `"home"`: `parsePath` returns `{kind:"home"}` for `""`, `"/"`, bare `/m`, bare `/p`, and every malformed shape previously `"root"`. Legacy `?machine=`/`?session=`/`?cwd=` still produce `{kind:"target"}` (explicit deeplinks).
- `NavIntent` becomes `{ target; source: "url" } | { home: true }`. `resolveIntent(parsed)` drops its `storage` parameter.
- `NavResult` non-error variant gains required `home: boolean` (false on all target settles). Settled-home result: `{ phase: "settled", target: {machineId:"local",project:null,session:null}, session: null, error: null, source: "home", home: true }` — reached after `boot → auth` phases only.
- `NavSource = "url" | "home"`. `NavDeps` loses `storage`. `readLastLocation`/`writeLastLocation`/`LastLocation`/`LAST_LOCATION_KEY` are DELETED (clean cutover — no callers left).
- `NavigationContextValue` gains `goHome(): void` — `writeAddressBar("/", "push")` then `resolverRef.current!.run(parseLocation("/", ""), buildDeps())`.
- `AppShellMachineKey` forks: settled home result → `<HomePage onOpen={...}/>`; otherwise `AppShellBody` as today. The `#12` guard test's asserted strings (wrapper nesting, `AppShellBodyProps`, `window.history.pushState(null, "", url)`) must remain verbatim — fork INSIDE `AppShellMachineKey`, never inside `AppShellBody`.
- SessionSidebar header gains a persistent Home button calling `goHome()` (icon + `t("home.title")`).

- [ ] **Step 3.1: Failing nav-url tests** — `parseLocation("/")` → `{kind:"home"}`; `""` → home; `/m` → home; `/p` → home; `/xyz` → home; `/m/gpu-1` → target; `/p/opt%2Fx/s/id` → target; `?session=abc` → target; trailing-slash `/m/x/` → target.
- [ ] **Step 3.2: Run, watch fail** (`bun test lib/nav-url.test.mjs` — create the file; check whether one already exists first).
- [ ] **Step 3.3: Implement nav-url change** (kind renames + `home` returns; `buildUrl` unchanged).
- [ ] **Step 3.4: Failing nav-state tests** — rewrite `lib/nav-state.test.mjs` resume/default cases:
  - `resolveIntent({kind:"home"})` → `{home:true}`; `resolveIntent(target)` → `{target, source:"url"}` (no storage arg).
  - Resolver run with a home location: emits boot → auth → settled with `home:true`, `source:"home"`, never calls `listMachines`/`listSessions`/`onMachineCommit`, never writes storage.
  - Target runs unchanged: `/m/<id>` deeplink still resolves defaults (existing tests, updated only for the new `NavResult.home` field and removed storage dep).
- [ ] **Step 3.5: Implement nav-state change** — union change, `home` short-pipeline in `resolve()`, delete resume block, update every `emit` site to carry `home:false`, delete `writeLastLocation` call at settle (line ~428).
- [ ] **Step 3.6: NavigationProvider** — remove `writeLastLocation` import/usage + `LAST_LOCATION_STORAGE_KEY` + `getStorage` + `deps.storage`; add `home` passthrough in context value (as `result.home`); add `goHome`; keep `writeAddressBar` and popstate handler EXACTLY as-is (guard test). Loading gate unchanged (home settles after auth). 
- [ ] **Step 3.7: AppShell fork + sidebar button** — `AppShellMachineKey`: `const { target, session, resolutionRevision, home } = useNavigation();` → if `home` render `<HomePage/>`, else `AppShellBody`. SessionSidebar header: Home button (reuse existing header button styles; `title={t("home.title")}`).
- [ ] **Step 3.8: Run all nav tests** — `bun test lib/nav-url.test.mjs lib/nav-state.test.mjs components/AppShell.navigation.test.mjs components/NavigationProvider` (any existing provider tests) — green.
- [ ] **Step 3.9: Commit** `feat: Always Home entry — retire last-location resume, add {kind:home} nav (#15)`

---

### Task 4: #15 — HomePage + weekly calendar + i18n

**Files:**
- Create: `lib/calendar-week.ts` + `lib/calendar-week.test.mjs`, `components/HomePage.tsx`, `components/HomeCalendar.tsx`
- Modify: `lib/i18n/messages/en.ts`, `lib/i18n/messages/zh-CN.ts`

- [ ] **Step 4.1: Failing `lib/calendar-week.test.mjs`** — pure helpers: `weekStartDate(referenceDate, firstWeekday)` (Monday-first when firstWeekday=1, Sunday-first when 0; correct across month/year boundaries); `daysOfWeek(weekStart)` → 7 Dates; `localDayKey(date)` → `YYYY-MM-DD`; `groupSessionsByDay(sessions)` → `Map<string, SessionInfo[]>` by `modified`, sorted desc within a day.
- [ ] **Step 4.2: Implement `lib/calendar-week.ts`** (native Date only, no new deps).
- [ ] **Step 4.3: i18n keys** — add to BOTH `en.ts` and `zh-CN.ts` under `home.*`: `home.title` (Home / 主页), `home.welcome.title`, `home.welcome.body`, `home.quickAccess` (Quick access / 快速访问), `home.noProjects`, `home.machineOffline`, `home.refresh`, `home.today` (Today / 本周), `home.previousWeek`, `home.nextWeek`, `home.noConversationsThisWeek`, `home.mainIssues` (aria: main issues), `home.relatedIssues` (aria: related issues).
- [ ] **Step 4.4: `components/HomePage.tsx`** — client component. `useMachines()`; fan-out `Promise.all(machines.map(m => fetchSessionsFor(m.id).catch(() => null)))` once machines load (per-machine null → offline row). Per machine: group by `projectRoot ?? cwd`, order via `mostRecentProjectRoots`, render machine header + project cards (basename label, `formatRelativeTime` last activity, click → select). Selected machine+project → bottom `<HomeCalendar sessions={projectSessions} onOpen={...}/>`; none selected → welcome message only. `onOpen(session)` → `navigate({machineId, project, session: session.id}, {history:"push"})`. Full-page layout following `LoginForm.tsx` inline-style + CSS-var conventions (`position:fixed; inset:0; background:var(--bg)` etc.), overflow-y auto.
- [ ] **Step 4.5: `components/HomeCalendar.tsx`** — `weekOffset` state (0 = current week); `firstWeekday` from `new Intl.Locale(locale).weekInfo?.firstDay` guarded to default 1; 7 day sections with weekday+date headers (`Intl.DateTimeFormat`), sessions under each day (full untruncated title via `session.name || session.firstMessage`, wrap allowed); annotations via `parseTitleAnnotations` — main issues rendered as accent-colored `#N` chips, related as muted `rel #N` chips; click → `onOpen(session)`; Prev/Next/Today buttons + week label (`Aug 12 – 18` via `Intl`); empty week → `t("home.noConversationsThisWeek")`.
- [ ] **Step 4.6: Run** `bun test lib/calendar-week.test.mjs` + `bun run typecheck`.
- [ ] **Step 4.7: Commit** `feat: Home landing page with machine/project quick access and weekly calendar (#15)`

---

### Task 5: Verification

- [ ] `bun run typecheck`, `bun run lint`, full `bun test` per repo convention (scoped dirs — remember `package.json` names source dirs; whole-dir `bun test lib` trips Bun#5090, run scoped files/batches).
- [ ] Production build IN THE WORKTREE: `PATH=$HOME/.bun/bin:$PATH bun run build` then `bun run start`-equivalent (see AGENTS.md perf recipe) on a scratch port.
- [ ] Browser-drive as admin: bare `/` → Home (no sidebar/file panel); quick access lists machines→projects; project click → calendar; conversation click → correct `/m/<id>/p/<proj>/s/<sid>` deeplink; sidebar Home button returns Home; back button works.
- [ ] Browser-drive as `dong` (or an equivalent seeded limited user on the dev instance): `joysort202` group shows only granted projects; `wsc_dev` absent; local list unchanged.
- [ ] `node .gitnexus/run.cjs detect-changes` (or `npx gitnexus analyze` fallback) — confirm blast radius matches plan.
- [ ] PR → merge to main (`closes #14`, `closes #15`).

### Task 6: Fleet deployment (gateway LAST)

Follow `omp-web-fleet-wide-rollout` skill: verify zero running sessions on all 6 hosts, then remotes one at a time (`.250 .24 .109 .202 .39`: pull, bun install, build, restart, proxy health check), then gateway (build once in repo root, restart `omp-web.service` + `omp-web-dev.service` back-to-back), tunnel check `https://omp.joyai.dev/api/health`, dong manual pass through the tunnel, progress comments on #14 and #15.
