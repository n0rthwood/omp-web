# Handoff — Fleet (multi-machine) & Terminals for omp-web

**Status:** planning complete, no feature code written.
**Repo:** `n0rthwood/omp-web` · **Baseline:** `6c43bc3` (`v0.2.8`)
**Date:** 2026-08-13

This document exists so the next person (or agent) can pick the work up without
redoing the research. It states what we are building, what already works here,
what is missing, and what is left to do.

---

## 1. What we want to build

Two features, in this order:

1. **Terminals** — a real, user-owned shell in the web UI, scoped to the
   selected workspace. Not the agent's bash tool; a shell the human drives.
2. **Fleet / multi-machine** — one omp-web instance acting as a *gateway* that
   can browse projects, sessions, files, and terminals on other machines each
   running their own omp-web.

Terminals first: it is self-contained, and a fleet without terminals is much
less useful than terminals without a fleet.

---

## 2. Background — four projects with confusingly similar names

Confusing these wastes days, so they are written down:

| Project | What it is | Fleet / terminals? |
|---|---|---|
| `agegr/pi-web` | the original web UI for **pi**, 4.1k★, Mar 2026 — distant ancestor of this tree | ❌ neither |
| `ddallabenetta/omp-web` | omp-focused downstream; **this fork's GitHub parent** | ❌ neither |
| `kahme247/ompweb` | a *sibling* omp downstream, also from `agegr/pi-web` | ❌ neither |
| `jmfederico/pi-web` | **independent project**, 520★, May 2026 — not a fork of any of the above | ✅ **both** |

`oh-my-pi` itself is a **fork** of [pi](https://github.com/badlogic/pi-mono) by
Mario Zechner — not a plugin layer on top of it. It has diverged substantially
(Rust core, LSP, DAP, subagents, browser automation, 31 tools), so pi-side code
must never be assumed portable.

### Decision: build here, do not migrate to `jmfederico/pi-web`

`jmfederico/pi-web` already has both features (~5,200 LOC), which makes starting
from it tempting. It does not work, for one decisive reason:

> **pi-web is welded to the *Pi* SDK, in-process.**
> `src/server/sessions/piSessionService.ts` is 4,289 lines built directly on
> `@earendil-works/pi-agent-core`'s `StreamFn`. 19 non-test files import the Pi
> SDK.

And omp cannot be dropped into that slot: pi-web is a **Node/Fastify** app,
while `@oh-my-pi/*` is published as TypeScript sources that import `bun:sqlite`
and declares `engines: { bun: ">=1.3.14" }` with no Node entry. Adopting pi-web
would mean porting Fastify + `ws` + `node-pty` onto Bun **and** replacing
~12,500 lines of `src/server/sessions/` with the omp SDK — which is exactly what
this tree already is.

| | from `jmfederico/pi-web` | from **this tree** |
|---|---|---|
| Codebase inherited | 64.4k prod + 64.5k test ≈ 129k LOC, foreign | 37.8k prod + 4.8k test, ours |
| Agent runtime | ❌ rewrite ~12.5k LOC + move Node→Bun | ✅ done (in-process omp SDK) |
| omp auth / providers / models / skills / plugins | ❌ rewrite (Pi-SDK-coupled) | ✅ done |
| Fleet + terminals | ✅ present | ❌ build |
| Ongoing cost | permanent fork of an active upstream | none |

We trade the feature we must write anyway against ~15k LOC of agent runtime we
would have to rewrite in a foreign codebase. **Build here.**

Their designs are still worth studying — see §6.

---

## 3. What already works (do not rebuild)

- **In-process omp runtime.** `lib/rpc-manager.ts` (1,614 LOC) creates an
  `AgentSession` via `createAgentSession()` and binds omp's own
  `initializeExtensions()` from `@oh-my-pi/pi-coding-agent/modes/runtime-init`.
  27 files / 60 import sites touch `@oh-my-pi/*`. `lib/omp-runtime.ts` caches
  `Settings` + `AuthStorage` + `ModelRegistry` on `globalThis`.
- **44 API routes** under `app/api/` — sessions, agent, auth, files, models,
  model-roles, skills, plugins, worktrees.
- **SSE streaming** — `app/api/agent/[id]/events/route.ts` and
  `app/api/agent/running/events/route.ts`. This is the proven pattern to copy
  for terminal output.
- **Auth + origin checks** — `proxy.ts` applies Basic Auth and a cross-origin
  guard to every route.
- **Path safety** — `lib/file-access.ts` allow-list, plus `lib/project-trust.ts`
  (omp-web's own gate on a project's executable resources).
- **Terminal *key encoding*** — `lib/terminal-input.ts` (63 LOC) already maps
  browser key events to ANSI sequences (arrows, Ctrl-*, Home/End) and implements
  bracketed paste. Reusable as-is.

### The Bun constraint governs everything

The server half only runs on **Bun** — `@oh-my-pi/pi-*` ships TypeScript sources
importing `bun:sqlite`, so Node cannot load it at all
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `bin/omp-web.js` locates a Bun
binary and re-executes `next start` through it. Tests are `bun test`, not
`node --test`. **Any design that assumes a Node-only native module is wrong.**

## 4. What is missing

### Terminals

- **No pty.** Nothing in the tree spawns a shell.
- **No terminal UI.** `lib/terminal-input.ts` and `lib/custom-ui-terminal.ts`
  (27 LOC) serve *omp extension custom-UI requests* — a process the **agent**
  started. There is no user-owned shell, no terminal pane, no tab, no scrollback.

### Fleet

- **Nothing.** No machine registry, no proxy layer, no machine concept anywhere
  in the client. Every `fetch("/api/...")` implicitly means "this machine".

---

## 5. Work left to do

### Phase 0 — repo setup ✅ done

- [x] `origin` → `n0rthwood/omp-web`; `kahme247/ompweb` dropped entirely
- [x] `piweb` kept fetch-only (push URL set to `DISABLED`)
- [x] GitHub Issue workflow + `gh` collision warning documented in `AGENTS.md`
- [x] `CLAUDE.md` → symlink to `AGENTS.md`; the GitNexus block preserved inside
      `AGENTS.md` with its markers intact
- [x] `.gh-issue/` gitignored
- [x] Issues enabled on the fork (forks ship with them off) and the
      `type:` / `priority:` labels created
- [x] Tracking issues filed: **#1 terminals**, **#2 fleet**

### Phase 1 — terminals

**A pty spike has already been run. Read this before choosing an approach.**

Measured on this machine (Bun 1.3.12, Linux x64) — spawn `/bin/bash`, capture output:

| Approach | Result |
|---|---|
| `node-pty` under **Node** | ✅ works — `PTY_OK`, `/dev/pts/7` |
| `node-pty` under **Bun** | ⚠️ **installs, spawns, exits 0 — but `onData` never fires.** Output is silently empty. |
| `script -qfc … ` via `Bun.spawn` | ✅ works — real pty, output captured |
| `Bun.Terminal` (native) | ⚠️ exists, exposes `write` / `resize` / `setRawMode` / `close` / termios flags — but the read side is **not** `.readable`, and probing the instance hung |

So: **`node-pty` is not viable here**, because the server runs on Bun and its
data path is dead there. That kills the obvious plan. Three real options:

1. **`Bun.Terminal`** — the right answer if it works. Native, no compiler, no
   native module. Blocked on finding its read API; note this box has Bun
   **1.3.12** while `package.json` requires **≥1.3.14**, so upgrade Bun and
   re-check the API before concluding anything.
2. **`script -qfc` + `Bun.spawn`** — works *today*, zero dependencies, but it is
   a POSIX-only trick (no Windows) and resize/termios control is awkward.
3. **Node sidecar** — run `node-pty` in a small Node child process and bridge
   over stdio. Costs a process per machine but is portable and well-understood.

**Decide this first; it gates everything else in Phase 1.** Start by upgrading
Bun and re-probing `Bun.Terminal`.

Then:

4. **Server: terminal service.** `lib/terminals/terminal-service.ts` — a
   `globalThis`-keyed registry of live ptys (mirroring
   `globalThis.__ompSessions` in `lib/rpc-manager.ts`, so it survives hot
   reload), with a bounded scrollback replay buffer (pi-web uses 200KB) so a
   reconnecting browser can catch up.
5. **Server: routes.** `app/api/terminals/` — `POST` create (cwd, cols, rows),
   `GET` list, `DELETE` kill, `POST /:id/input`, `POST /:id/resize`,
   `GET /:id/events` (SSE).
   **Use SSE down + POST up.** Next.js App Router route handlers cannot do
   WebSocket upgrades, and fighting that would mean a custom server wrapping
   Next. SSE latency is fine for a terminal.
6. **Client: terminal pane.** Add a terminal tab to `components/TabBar.tsx`.
   Render with `@xterm/xterm`, feed it the SSE stream, and send keys via the
   existing `toTerminalKeyData()` / `asBracketedPaste()` from
   `lib/terminal-input.ts`.
7. **Scope cwd** to the same allow-listed roots as `lib/file-access.ts`, and
   respect `lib/project-trust.ts`. A terminal must not become a way around
   either boundary.
8. **Security gate — required.** A terminal turns a browser request into
   arbitrary host command execution. Gate it deliberately:
   - off unless explicitly enabled (`OMP_WEB_TERMINALS=1`);
   - refuse to enable on a non-loopback host unless a web password is set;
   - state plainly in the README that enabling it makes the web UI a shell.

### Phase 2 — fleet

1. **Machine store.** `lib/machines/machine-store.ts` — `{id, name, baseUrl,
   token, headers, createdAt, updatedAt}` in `machines.json`, mode `0600`.
   (Steal this shape from pi-web verbatim; it is right and it is ~30 lines.)
2. **Gateway proxy.** One catch-all route,
   `app/api/machines/[machineId]/[...path]/route.ts`, forwarding to the remote's
   `/api/...` with the stored token as Basic Auth. Guard it with an explicit
   **route allow-list** — do not blindly forward everything.
   - This covers all 44 routes at once. pi-web instead maintains a 139-line
     per-route federation table (`src/shared/federatedRoutes.ts`); we do not
     need that.
   - SSE must pass through as a stream, not be buffered.
   - Check `proxy.ts`'s origin guard against server-to-server calls: a
     gateway→remote request carries no `Origin`/`Sec-Fetch-Site` header, so
     confirm it passes rather than assuming it does.
3. **Client machine dimension.** *This is the bulk of the work — not the proxy.*
   Add an `apiPath()` helper that prefixes `/api/machines/{id}` when a non-local
   machine is selected, then thread machine identity through everything that
   currently assumes one host: `components/SessionSidebar.tsx`,
   `lib/draft-store.ts`, `lib/worktree.ts`, `hooks/useAgentSession.ts`, and
   every `localStorage` key.
4. **Machine switcher UI** + health/status polling (online, omp version,
   omp-web version — versions will drift between machines and the UI must say so).
5. **No session daemon.** pi-web needs `pi-web-sessiond` (1,492 LOC) largely
   because terminals proxy through it. Evaluate whether our in-process
   `AgentSession` model needs an equivalent, or whether the gateway proxy is
   enough — it probably is.
6. **Remote exposure.** Keep the loopback default. A fleet is single-user, not
   multi-user; document that remote machines require HTTPS via a reverse proxy
   or a VPN, and that Basic Auth is not encryption.

### Before starting — check this first

omp ships **session sharing over a relay with QR codes**, natively. Depending
on what "control another machine" actually needs to mean, that may already
deliver part of Phase 2 for free. Evaluate it before writing the gateway.

---

## 6. Reference material

Read for design, **never copy code** — different runtime (Node), different
framework (Fastify + `ws`), different agent SDK (Pi, in-process).

| What | Where in `jmfederico/pi-web` |
|---|---|
| Machine record + 0600 store | `src/server/machines/machineStore.ts` |
| Remote HTTP/WS client | `src/server/machines/machineClient.ts` |
| Proxy routes | `src/server/machines/machineProxyRoutes.ts` |
| Federated route table | `src/shared/federatedRoutes.ts` (139 LOC) |
| Terminal service (node-pty, replay buffer) | `src/server/terminals/terminalService.ts` |
| Terminal proxy | `src/server/terminalProxyRoutes.ts` |

---

## 7. Open items

- **Bun version drift.** This machine has Bun **1.3.12**; `package.json`
  requires **≥1.3.14**. Upgrade before trusting any `Bun.Terminal` finding.
- **`kahme247/ompweb` is out of scope.** It was briefly used as a working tree
  and has been dropped. It is a sibling downstream with its own 115 commits; if
  a fix is ever wanted from it, cherry-pick deliberately — the two trees have
  **different architectures** (it spawns `omp --mode rpc-ui` as a child process
  over NDJSON; this tree uses the SDK in-process on Bun). Do not copy code
  between them without checking which model it assumes.
