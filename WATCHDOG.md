# Watchdog notes — omp-web

Advisor-only. Not project context (`AGENTS.md` covers that) — these are the specific traps worth interrupting for, and the calibration bar for doing so.

## Severity discipline (read before raising `blocker`)

- `blocker` only for: violates an explicit instruction in this file or the transcript (cite it), ships work that was never actually exercised, or an unrecoverable side effect executing right now. A true-but-zero-observable-impact code fact is `nit`, not `blocker`.
- Before asserting something is "missing" or "not documented": confirm you can actually see its content in your transcript view. Content behind `--body-file`, piped stdin, or a file written earlier in the same turn and referenced indirectly may not be resolved into what you're shown — say "not visible to me here," never "absent."
- Don't repeat a theme you already raised this session unless the transcript shows it was ignored, not just unaddressed within the same turn.

## Runtime constraint — the one that breaks everything if missed

The server half only runs on **Bun**. `@oh-my-pi/*` ships TypeScript sources importing `bun:sqlite`; Node cannot load it at all. Any suggestion involving `node --test`, a Node-only native module (e.g. `node-pty`) in the request path, or `require()`-ing an `@oh-my-pi/*` package is wrong on sight — flag it as `blocker` immediately, no verification needed, the constraint is absolute.

- Tests run via `bun test`, never `node --test`.
- `next.config.ts` externalizes every `@oh-my-pi/*` request as ESM `import`, not `commonjs` — touching that file without preserving that is a `blocker`.
- **Never suggest or accept `bun run build` during dev** — it pollutes `.next/` and breaks `bun run dev` (stated plainly in `AGENTS.md`).

## API route security idiom — flag any deviation

Every route under `app/api/**/route.ts` starts with `isApiRequestAllowed(req)` (403 on failure) and, for bodies, `hasJsonContentType(req)` — see any existing route for the exact shape. A new route missing either is a `concern` at minimum; missing the auth guard entirely on a route that mutates state or touches the filesystem is a `blocker`.

- Filesystem paths (cwd, file paths) MUST be checked against `lib/file-access.ts`'s allow-list (`getAllowedFileRoots()` + `isExistingFilePathAllowed()`) before use. A route that accepts a path and doesn't validate it against the allow-list is a `blocker` — that's an arbitrary-file-read/write vector.
- Don't invent a second security-guard convention beside the existing one, even a "more correct" one — cite the existing idiom and ask for consistency instead.

## Process/session lifecycle traps

- Any `globalThis.__omp*`-keyed registry (see `lib/rpc-manager.ts`) exists specifically to survive Next.js hot-reload — code that reads/writes such a registry without checking for an existing entry first will double-register on every edit-save during dev. Flag it.
- Child processes spawned for a user-facing feature (shells, terminals, long-running tools) must be killed by process **group**, not just the direct pid, or TUI/background children orphan. This bit the terminal-tab feature once already (`setsid -c` + negative-pid `SIGTERM`/`SIGKILL`) — treat a bare `proc.kill()` on a pty/shell-spawning feature as a `concern` until orphan-process cleanup is actually verified.
- `AgentSession.fork()` mutates the session wrapper **in place** — a wrapper left alive under the old id after a fork corrupts the next fork's parent chain. Any fork-adjacent code that doesn't immediately destroy/re-key the wrapper is a `blocker`.
- Any code path that mutates credentials or `models.yml` and doesn't call `invalidateOmpRuntime()` / `invalidateModelsCache()` afterward is a `concern` — stale runtime state is a real, previously-hit bug class here.

## Process, not just code

- No code work starts without a GitHub issue per `AGENTS.md`'s mandatory gate — if a diff is heading toward implementation with no issue number in the branch/commit, that's worth a `nit` pointing at the gate, not a `blocker` (process gates are the primary agent's call to enforce, not grounds to stop code review).
- SSE routes (`app/api/**/events/route.ts`) must not buffer the whole response and must include the 30s heartbeat pattern already used in `app/api/agent/[id]/events/route.ts` — a new SSE route missing the heartbeat will silently die behind proxies/timeouts; `concern`.
