"use client";

/**
 * Binds `lib/nav-state.ts`'s pure resolution core to React (issue #10,
 * stage 3): the single owner of "where we are". Sits above the machine
 * remount key, alongside `MachineProvider`/`SessionListProvider` — those
 * two own the raw data (machine list, session list); this provider owns
 * *resolution* of a location against that data, and is the only popstate
 * handler in the app.
 *
 * Two navigation paths:
 *  - Boot + popstate: untrusted input runs the full async `nav-state`
 *    pipeline — staged loading, validation, error taxonomy, and a
 *    selection intent captured once from the incoming location.
 *  - Interactive (`navigate()`): the caller already holds an
 *    already-validated target (a session/project clicked from a loaded
 *    list, a machine picked from the loaded machines list). A same-machine
 *    target updates the URL, storage, and the machine seam directly, no
 *    re-validation round trip. A target that *changes* the machine runs
 *    through the same async pipeline as a deeplink. The explicit
 *    `"defaults"` intent resolves the machine's project and conversation;
 *    `"none"` validates the machine and enters its shell with no selection.
 *
 * A settled URL-sourced resolution canonicalizes the address bar via native
 * `history.replaceState` only when its resolved form differs. Legacy
 * `?session=` links and defaults-selected machine switches become their full
 * `/m/<id>/p/<project>/s/<session>` path; a select-nothing `/m/<id>` stays
 * bare. Home settles never touch history.
 *
 * Children render only once `phase === "settled"` — the whole-subtree
 * loading gate idiom, extended with per-stage progress and `AccessNotice`
 * error screens instead of a silent fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalRewriteUrl,
  createNavigationResolver,
  NavOfflineError,
  type MachineProbeResult,
  type NavDeps,
  type NavError,
  type NavPhase,
  type NavResult,
  type NavTargetSelection,
} from "@/lib/nav-state";
import { buildUrl, parseLocation, type NavigationTarget, type ParsedLocation } from "@/lib/nav-url";
import { apiPath } from "@/lib/api-path";
import { loadRemovedProjects } from "@/lib/removed-projects";
import { useMachines } from "@/lib/machine-context";
import { useSessionList } from "@/lib/session-list-context";
import { useWebUser } from "@/hooks/useWebUser";
import { useI18n } from "@/hooks/useI18n";
import { getLastOpenSession } from "@/lib/workspace-memory";
import { AccessNotice, type AccessNoticeVariant } from "./AccessNotice";
import type { SessionInfo } from "@/lib/types";
import { createContext, useContext } from "react";


export interface NavigationNavigateOptions {
  history: "push" | "replace";
  /**
   * `"none"` means a blank target opens only the machine shell. Callers that
   * deliberately want a blank target to choose remembered defaults must opt
   * into `"defaults"` so it remains distinct from the URL shape.
   */
  selection?: NavTargetSelection;
}

export interface NavigationContextValue {
  target: NavigationTarget;
  /** The resolved session object once known — set at settle (deeplink/resume/popstate), stale after a subsequent interactive `navigate()`. Consumers needing a live value should track their own selection instead. */
  session: SessionInfo | null;
  /** True while the app is on the Home landing (issue #15): no conversation target is open and the shell renders the Home page instead of the app body. */
  home: boolean;
  phase: NavPhase;
  error: NavError | null;
  /** Increments only when a resolver run (boot/popstate/machine-changing
   *  `navigate()`) delivers a phase result; the same-machine `navigate()`
   *  fast path settles synchronously without bumping it. AppShellBody uses
   *  this — not target/session directly — to detect that a *new*
   *  resolution has landed and needs applying to the open conversation,
   *  since its own interactive selections already update local state
   *  themselves. */
  resolutionRevision: number;
  /** Updates URL and syncs the machine seam for an already-validated target. A blank target defaults to the select-nothing intent; callers that need a remembered project/session pass `selection: "defaults"`. */
  navigate(target: NavigationTarget, options: NavigationNavigateOptions): void;
  /** Lands on the Home page (issue #15): pushes "/" and settles the home intent. */
  goHome(): void;
  /** Re-runs the full pipeline against the current URL (offline retry). */
  retry(): void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation must be used inside NavigationProvider");
  return ctx;
}

function currentLocation(): { pathname: string; search: string } {
  if (typeof window === "undefined") return { pathname: "/", search: "" };
  return { pathname: window.location.pathname, search: window.location.search };
}

/**
 * `parseLocation` has already validated the path grammar. With no query
 * string, its only blank target is a bare `/m/<id>` path, which is the
 * explicit machine-shell route. Any query retains the legacy/default
 * semantics, even when it happens to encode the same target shape.
 *
 * This boundary is the sole point that derives URL provenance; the result is
 * passed to the resolver and is never reconstructed from the URL downstream.
 */
function selectionAtLocationIngress(parsed: ParsedLocation, search: string): NavTargetSelection {
  return parsed.kind === "target"
    && search === ""
    && parsed.target.project === null
    && parsed.target.session === null
    ? "none"
    : "defaults";
}

/**
 * Writes the address bar with the native History API — NEVER the Next
 * router. Every provider in this app mounts inside the page subtree
 * (app/layout.tsx is bare), and App Router pages do not preserve state, so
 * router.push/replace remounts the whole app on each navigation: the boot
 * resolver re-runs, the loading gate covers the screen, and in-flight state
 * (a fresh new-chat composer, SSE streams) is destroyed. Next 16 patches
 * pushState/replaceState to sync its canonical URL without any RSC fetch or
 * segment swap, and back/forward on such entries restores from cache; this
 * provider's own popstate listener drives the app-level reaction.
 */
function writeAddressBar(url: string, mode: "push" | "replace"): void {
  const { pathname, search } = currentLocation();
  if (pathname + search === url) return; // identical entry adds nothing
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

const LOADING_LABEL_BY_PHASE: Partial<Record<NavPhase, string>> = {
  auth: "nav.loading.auth",
  machines: "nav.loading.machines",
  "machine-commit": "nav.loading.machines",
  projects: "nav.loading.projects",
  "project-commit": "nav.loading.projects",
  session: "nav.loading.session",
};

function noticeVariantFrom(error: NavError): AccessNoticeVariant {
  return error.variant;
}

export function NavigationProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const machines = useMachines();
  const sessionList = useSessionList();
  const { user: webUser, authRequired: webAuthRequired, loading: webUserLoading } = useWebUser();
  const { t } = useI18n();

  const [result, setResult] = useState<NavResult>({
    phase: "boot",
    target: { machineId: "local", project: null, session: null },
    session: null,
    error: null,
    source: "home",
    home: false,
  });
  const resultRef = useRef(result);
  resultRef.current = result;
  // Bumped only by the resolver's onChange below (a resolver-delivered
  // phase result) — never by the same-machine sync fast path in navigate().
  const [resolutionRevision, setResolutionRevision] = useState(0);

  // Refs mirror the latest values into stable closures the resolver's deps
  // (constructed fresh per `run()`, but the resolver itself is created once)
  // can read without going stale.
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const sessionListRef = useRef(sessionList);
  sessionListRef.current = sessionList;

  const machinesWaitersRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    if (machines.loading) return;
    const waiters = machinesWaitersRef.current;
    machinesWaitersRef.current = [];
    waiters.forEach((resolve) => resolve());
  }, [machines.loading]);

  const authReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!authReadyRef.current) {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => { resolve = r; });
    authReadyRef.current = { promise, resolve };
  }
  useEffect(() => {
    if (!webUserLoading) authReadyRef.current?.resolve();
  }, [webUserLoading]);

  // Unauthenticated + auth required: bounce to login, preserving location —
  // moved verbatim from the pre-lift AppShellBody effect.
  useEffect(() => {
    if (webUserLoading || !webAuthRequired || webUser) return;
    window.location.assign("/login?next=" + encodeURIComponent(window.location.pathname + window.location.search));
  }, [webAuthRequired, webUser, webUserLoading]);

  const resolverRef = useRef<ReturnType<typeof createNavigationResolver> | null>(null);
  if (!resolverRef.current) {
    resolverRef.current = createNavigationResolver((next) => {
      setResult(next);
      setResolutionRevision((r) => r + 1);
    });
  }

  const buildDeps = useCallback((): NavDeps => ({
    waitForAuth: () => authReadyRef.current!.promise,
    listMachines: async () => {
      if (!machinesRef.current.loading) return machinesRef.current.machines;
      await new Promise<void>((resolve) => machinesWaitersRef.current.push(resolve));
      return machinesRef.current.machines;
    },
    probeMachine: async (machineId: string): Promise<MachineProbeResult> => {
      try {
        const res = await fetch(apiPath("/api/health", machineId), { cache: "no-store" });
        if (res.ok) return "ok";
        if (res.status === 404) return "not-found";
        if (res.status === 403) return "no-permission";
        return "offline";
      } catch {
        return "offline";
      }
    },
    listSessions: async (machineId: string): Promise<SessionInfo[]> => {
      try {
        return await sessionListRef.current.fetchSessionsFor(machineId);
      } catch (err) {
        if (err instanceof NavOfflineError) throw err;
        return [];
      }
    },
    validateCwd: async (machineId: string, cwd: string): Promise<string | null> => {
      let res: Response;
      try {
        res = await fetch(apiPath("/api/cwd/validate", machineId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
      } catch {
        throw new NavOfflineError(`Machine unreachable: ${machineId}`);
      }
      if (res.status === 502) throw new NavOfflineError(`Machine unreachable: ${machineId}`);
      if (!res.ok) return null;
      const data = await res.json().catch(() => null) as { cwd?: string } | null;
      return data?.cwd ?? null;
    },
    getSession: async (machineId: string, sessionId: string): Promise<SessionInfo | null> => {
      let res: Response;
      try {
        res = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sessionId)}`, machineId), { cache: "no-store" });
      } catch {
        throw new NavOfflineError(`Machine unreachable: ${machineId}`);
      }
      if (res.status === 502) throw new NavOfflineError(`Machine unreachable: ${machineId}`);
      if (res.status === 404 || !res.ok) return null;
      const data = await res.json().catch(() => null) as { info?: SessionInfo | null } | null;
      return data?.info ?? null;
    },
    getLastOpenSession: (projectKey: string) => getLastOpenSession(projectKey),
    removedProjectsSupplier: () => loadRemovedProjects(),
    onMachineCommit: (machineId: string) => machinesRef.current.commitMachineId(machineId),
  }), []);

  const runCurrentLocation = useCallback(() => {
    const { pathname, search } = currentLocation();
    const parsed = parseLocation(pathname, search);
    const selection = selectionAtLocationIngress(parsed, search);
    resolverRef.current!.run(parsed, buildDeps(), { selection });
  }, [buildDeps]);

  // Boot: resolve the page's initial location once. `runCurrentLocation` is
  // stable because `buildDeps` reads live refs internally.
  useEffect(() => {
    runCurrentLocation();
  }, [runCurrentLocation]);

  // The nav module is the only popstate handler in the app.
  useEffect(() => {
    const onPopState = () => {
      runCurrentLocation();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [runCurrentLocation]);

  // Canonicalize the address bar once a URL-sourced resolution settles
  // somewhere other than where it started. Legacy query links and
  // defaults-selected machine switches resolve past their initial URL; a
  // select-nothing machine shell already equals its canonical `/m/<id>`.
  useEffect(() => {
    const { pathname, search } = currentLocation();
    const rewrite = canonicalRewriteUrl(result, pathname + search);
    if (rewrite) writeAddressBar(rewrite, "replace");
  }, [result]);

  const navigate = useCallback((next: NavigationTarget, options: NavigationNavigateOptions) => {
    // A blank interactive target is an "enter this machine" request unless a
    // caller explicitly preserves the older default-project/session behavior.
    const selection = options.selection ?? "none";
    const url = buildUrl(next);
    writeAddressBar(url, options.history);

    if (resultRef.current.phase !== "error" && resultRef.current.home && next.session) {
      // Home has no mounted AppShellBody to pre-seed with the clicked
      // SessionInfo. Route session clicks through the resolver even when the
      // machine is already current so the session object is fetched before the
      // shell mounts.
      resolverRef.current!.run({ kind: "target", target: next }, buildDeps(), { selection });
      return;
    }

    const requiresDefaultResolution = selection === "defaults"
      && next.project === null
      && next.session === null;
    if (next.machineId !== machinesRef.current.machineId || requiresDefaultResolution) {
      // Machine changes, and explicit blank-target defaults on the current
      // machine, use the async pipeline so validation/defaulting happens at
      // the same staged commit points as an equivalent deeplink.
      resolverRef.current!.run({ kind: "target", target: next }, buildDeps(), { selection });
      return;
    }
    setResult({ phase: "settled", target: next, session: null, error: null, source: "url", home: false });
  }, [buildDeps]);

  const goHome = useCallback(() => {
    writeAddressBar("/", "push");
    resolverRef.current!.run(parseLocation("/", ""), buildDeps());
  }, [buildDeps]);

  const retry = useCallback(() => {
    runCurrentLocation();
  }, [runCurrentLocation]);

  const value = useMemo<NavigationContextValue>(() => ({
    target: result.target,
    session: result.session,
    home: result.phase === "error" ? false : result.home,
    phase: result.phase === "error" ? "settled" : result.phase, // "error" is rendered by the gate below, never observed by children
    error: result.error,
    resolutionRevision,
    navigate,
    goHome,
    retry,
  }), [result, resolutionRevision, navigate, goHome, retry]);

  if (result.phase === "error" && result.error) {
    return <ErrorGate error={result.error} t={t} onRetry={retry} onGoLocal={() => navigate({ machineId: "local", project: null, session: null }, { history: "replace", selection: "defaults" })} />;
  }

  if (result.phase !== "settled") {
    const labelKey = LOADING_LABEL_BY_PHASE[result.phase];
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 500,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 13,
      }}>
        {labelKey ? t(labelKey) : ""}
      </div>
    );
  }

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

function ErrorGate({
  error, t, onRetry, onGoLocal,
}: {
  error: NavError;
  t: (key: string) => string;
  onRetry: () => void;
  onGoLocal: () => void;
}): React.ReactElement {
  const variant = noticeVariantFrom(error);
  const titleKey = `accessNotice.${error.stage}.${variant}.title`;
  const bodyKey = `accessNotice.${error.stage}.${variant}.body`;
  const actions = variant === "offline"
    ? [
      { label: t("accessNotice.cta.retry"), onClick: onRetry, primary: true },
      { label: t("accessNotice.cta.goLocal"), onClick: onGoLocal },
    ]
    : [{ label: t("accessNotice.cta.goLocal"), onClick: onGoLocal, primary: true }];

  return <AccessNotice variant={variant} title={t(titleKey)} body={t(bodyKey)} actions={actions} />;
}
