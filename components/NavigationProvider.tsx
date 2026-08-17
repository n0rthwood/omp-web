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
 *  - Boot + popstate: untrusted input (a URL or localStorage resume) runs
 *    the full async `nav-state` pipeline — staged loading, validation,
 *    error taxonomy, storage write at settle.
 *  - Interactive (`navigate()`): the caller already holds an
 *    already-validated target (a session/project clicked from a loaded
 *    list, a machine picked from the loaded machines list) — this updates
 *    the URL, storage, and the machine seam directly, with no re-validation
 *    round trip. All 6 writer call sites (machine switch, session select,
 *    project select, new-session, session-created/-forked, session-deleted)
 *    use this path.
 *
 * Children render only once `phase === "settled"` — the whole-subtree
 * loading gate idiom, extended with per-stage progress and `AccessNotice`
 * error screens instead of a silent fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createNavigationResolver,
  NavOfflineError,
  writeLastLocation,
  type MachineProbeResult,
  type NavDeps,
  type NavError,
  type NavPhase,
  type NavResult,
  type NavStorageLike,
} from "@/lib/nav-state";
import { buildUrl, parseLocation, type NavigationTarget } from "@/lib/nav-url";
import { apiPath } from "@/lib/api-path";
import { useMachines } from "@/lib/machine-context";
import { useSessionList } from "@/lib/session-list-context";
import { useWebUser } from "@/hooks/useWebUser";
import { useI18n } from "@/hooks/useI18n";
import { getLastOpenSession } from "@/lib/workspace-memory";
import { AccessNotice, type AccessNoticeVariant } from "./AccessNotice";
import type { SessionInfo } from "@/lib/types";
import { createContext, useContext } from "react";

const LAST_LOCATION_STORAGE_KEY = "omp-web:last-location";

function getStorage(): NavStorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    // Probe access — some browsers (privacy mode) expose the object but throw on use.
    window.localStorage.getItem(LAST_LOCATION_STORAGE_KEY);
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface NavigationContextValue {
  target: NavigationTarget;
  /** The resolved session object once known — set at settle (deeplink/resume/popstate), stale after a subsequent interactive `navigate()`. Consumers needing a live value should track their own selection instead. */
  session: SessionInfo | null;
  phase: NavPhase;
  error: NavError | null;
  /** Updates URL, localStorage resume, and (if it changed) the machine seam for an already-validated target. Never re-runs the async pipeline. */
  navigate(target: NavigationTarget, options: { history: "push" | "replace" }): void;
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
  const router = useRouter();
  const machines = useMachines();
  const sessionList = useSessionList();
  const { user: webUser, authRequired: webAuthRequired, loading: webUserLoading } = useWebUser();
  const { t } = useI18n();

  const [result, setResult] = useState<NavResult>({
    phase: "boot",
    target: { machineId: "local", project: null, session: null },
    session: null,
    error: null,
  });

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
    resolverRef.current = createNavigationResolver((next) => setResult(next));
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
    onMachineCommit: (machineId: string) => machinesRef.current.commitMachineId(machineId),
    storage: getStorage(),
  }), []);

  // Boot: resolve the page's initial location once.
  useEffect(() => {
    const { pathname, search } = currentLocation();
    resolverRef.current!.run(parseLocation(pathname, search), buildDeps());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; buildDeps reads live refs internally.
  }, []);

  // The nav module is the only popstate handler in the app.
  useEffect(() => {
    const onPopState = () => {
      const { pathname, search } = currentLocation();
      resolverRef.current!.run(parseLocation(pathname, search), buildDeps());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [buildDeps]);

  const navigate = useCallback((next: NavigationTarget, options: { history: "push" | "replace" }) => {
    if (next.machineId !== machinesRef.current.machineId) {
      machinesRef.current.commitMachineId(next.machineId);
    }
    const url = buildUrl(next);
    if (options.history === "push") router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
    writeLastLocation(getStorage(), { v: 1, machine: next.machineId, project: next.project, session: next.session });
    setResult({ phase: "settled", target: next, session: null, error: null });
  }, [router]);

  const retry = useCallback(() => {
    const { pathname, search } = currentLocation();
    resolverRef.current!.run(parseLocation(pathname, search), buildDeps());
  }, [buildDeps]);

  const value = useMemo<NavigationContextValue>(() => ({
    target: result.target,
    session: result.session,
    phase: result.phase === "error" ? "settled" : result.phase, // "error" is rendered by the gate below, never observed by children
    error: result.error,
    navigate,
    retry,
  }), [result, navigate, retry]);

  if (result.phase === "error" && result.error) {
    return <ErrorGate error={result.error} t={t} onRetry={retry} onGoLocal={() => navigate({ machineId: "local", project: null, session: null }, { history: "replace" })} />;
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
