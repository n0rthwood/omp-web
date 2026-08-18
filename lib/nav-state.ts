/**
 * The staged navigation resolution core (issue #10, stage 3; issue #15
 * "Always Home" for the entry path).
 *
 * Pure module: no React, no fs. Two intents exist:
 *
 * - `{kind:"target"}` — an explicit deeplink (or legacy query). Resolves
 *   hard, in phases: boot -> auth -> machines -> machine-commit -> projects
 *   -> project-commit -> session -> settled. Machine validation probes
 *   unknown ids (not-found / no-permission / offline / ok); project
 *   validation checks the session list with a cwd-validate fallback;
 *   session validation is `getSession`-authoritative. Any stale id is an
 *   error surfaced through the AccessNotice gate — the pre-#15 soft
 *   step-downs belonged to the retired resume/default entry sources.
 * - `{kind:"home"}` — the entry landing (issue #15). Runs boot -> auth only
 *   and settles with `home:true`; the Home page renders instead of a
 *   conversation and fetches its own overview data.
 *
 * All I/O is injected via `NavDeps` so the whole pipeline — including race
 * conditions — is testable without a browser or a server. `components/
 * NavigationProvider.tsx` is the only caller in the app; it binds these deps
 * to real fetches and React state.
 *
 * Race safety: every `run()` call gets a fresh monotonic token; every commit
 * point (after each `await`, and before every side-effecting call such as
 * `onMachineCommit`) re-checks the token against the resolver's current one
 * and silently abandons a superseded run. This covers both a plain
 * superseded intent (user navigates twice quickly) and a popstate that lands
 * mid-resolution (e.g. during the machine-commit remount window).
 */

import type { SessionInfo } from "./types";
import { buildUrl, type NavigationTarget, type ParsedLocation } from "./nav-url";
import { mostRecentProjectRoots } from "./project-recency";
import { normalizeProjectKey } from "./removed-projects";

const LOCAL_MACHINE_ID = "local";

// --- intent: what are we trying to resolve, and how strictly? ---------------

export type NavSource = "url" | "home";

export type NavIntent =
  | { target: NavigationTarget; source: "url"; home: false }
  | { home: true };

const DEFAULT_TARGET: NavigationTarget = { machineId: LOCAL_MACHINE_ID, project: null, session: null };

/**
 * Precedence, decided once (issue #15 "Always Home"): a URL deeplink
 * (incl. legacy query) resolves as a hard target; every other location —
 * bare `/`, bare `/m` / `/p`, malformed shapes — is the Home entry. The
 * pre-#15 localStorage resume and built-in default-resolution entry paths
 * are retired: opening the app lands on Home; a conversation is only ever
 * opened through an explicit target (deeplink, Home/calendar click, or an
 * in-app selection).
 */
export function resolveIntent(parsed: ParsedLocation): NavIntent {
  if (parsed.kind === "target") return { target: parsed.target, source: "url", home: false };
  return { home: true };
}

// --- pipeline phases + result shape ------------------------------------------

export type NavPhase =
  | "boot"
  | "auth"
  | "machines"
  | "machine-commit"
  | "projects"
  | "project-commit"
  | "session"
  | "settled";

export type NavErrorVariant = "not-found" | "no-permission" | "not-available" | "offline";
export type NavErrorStage = "machine" | "project" | "session";

export interface NavError {
  stage: NavErrorStage;
  variant: NavErrorVariant;
}

export type NavResult =
  | { phase: NavPhase; target: NavigationTarget; session: SessionInfo | null; error: null; source: NavSource; home: boolean }
  | { phase: "error"; target: NavigationTarget; session: null; error: NavError; source: NavSource };

/**
 * The address-bar canonicalization for a settled URL-sourced resolution
 * (issue #10 stage-3 review, blocker #1): a legacy `?machine=/?session=/
 * ?cwd=` link, or a machine switch settling on its resolved defaults, must
 * end up at the same path a fresh `/m/<id>/p/<project>/s/<session>` visit
 * would produce — never left on the URL it started from. Resume/default-
 * sourced settles (a plain `/` visit, or a stale-resume step-down) must
 * never touch history, so this only ever returns non-null for a
 * `"url"`-sourced `"settled"` result whose canonical form differs from
 * `currentUrl` (the caller's `window.location.pathname + search`).
 */
export function canonicalRewriteUrl(result: NavResult, currentUrl: string): string | null {
  if (result.phase !== "settled" || result.source !== "url") return null;
  const canonical = buildUrl(result.target);
  return canonical === currentUrl ? null : canonical;
}

// --- injected I/O -------------------------------------------------------------

export interface NavMachineSummary {
  id: string;
}

export type MachineProbeResult = "ok" | "not-found" | "no-permission" | "offline";

/** Thrown by an injected loader for a network failure (never a 404/403). */
export class NavOfflineError extends Error {
  constructor(message = "offline") {
    super(message);
    this.name = "NavOfflineError";
  }
}

export interface NavDeps {
  /** Resolves once auth state is known. Defaults to an already-resolved promise. */
  waitForAuth?(): Promise<void>;
  /** The current user's machine list (already filtered/slimmed by the caller), local first. */
  listMachines(): Promise<NavMachineSummary[]>;
  /** `GET /api/machines/<id>/api/health` — only called when the id is absent from `listMachines()`. */
  probeMachine(machineId: string): Promise<MachineProbeResult>;
  /** One session-list snapshot for the machine, reused for both project and session validation. Throws `NavOfflineError` on network failure. */
  listSessions(machineId: string): Promise<SessionInfo[]>;
  /** `POST /api/cwd/validate`; resolves the canonical cwd, or null when invalid/forbidden. Throws `NavOfflineError` on network failure. */
  validateCwd(machineId: string, cwd: string): Promise<string | null>;
  /** `GET /api/sessions/<id>`; null on 404/hidden (uniform — never distinguishes the two). Throws `NavOfflineError` on network failure. */
  getSession(machineId: string, sessionId: string): Promise<SessionInfo | null>;
  /** Synchronous workspace-memory lookup for a project key. */
  getLastOpenSession(projectKey: string): string | null;
  /** Reads the machine-scoped removed-projects set (`SessionSidebar`'s "hide
   *  from workspace selector" list) so a removed project is never silently
   *  picked as the pipeline's default. Omitted -> no project is treated as
   *  removed (nav-state stays pure-injectable; the real storage read is
   *  wired in by `NavigationProvider.tsx`). */
  removedProjectsSupplier?(): Set<string>;
  /** Called once the machine id is committed, before the projects stage starts. */
  onMachineCommit?(machineId: string): void;
}

// --- defaults within an already-fetched session-list snapshot --------------

/** Most-recently-modified project root across the snapshot, excluding the
 *  caller's removed projects (issue #10 stage-3 review, minor #8) — shares
 *  its ranking with SessionSidebar's `mostRecentProjectRoots`. */
function defaultProject(sessions: SessionInfo[], removedProjects: Set<string>): string | null {
  return mostRecentProjectRoots(sessions).find((root) => !removedProjects.has(normalizeProjectKey(root))) ?? null;
}

/** Workspace-memory last-open session for the project, else the most-recently-modified session in it. */
function defaultSession(
  project: string,
  sessions: SessionInfo[],
  getLastOpenSession: (projectKey: string) => string | null,
): SessionInfo | null {
  const inProject = sessions.filter((s) => (s.projectRoot ?? s.cwd) === project);
  const lastId = getLastOpenSession(project);
  if (lastId) {
    const match = inProject.find((s) => s.id === lastId);
    if (match) return match;
  }
  if (inProject.length === 0) return null;
  return inProject.reduce((best, s) => (s.modified > best.modified ? s : best));
}

// --- the resolver -------------------------------------------------------------

/**
 * Creates a resolver: an object exposing `run(parsed, deps)` that kicks off
 * one resolution, emitting `NavResult`s to `onChange` as the pipeline
 * advances. Calling `run()` again immediately supersedes any resolution still
 * in flight — its later callbacks and side effects are suppressed.
 */
export function createNavigationResolver(onChange: (result: NavResult) => void) {
  let token = 0;

  function emit(myToken: number, result: NavResult): boolean {
    if (myToken !== token) return false;
    onChange(result);
    return true;
  }

  async function resolve(intent: NavIntent, deps: NavDeps, myToken: number): Promise<void> {
    if (intent.home) {
      // Home (issue #15): no machine/project/session resolution — the Home
      // page fetches its own overview data. Only the auth gate runs, so an
      // unauthenticated visitor still bounces to /login from the provider.
      const target = DEFAULT_TARGET;
      if (!emit(myToken, { phase: "boot", target, session: null, error: null, source: "home", home: false })) return;
      if (!emit(myToken, { phase: "auth", target, session: null, error: null, source: "home", home: false })) return;
      await (deps.waitForAuth?.() ?? Promise.resolve());
      if (myToken !== token) return;
      emit(myToken, { phase: "settled", target, session: null, error: null, source: "home", home: true });
      return;
    }

    // Every target is URL-shaped and hard (issue #15 retired the soft
    // resume/default sources): a stale id surfaces the AccessNotice gate
    // instead of silently stepping down to some other destination.
    const source = "url";
    let target = intent.target;

    if (!emit(myToken, { phase: "boot", target, session: null, error: null, source, home: false })) return;

    if (!emit(myToken, { phase: "auth", target, session: null, error: null, source, home: false })) return;
    await (deps.waitForAuth?.() ?? Promise.resolve());
    if (myToken !== token) return;

    if (!emit(myToken, { phase: "machines", target, session: null, error: null, source, home: false })) return;
    let machines: NavMachineSummary[];
    try {
      machines = await deps.listMachines();
    } catch {
      machines = [];
    }
    if (myToken !== token) return;

    const machineId = target.machineId;
    const known = machineId === LOCAL_MACHINE_ID || machines.some((m) => m.id === machineId);
    if (!known) {
      let probe: MachineProbeResult;
      try {
        probe = await deps.probeMachine(machineId);
      } catch {
        probe = "offline";
      }
      if (myToken !== token) return;

      if (probe !== "ok") {
        emit(myToken, {
          phase: "error",
          target: { machineId, project: null, session: null },
          session: null,
          error: { stage: "machine", variant: probe },
          source,
        });
        return;
      }
      // probe === "ok": accept machineId even though it was absent from the
      // cached list (e.g. a fresh grant not yet reflected in this session).
    }

    target = { ...target, machineId };
    if (myToken !== token) return;
    deps.onMachineCommit?.(machineId);
    if (!emit(myToken, { phase: "machine-commit", target, session: null, error: null, source, home: false })) return;

    if (!emit(myToken, { phase: "projects", target, session: null, error: null, source, home: false })) return;
    let sessions: SessionInfo[];
    try {
      sessions = await deps.listSessions(machineId);
    } catch (err) {
      if (myToken !== token) return;
      if (err instanceof NavOfflineError) {
        emit(myToken, {
          phase: "error",
          target: { machineId, project: null, session: null },
          session: null,
          error: { stage: "machine", variant: "offline" },
          source,
        });
        return;
      }
      sessions = [];
    }
    if (myToken !== token) return;

    const removedProjects = deps.removedProjectsSupplier?.() ?? new Set<string>();
    let project = target.project;

    if (project) {
      const requestedProject = project;
      if (!sessions.some((s) => (s.projectRoot ?? s.cwd) === requestedProject)) {
        let validated: string | null;
        try {
          validated = await deps.validateCwd(machineId, project);
        } catch (err) {
          if (myToken !== token) return;
          if (err instanceof NavOfflineError) {
            emit(myToken, {
              phase: "error",
              target: { machineId, project: null, session: null },
              session: null,
              error: { stage: "machine", variant: "offline" },
              source,
            });
            return;
          }
          validated = null;
        }
        if (myToken !== token) return;

        if (validated) {
          project = validated; // canonicalized, same logical project — session still applies
        } else {
          emit(myToken, {
            phase: "error",
            target: { machineId, project: null, session: null },
            session: null,
            error: { stage: "project", variant: "not-available" },
            source,
          });
          return;
        }
      }
    } else {
      project = defaultProject(sessions, removedProjects);
    }

    target = { machineId, project, session: target.session };
    if (!emit(myToken, { phase: "project-commit", target, session: null, error: null, source, home: false })) return;

    if (!emit(myToken, { phase: "session", target, session: null, error: null, source, home: false })) return;
    let resolvedSession: SessionInfo | null = null;
    if (target.session) {
      try {
        resolvedSession = await deps.getSession(machineId, target.session);
      } catch (err) {
        if (myToken !== token) return;
        if (err instanceof NavOfflineError) {
          emit(myToken, {
            phase: "error",
            target: { machineId, project, session: null },
            session: null,
            error: { stage: "machine", variant: "offline" },
            source,
          });
          return;
        }
        resolvedSession = null;
      }
      if (myToken !== token) return;

      // Reconcile: an explicit-session deeplink validates the session
      // exists but not that it belongs to the requested project — the
      // session's own project wins (precedent: the old `?session=` restore
      // behaved the same way). `defaultSession` below is already
      // project-filtered, so this only touches sessions actually resolved
      // via `deps.getSession`.
      if (resolvedSession) {
        const sessProject = resolvedSession.projectRoot ?? resolvedSession.cwd;
        if (sessProject !== project) project = sessProject;
      } else {
        emit(myToken, {
          phase: "error",
          target: { machineId, project, session: null },
          session: null,
          error: { stage: "session", variant: "not-available" },
          source,
        });
        return;
      }
    } else if (project) {
      resolvedSession = defaultSession(project, sessions, deps.getLastOpenSession);
    }

    const finalTarget: NavigationTarget = { machineId, project, session: resolvedSession?.id ?? null };
    emit(myToken, { phase: "settled", target: finalTarget, session: resolvedSession, error: null, source, home: false });
  }

  return {
    run(parsed: ParsedLocation, deps: NavDeps): void {
      const myToken = ++token;
      const intent = resolveIntent(parsed);
      void resolve(intent, deps, myToken);
    },
  };
}
