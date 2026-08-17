/**
 * The staged navigation resolution core (issue #10, stage 3).
 *
 * Pure module: no React, no fs. Resolves a parsed location (`./nav-url`)
 * through the pipeline described in issue #10's Design section:
 *
 *   boot -> auth -> machines -> machine-commit -> projects -> project-commit
 *   -> session -> settled
 *
 * All I/O is injected via `NavDeps` so the whole pipeline — including race
 * conditions — is testable without a browser or a server. `components/
 * NavigationProvider.tsx` is the only caller in the app; it binds these deps
 * to real fetches and React state.
 *
 * Validation + error taxonomy (see issue #10 "Design" for the full rationale):
 *  - machine: membership in the caller-provided (already filtered) machines
 *    list. Absent -> one health probe classifies not-found / no-permission /
 *    offline / ok.
 *  - project: session-list membership, falling back to a cwd-validate call
 *    (keeps zero-session project deeplinks working). Absent -> not-available.
 *  - session: `getSession` is authoritative (uniform 404 for hidden/deleted).
 *    Explicit id -> else workspace-memory last -> else most-recent in project.
 *
 * A target sourced from the URL (deeplink or legacy query) is "hard": any
 * validation failure surfaces as an error. A target sourced from localStorage
 * resume or the built-in default is "soft": a stale id steps one level down
 * (session -> default conversation, project -> default project, machine ->
 * local) — except offline, which is always hard, even on resume.
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

// --- localStorage resume -----------------------------------------------------

export interface LastLocation {
  v: 1;
  machine: string;
  project: string | null;
  session: string | null;
}

export interface NavStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_LOCATION_KEY = "omp-web:last-location";

export function readLastLocation(storage: NavStorageLike | null): LastLocation | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastLocation> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.machine !== "string" || !parsed.machine) return null;
    return {
      v: 1,
      machine: parsed.machine,
      project: typeof parsed.project === "string" ? parsed.project : null,
      session: typeof parsed.session === "string" ? parsed.session : null,
    };
  } catch {
    return null;
  }
}

export function writeLastLocation(storage: NavStorageLike | null, loc: LastLocation): void {
  if (!storage) return;
  try {
    storage.setItem(LAST_LOCATION_KEY, JSON.stringify(loc));
  } catch {
    // best-effort, matches workspace-memory.ts's discipline
  }
}

// --- intent: what are we trying to resolve, and how strictly? ---------------

export type NavSource = "url" | "resume" | "default";

export interface NavIntent {
  target: NavigationTarget;
  source: NavSource;
}

const DEFAULT_TARGET: NavigationTarget = { machineId: LOCAL_MACHINE_ID, project: null, session: null };

/**
 * Precedence, decided once: URL deeplink (incl. legacy query) > localStorage
 * resume > built-in defaults. `parsed.kind === "root"` (malformed input) is
 * treated the same as `"resume"` — a mistyped path is not different from a
 * fresh `/` visit.
 */
export function resolveIntent(parsed: ParsedLocation, storage: NavStorageLike | null): NavIntent {
  if (parsed.kind === "target") return { target: parsed.target, source: "url" };
  const stored = readLastLocation(storage);
  if (stored) {
    return { target: { machineId: stored.machine, project: stored.project, session: stored.session }, source: "resume" };
  }
  return { target: DEFAULT_TARGET, source: "default" };
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
  | { phase: NavPhase; target: NavigationTarget; session: SessionInfo | null; error: null; source: NavSource }
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
  storage: NavStorageLike | null;
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
    const hard = intent.source === "url";
    const source = intent.source;
    let target = intent.target;

    if (!emit(myToken, { phase: "boot", target, session: null, error: null, source })) return;

    if (!emit(myToken, { phase: "auth", target, session: null, error: null, source })) return;
    await (deps.waitForAuth?.() ?? Promise.resolve());
    if (myToken !== token) return;

    if (!emit(myToken, { phase: "machines", target, session: null, error: null, source })) return;
    let machines: NavMachineSummary[];
    try {
      machines = await deps.listMachines();
    } catch {
      machines = [];
    }
    if (myToken !== token) return;

    let machineId = target.machineId;
    const known = machineId === LOCAL_MACHINE_ID || machines.some((m) => m.id === machineId);
    if (!known) {
      let probe: MachineProbeResult;
      try {
        probe = await deps.probeMachine(machineId);
      } catch {
        probe = "offline";
      }
      if (myToken !== token) return;

      if (probe === "offline") {
        emit(myToken, {
          phase: "error",
          target: { machineId, project: null, session: null },
          session: null,
          error: { stage: "machine", variant: "offline" },
          source,
        });
        return;
      }
      if (probe !== "ok") {
        if (hard) {
          emit(myToken, {
            phase: "error",
            target: { machineId, project: null, session: null },
            session: null,
            error: { stage: "machine", variant: probe },
            source,
          });
          return;
        }
        // Soft step-down: a stale resume/default machine id falls back to local,
        // taking its project/session with it — cross-machine ids are meaningless.
        machineId = LOCAL_MACHINE_ID;
        target = { machineId: LOCAL_MACHINE_ID, project: null, session: null };
      }
      // probe === "ok": accept machineId even though it was absent from the
      // cached list (e.g. a fresh grant not yet reflected in this session).
    }

    target = { ...target, machineId };
    if (myToken !== token) return;
    deps.onMachineCommit?.(machineId);
    if (!emit(myToken, { phase: "machine-commit", target, session: null, error: null, source })) return;

    if (!emit(myToken, { phase: "projects", target, session: null, error: null, source })) return;
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
    // Set to true when the effective project differs from what was requested
    // (a soft step-down): the originally-requested session, if any, no longer
    // applies and must be re-derived against the new project instead.
    let sessionRedirected = false;

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
        } else if (hard) {
          emit(myToken, {
            phase: "error",
            target: { machineId, project: null, session: null },
            session: null,
            error: { stage: "project", variant: "not-available" },
            source,
          });
          return;
        } else {
          project = defaultProject(sessions, removedProjects);
          sessionRedirected = true;
        }
      }
    } else {
      project = defaultProject(sessions, removedProjects);
    }

    target = { machineId, project, session: sessionRedirected ? null : target.session };
    if (!emit(myToken, { phase: "project-commit", target, session: null, error: null, source })) return;

    if (!emit(myToken, { phase: "session", target, session: null, error: null, source })) return;
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

      // Reconcile: an explicit-session deeplink/resume validates the session
      // exists but not that it belongs to the requested project — the
      // session's own project wins (precedent: the old `?session=` restore
      // behaved the same way). `defaultSession` below is already
      // project-filtered, so this only touches sessions actually resolved
      // via `deps.getSession`.
      if (resolvedSession) {
        const sessProject = resolvedSession.projectRoot ?? resolvedSession.cwd;
        if (sessProject !== project) project = sessProject;
      }

      if (!resolvedSession) {
        if (hard) {
          emit(myToken, {
            phase: "error",
            target: { machineId, project, session: null },
            session: null,
            error: { stage: "session", variant: "not-available" },
            source,
          });
          return;
        }
        resolvedSession = project ? defaultSession(project, sessions, deps.getLastOpenSession) : null;
      }
    } else if (project) {
      resolvedSession = defaultSession(project, sessions, deps.getLastOpenSession);
    }

    const finalTarget: NavigationTarget = { machineId, project, session: resolvedSession?.id ?? null };
    if (emit(myToken, { phase: "settled", target: finalTarget, session: resolvedSession, error: null, source })) {
      writeLastLocation(deps.storage, {
        v: 1,
        machine: finalTarget.machineId,
        project: finalTarget.project,
        session: finalTarget.session,
      });
    }
  }

  return {
    run(parsed: ParsedLocation, deps: NavDeps): void {
      const myToken = ++token;
      const intent = resolveIntent(parsed, deps.storage);
      void resolve(intent, deps, myToken);
    },
  };
}
