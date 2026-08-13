# Terminal Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-owned, interactive shell ("Terminal" tab) to omp-web, scoped to the selected workspace root, gated off by default.

**Architecture:** `Bun.Terminal` (native, Bun >=1.3.14 — verified working end-to-end in `/tmp/bun-terminal-spike/RESULTS.md`) backs a `globalThis`-keyed terminal registry (mirrors `globalThis.__ompSessions` in `lib/rpc-manager.ts`) with a bounded replay buffer. SSE down (`GET /api/terminals/[id]/events`) + POST up (input/resize), matching `app/api/agent/[id]/events/route.ts`. Client renders with `@xterm/xterm`, keys encoded via the existing `lib/terminal-input.ts`.

**Tech Stack:** Bun.Terminal, Next.js App Router route handlers, `@xterm/xterm` + `@xterm/addon-fit`, React.

**Tracks:** GitHub issue `n0rthwood/omp-web#1`. Branch `feature/omp1-terminal-shell`. Commits must read `... (closes #1)` on the final one.

---

## Backend decision (record in AGENTS.md)

`Bun.Terminal` chosen over a Node sidecar or `script -qfc`. Verified on Bun 1.3.14 (this repo now requires `>=1.3.14`, already true in `package.json`): the read side is a `data(terminal, chunk: Uint8Array)` callback passed in the constructor — **not** `.readable`, not an async iterator, not `onData` (that's what made the 1.3.12 spike hang: it probed surfaces that don't exist). `write()`, `resize()`, `setRawMode()`, and the `exit` callback are all confirmed working, including a real pty (bracketed-paste sequences observed) and live resize reflected by the child's own `stty size`. One caveat: `Bun.spawn({terminal})` does not make the pty the child's *controlling* terminal, so job control breaks unless the shell is spawned through `setsid -c` — verified fix, use it.

## File map

**New:**
- `lib/terminals/terminal-service.ts` — registry + Bun.Terminal lifecycle
- `lib/terminals/terminal-gate.ts` — feature flag + host/password gate
- `app/api/terminals/status/route.ts` — `GET` → `{ enabled }`
- `app/api/terminals/route.ts` — `GET` list, `POST` create
- `app/api/terminals/[id]/route.ts` — `DELETE` close
- `app/api/terminals/[id]/input/route.ts` — `POST` write
- `app/api/terminals/[id]/resize/route.ts` — `POST` resize
- `app/api/terminals/[id]/events/route.ts` — `GET` SSE
- `components/TerminalPanel.tsx` — xterm.js pane
- `lib/terminal-tabs.ts` — localStorage persistence of open terminal tab ids per cwd

**Modified:**
- `components/TabBar.tsx` — `Tab.kind: "file" | "terminal"`, terminal icon
- `components/AppShell.tsx` — terminal tab state, open/close/reattach wiring, "New Terminal" affordance
- `components/FileIcons.tsx` — add `TerminalIcon`
- `package.json` — add `@xterm/xterm`, `@xterm/addon-fit`
- `README.md` — document `OMP_WEB_TERMINALS`, and that enabling it makes the web UI a shell
- `AGENTS.md` — record the `Bun.Terminal` decision (short section, not a rewrite)

---

## API contract (both tasks build to this; do not renegotiate)

### Types (put in `lib/api-types.ts` alongside existing shared types)

```ts
export interface TerminalInfo {
  id: string;
  cwd: string;
  name: string;
  createdAt: string; // ISO
  exited: boolean;
  exitCode?: number;
}
```

### `GET /api/terminals/status`
No params. Guard: `isApiRequestAllowed(req)` only (no cwd, no feature check — this route's whole job is to report whether the feature is on).
Response `200`: `{ "enabled": boolean }`.

### `GET /api/terminals?cwd=<abs path>`
Guards, in order: `isApiRequestAllowed` (403) → feature gate via `isTerminalFeatureAvailable()` (404, same body shape as "not found" — do not leak *why*) → `cwd` present (400) → cwd within `getAllowedFileRoots()` via `isExistingFilePathAllowed` (403).
Response `200`: `TerminalInfo[]` — every non-closed terminal for that cwd (closed ones are removed from the registry immediately after their exit event has been delivered to all current subscribers, so the list never grows unbounded).

### `POST /api/terminals`
Body: `{ cwd: string; cols?: number; rows?: number; name?: string }`. Same guards as `GET` (cwd from body, not query) plus `hasJsonContentType`.
`cols`/`rows` default `80`/`24` if omitted or invalid (non-finite / <=0).
Response `201`: `TerminalInfo` for the newly spawned terminal.

### `DELETE /api/terminals/[id]`
Guards: `isApiRequestAllowed`, feature gate. No cwd check needed (the id itself is the capability). Idempotent — an unknown or already-closed id is not an error (see response shape below): a client racing a page reload against a manual close must not see a failure.
Kills the pty (process group, see below), removes it from the registry.
Response `200`: `{ "closed": true }`. Unknown id → `200 { "closed": true }` as well (idempotent close — a client racing a page reload against a manual close should not see an error).

### `POST /api/terminals/[id]/input`
Body: `{ data: string }`. Guards: `isApiRequestAllowed`, feature gate, `hasJsonContentType`, id exists (404) and is not exited (409 `{ "error": "Terminal has exited" }`).
Writes `data` verbatim to the pty (already ANSI-encoded by the client via `lib/terminal-input.ts`).
Response `200`: `{ "written": true }`.

### `POST /api/terminals/[id]/resize`
Body: `{ cols: number; rows: number }`. Same guards as `input`. Reject (`400`) non-finite or <=0 values.
Response `200`: `{ "resized": true }`.

### `GET /api/terminals/[id]/events` (SSE)
Guards: `isApiRequestAllowed`, feature gate, id exists (404 plain `Response`, matching `app/api/agent/[id]/events/route.ts`'s style — SSE routes return plain `Response`, not `NextResponse.json`, on the early-exit paths).
`export const dynamic = "force-dynamic";` — copy this from the agent events route.

On connect, in order:
1. `data: {"type":"connected","id":"<id>"}\n\n`
2. Immediately call `subscribeTerminal(id, listener)`, where `listener` encodes each event it receives as an SSE frame. `subscribeTerminal` itself delivers the replay buffer (if non-empty, as one `{"type":"output","data":"<buffered text>"}` frame — do **not** add a separate `"replay":true` framing step in the route; the buffer replay is `subscribeTerminal`'s job, not the route's) and the exit state (if already exited) synchronously to the listener before returning, then keeps delivering live events. **The route must not also manually re-send the buffer** — that would double the scrollback on every connect.
3. Every subsequent pty chunk → `{"type":"output","data":"<chunk>"}`; on process exit → `{"type":"exit","exitCode":<number|null>}` once, then the server may close the stream (`controller.close()`) after flushing it — the client should treat `exit` as terminal and stop reconnecting.
4. Heartbeat every 30s (`":\n\n"`), identical to the agent events route.
5. Cleanup identical pattern: `req.signal.addEventListener("abort", cleanup)` unsubscribes and clears the heartbeat interval. **Do not kill the pty on SSE disconnect** — only explicit `DELETE` kills it. A disconnect is a normal page reload/backgrounding event; the shell must keep running so scrollback + a running command survive it.

---

## `lib/terminals/terminal-gate.ts` — feature flag + host gate

```ts
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isEnvFlagEnabled(value: string | undefined): boolean {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

/** Off unless explicitly enabled with `OMP_WEB_TERMINALS=1` (or true/yes/on). */
export function isTerminalFeatureEnabled(): boolean {
  return isEnvFlagEnabled(process.env.OMP_WEB_TERMINALS);
}

/**
 * A terminal is a full shell. Refuse to serve it on a non-loopback bind
 * unless a web password is configured — mirrors the warning in
 * `bin/omp-web.js`, but blocking instead of advisory, because this feature
 * is strictly higher-risk than the rest of the API surface.
 */
export function isTerminalHostGateSatisfied(): boolean {
  const hostname = process.env.OMP_WEB_HOSTNAME ?? "127.0.0.1";
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return isWebPasswordEnabled(); // from "@/lib/web-auth"
}

export function isTerminalFeatureAvailable(): boolean {
  return isTerminalFeatureEnabled() && isTerminalHostGateSatisfied();
}
```

Import `isWebPasswordEnabled` from `lib/web-auth.ts` (already exists, checks `process.env.OMP_WEB_PASSWORD`). `OMP_WEB_HOSTNAME` is already forwarded into the Next.js process env by `bin/omp-web.js` (see `bin/omp-web.js:86`); when the dev server is started directly via `bun run dev` (`-H 127.0.0.1` hardcoded in `package.json`) the variable is unset, so the `?? "127.0.0.1"` default must hold — do not require the variable to be set.

Do **not** wire anything through `lib/project-trust.ts` — that module gates *automatic* extension/MCP loading for a project; it has no bearing on a terminal, which is a human typing into a shell they already chose to open in an already-allow-listed cwd. Scoping to `lib/file-access.ts`'s allow-list is the only boundary that applies.

---

## `lib/terminals/terminal-service.ts`

```ts
import { randomUUID } from "crypto";

const MAX_REPLAY_BUFFER = 200_000; // chars, mirrors pi-web's terminalService.ts

export interface TerminalInfo {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
}

interface TerminalRecord extends TerminalInfo {
  term: Bun.Terminal;
  proc: Bun.Subprocess;
  buffer: string;
  listeners: Set<TerminalListener>;
}

type TerminalStreamEvent =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null };

type TerminalListener = (event: TerminalStreamEvent) => void;

declare global {
  var __ompTerminals: Map<string, TerminalRecord> | undefined;
}

function registry(): Map<string, TerminalRecord> {
  if (!globalThis.__ompTerminals) globalThis.__ompTerminals = new Map();
  return globalThis.__ompTerminals;
}

export function listTerminals(cwd: string): TerminalInfo[] {
  return [...registry().values()].filter((t) => t.cwd === cwd).map(toInfo);
}

export function getTerminalInfo(id: string): TerminalInfo | undefined {
  const record = registry().get(id);
  return record ? toInfo(record) : undefined;
}

export function createTerminal(options: { cwd: string; cols?: number; rows?: number; name?: string }): TerminalInfo {
  const id = randomUUID();
  const cols = isPositiveFiniteInt(options.cols) ? options.cols : 80;
  const rows = isPositiveFiniteInt(options.rows) ? options.rows : 24;
  const shell = process.env.SHELL || "/bin/bash";
  const decoder = new TextDecoder();
  const record: TerminalRecord = {
    id,
    cwd: options.cwd,
    name: options.name || shell.split("/").pop() || "shell",
    createdAt: new Date().toISOString(),
    exited: false,
    buffer: "",
    listeners: new Set(),
    // term/proc assigned right after construction; declared via `as` below
  } as TerminalRecord;

  const term = new Bun.Terminal({
    cols,
    rows,
    name: "xterm-256color",
    data: (_t, chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      appendToBuffer(record, text);
      fanout(record, { type: "output", data: text });
    },
    exit: (_t, exitCode) => {
      record.exited = true;
      record.exitCode = exitCode;
      fanout(record, { type: "exit", exitCode });
      // Keep the record (and its buffer) around so a client that reconnects
      // right after exit still sees the final output + exit event on
      // subscribe, then let it be pruned on next `listTerminals`/explicit close.
    },
  });
  record.term = term;

  record.proc = Bun.spawn(["setsid", "-c", shell, "-i"], {
    cwd: options.cwd,
    terminal: term,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  registry().set(id, record);
  return toInfo(record);
}

export function writeToTerminal(id: string, data: string): "ok" | "not-found" | "exited" {
  const record = registry().get(id);
  if (!record) return "not-found";
  if (record.exited) return "exited";
  record.term.write(data);
  return "ok";
}

export function resizeTerminal(id: string, cols: number, rows: number): "ok" | "not-found" | "exited" {
  const record = registry().get(id);
  if (!record) return "not-found";
  if (record.exited) return "exited";
  record.term.resize(cols, rows);
  return "ok";
}

export function subscribeTerminal(id: string, listener: TerminalListener): (() => void) | undefined {
  const record = registry().get(id);
  if (!record) return undefined;
  if (record.buffer) listener({ type: "output", data: record.buffer });
  if (record.exited) listener({ type: "exit", exitCode: record.exitCode ?? null });
  record.listeners.add(listener);
  return () => record.listeners.delete(listener);
}

export function closeTerminal(id: string): void {
  const record = registry().get(id);
  if (!record) return;
  registry().delete(id);
  try {
    // Spawned via `setsid -c`, so the shell is its own process-group leader —
    // signal the whole group so TUI children (vim, htop, …) die too, not
    // just the shell. Fall back to proc.kill() if the pid is unknown/gone.
    if (record.proc.pid) process.kill(-record.proc.pid, "SIGTERM");
  } catch { /* already gone */ }
  try { record.term.close(); } catch { /* already closed */ }
  // Escalate if it doesn't die quickly.
  setTimeout(() => {
    try { if (record.proc.pid) process.kill(-record.proc.pid, "SIGKILL"); } catch { /* gone */ }
  }, 2000);
}

function toInfo(record: TerminalRecord): TerminalInfo {
  return { id: record.id, cwd: record.cwd, name: record.name, createdAt: record.createdAt, exited: record.exited, exitCode: record.exitCode };
}

function fanout(record: TerminalRecord, event: TerminalStreamEvent): void {
  for (const listener of record.listeners) listener(event);
}

function appendToBuffer(record: TerminalRecord, text: string): void {
  record.buffer += text;
  if (record.buffer.length > MAX_REPLAY_BUFFER) {
    record.buffer = record.buffer.slice(record.buffer.length - MAX_REPLAY_BUFFER);
  }
}

function isPositiveFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
```

Implementer: this is a complete reference implementation, not pseudocode — adapt only where TypeScript strictness demands it (e.g. the `as TerminalRecord` cast above is a known wart; a cleaner pattern is to build `term`/`proc` first in local `let` bindings and assemble `record` in one object literal — prefer that over the cast if it typechecks cleanly against `tsc --noEmit`).

Write a `bun test`-compatible test file `lib/terminals/terminal-service.test.ts` (Bun's built-in test runner, matching existing `.test.mjs`/`.test.ts` files in `lib/`) covering: create → write → observe output via a manual subscribe listener (echo a marker string, assert it appears in a captured event within a few seconds); resize does not throw; close terminates the process (poll `process.kill(pid, 0)` throwing ESRCH, bounded retries) and removes it from `listTerminals`; a second `closeTerminal` on an already-closed id is a no-op.

---

## Routes

All five routes follow the exact guard-order/response-shape spelled out in "API contract" above, and the exact `isApiRequestAllowed` / `hasJsonContentType` usage already used by every other route (see `app/api/agent/[id]/route.ts`, `app/api/models-config/route.ts` for the idiom — import from `@/lib/request-security`). Use `getAllowedFileRoots()` + `isExistingFilePathAllowed()` from `@/lib/file-access.ts` for the cwd check (same functions `app/api/plugins/route.ts` and `app/api/skills/route.ts` already use). The SSE route copies the `ReadableStream` scaffold from `app/api/agent/[id]/events/route.ts` verbatim (encoder, heartbeat, abort cleanup), swapping the event source for `subscribeTerminal`.

---

## `AGENTS.md` addition

Add a short subsection (near the other "Key Design Decisions & Traps" entries) titled `### Terminal tab — Bun.Terminal, not node-pty`, stating: node-pty is dead on Bun (`onData` never fires — verified, see `HANDOFF.md`); `Bun.Terminal`'s read side is a `data` callback in the constructor, not a stream/iterator (this is the part that isn't obvious from probing); shells must spawn through `setsid -c` to get a controlling terminal / job control; killing a terminal signals the negative pid (process group) so TUI children don't orphan.

## `README.md` addition

In the "Features" section (or add one), document:
```
OMP_WEB_TERMINALS=1 omp-web   # enable the Terminal tab (off by default)
```
State plainly: enabling this turns the web UI into a full shell for whoever can reach it — same trust boundary as the agent itself. On a non-loopback bind it refuses to activate unless `OMP_WEB_PASSWORD` is also set.

---

## Frontend

### `Tab` type (`components/TabBar.tsx`)

```ts
export interface Tab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff";
  kind?: "file" | "terminal"; // default "file" when absent — every existing call site is unaffected
  terminalId?: string; // present when kind === "terminal"; the server-side terminal id
}
```

Icon selection inside `TabBar`'s render: `tab.kind === "terminal" ? <TerminalIcon size={13} /> : getFileIcon(tab.label, 13)`.

### `components/FileIcons.tsx` — add

```tsx
export function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2 3h12v10H2V3Z" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" />
      <path d="M4 6.5 6.5 8.5 4 10.5" stroke={DIM} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10.5H11" stroke={DIM} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
```
(Follow the file's existing monochrome/`DIM` convention exactly — do not introduce a new color or a different stroke style.)

### `lib/terminal-tabs.ts` — localStorage persistence

Page reload must reattach to a still-live terminal (acceptance criterion). Tabs today are in-memory-only (`AppShell`'s `fileTabs` state is not persisted across a full reload either — that is pre-existing behavior, out of scope to change). Terminals need it because the *server-side process* actually survives a reload, so the UI should catch back up to it.

```ts
const STORAGE_PREFIX = "omp-web-terminal-tabs:";

export interface PersistedTerminalTabs {
  ids: string[];
  activeId: string | null;
}

export function loadTerminalTabs(cwd: string): PersistedTerminalTabs {
  if (typeof window === "undefined") return { ids: [], activeId: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + cwd);
    if (!raw) return { ids: [], activeId: null };
    const parsed = JSON.parse(raw) as Partial<PersistedTerminalTabs>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((v): v is string => typeof v === "string") : [];
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
    return { ids, activeId };
  } catch {
    return { ids: [], activeId: null };
  }
}

export function saveTerminalTabs(cwd: string, tabs: PersistedTerminalTabs): void {
  if (typeof window === "undefined") return;
  try {
    if (tabs.ids.length === 0) window.localStorage.removeItem(STORAGE_PREFIX + cwd);
    else window.localStorage.setItem(STORAGE_PREFIX + cwd, JSON.stringify(tabs));
  } catch { /* storage unavailable/full — persistence is best-effort */ }
}
```

### `components/TerminalPanel.tsx`

Props: `{ terminalId: string; onExit?: (exitCode: number | null) => void }`. Responsibilities:
- Dynamically `import("@xterm/xterm")` and `import("@xterm/addon-fit")` inside a `useEffect` (client-only — xterm touches `document`; do **not** static-import at module top, Next.js SSR will break on it). Construct `new Terminal({ convertEol: false, fontFamily: "var(--font-mono)", cursorBlink: true, theme: <derive from CSS vars: background var(--bg), foreground var(--text), cursor var(--accent) — read via `getComputedStyle` on a ref element, matching the `terminalTheme()` idea in pi-web's `TerminalPanel.ts` but pulling from *this* repo's own CSS variables listed in `AGENTS.md`'s "CSS Variables" section> })`, `loadAddon(new FitAddon())`, `open(containerRef.current)`, then `fitAddon.fit()`.
- Open `new EventSource(`/api/terminals/${encodeURIComponent(terminalId)}/events`)` (same idiom as `hooks/useAgentSession.ts:675`). On `message`: `JSON.parse(event.data)`; `type === "output"` → `term.write(data)`; `type === "exit"` → call `onExit?.(exitCode)` and close the EventSource.
- On xterm `onData` (user types/pastes): `POST /api/terminals/${id}/input` with `{ data }` — send the raw string xterm already gives you (xterm's `onData` already emits the correct ANSI-encoded bytes for regular typing; you do **not** need `lib/terminal-input.ts` for that path). Use `lib/terminal-input.ts`'s `toTerminalKeyData` only if you need to special-case a browser `keydown` you intercept before xterm sees it (e.g. to stop the browser from swallowing a shortcut) — check first whether xterm's own `onData` already produces the right byte sequence for arrows/Ctrl-C/Tab before adding a redundant path; xterm's `onData` is already ANSI-aware for terminal input, so **do not double-encode**. Reuse `asBracketedPaste` only if you intercept a browser paste event yourself instead of letting xterm's native paste handling run.
- Debounce input POSTs minimally: batch keystrokes arriving within the same microtask/animation frame into one POST (xterm's `onData` already fires per logical input chunk, typically already batched for fast typing/paste — a naive one-`fetch`-per-callback is acceptable given how `onData` batches; do not add artificial batching complexity beyond that).
- `ResizeObserver` on the container → `fitAddon.fit()` → on actual `(cols, rows)` change, `POST /api/terminals/${id}/resize`.
- Cleanup on unmount: dispose the xterm instance, close the `EventSource`, disconnect the `ResizeObserver`. **Do not** call `DELETE /api/terminals/${id}` on unmount — that only happens when the user explicitly closes the tab (see AppShell wiring below). Unmount happens on every navigation/reload; killing the shell there would violate the "reload reattaches" acceptance criterion.

### `components/AppShell.tsx` wiring

- Add `terminalsEnabled` state, fetched once via `GET /api/terminals/status` on mount (and whenever `activeCwd` changes is not necessary — this is a server-wide flag, fetch once).
- Extend the existing `fileTabs`/`activeFileTabId` state to also carry terminal tabs in the *same* `Tab[]` array (the acceptance criterion says "alongside Chat and file tabs" in one `TabBar`) — i.e. do not add a second `TabBar`. A terminal `Tab` has `kind: "terminal"`, `filePath: <terminal name>` (for the label), and a new field on `Tab`, `terminalId?: string`, holding the server-side terminal id (add this field alongside `kind` in the same interface edit above).
- "New Terminal" affordance: a button near the existing right-panel controls (follow the placement/styling of the file-panel toggle button around `AppShell.tsx:1600`), visible only when `terminalsEnabled && activeCwd`. On click: `POST /api/terminals { cwd: activeCwd }` → push a new `Tab` (`kind:"terminal"`, `terminalId: info.id`, `filePath: info.name`, `id: `terminal-${info.id}``) into the tab array, set it active, persist via `saveTerminalTabs`.
- On `activeCwd` change (and on mount once `terminalsEnabled` is known): call `loadTerminalTabs(activeCwd)`; for each persisted id, `GET /api/terminals?cwd=activeCwd` (list) and keep only ids still present (still-live terminals) — re-add those as tabs (do **not** call `POST` again, that would spawn a second shell); drop ids no longer listed. Restore `activeId` if it survived, else fall back to whatever tab is first/active already.
- On tab close (`onCloseTab`) for a terminal tab specifically: `DELETE /api/terminals/${terminalId}`, remove from the tab array, update persisted storage. File tabs keep their existing close behavior unchanged.
- Whenever the terminal tab set or active id changes, call `saveTerminalTabs(activeCwd, { ids, activeId })`.
- Content pane: where `FileViewer` is rendered today (`AppShell.tsx:1577-1595`), branch on `activeTab.kind`: `"terminal"` → `<TerminalPanel terminalId={activeTab.terminalId!} onExit={...}/>`, else the existing `FileViewer` branch unchanged.

### `package.json`

Add to `dependencies` (client-rendered, ships to the browser bundle — not a `devDependency`): `"@xterm/xterm": "^6.0.0"`, `"@xterm/addon-fit": "^0.11.0"` (pin to the same major/minor pi-web already ships, per `HANDOFF.md`/pi-web's own `package.json`, to start from a version known to work with recent Node/browser targets). Run `bun install` after editing.

---

## Verification (integration task, after both tracks land)

1. `bun run typecheck` and `bun run lint` — must pass with zero new errors.
2. `bun test` — new `terminal-service.test.ts` passes; no existing test regresses.
3. Start the dev server with `OMP_WEB_TERMINALS=1 bun run dev` (background via the `hub` process tool, not bare `bash`, since it's long-running) and browser-drive (`browser` tool) through `AppShell`:
   - Confirm no Terminal tab/button appears with the feature flag **unset** (restart the dev server without the env var first, verify absence, then restart with it set for the rest of the checks).
   - Open a terminal, run `echo hello-terminal-check`, observe the output rendered.
   - Run `vim` then `:q`, confirm the alternate-screen render and exit both work; run `htop` (or `top` if `htop` is unavailable) briefly and confirm live redraw, then quit it.
   - Send Ctrl-C to a long-running command (e.g. `sleep 100`) and confirm it interrupts.
   - Reload the page: confirm the terminal tab reappears with prior scrollback visible and the shell is still the same process (e.g. check an `export FOO=bar; echo $FOO` set before reload is still visible/echoable after reload — or simpler, capture the shell's pid via `echo $$` before reload and confirm it's unchanged after).
   - Close the tab; on the host, `ps` for that pid (captured above) and confirm it is gone (no orphan).
   - Attempt (via direct `fetch` in the browser console, since the UI itself won't offer it) `POST /api/terminals` with a `cwd` outside every allow-listed root; confirm `403`.
4. Report exact commands run and exact observed output/screenshots for each check above — this is the deliverable proof, not a summary claim.

## Out of scope (per the issue)

- Terminals on remote machines (fleet work, issue #2)
- Persisting shells across a server restart
- Windows support (`setsid` is POSIX-only; state this explicitly in the README terminal section if not already implied)
