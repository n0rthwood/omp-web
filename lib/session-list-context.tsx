"use client";

/**
 * Session-list ownership, lifted above the machine remount key (issue #10,
 * stage 3). Was previously private to `SessionSidebar`; both the sidebar and
 * `NavigationProvider`'s resolution pipeline need it now — a machine-scoped
 * provider *below* the remount key cannot be awaited by a pipeline running
 * above it (context does not flow upward, and a remount destroys it).
 *
 * `fetch + refreshKey + running-poll` moved up as-is (see the pre-lift
 * SessionSidebar for the exact previous shape); unread-session bookkeeping
 * stays local to SessionSidebar since it is a UI/notification concern with
 * no bearing on navigation resolution.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "./api-path";
import { NavOfflineError } from "./nav-state";
import { useMachines } from "./machine-context";
import type { SessionInfo } from "./types";

const RUNNING_SESSIONS_POLL_MS = 2500;

export interface SessionListContextValue {
  /** The current machine's session list (see `useMachines().machineId`). */
  sessions: SessionInfo[];
  loading: boolean;
  error: string | null;
  runningSessionIds: Set<string>;
  /** True briefly after a background (non-loading) refresh completes. */
  refreshDone: boolean;
  /** Bumped by `bumpRefreshKey()`; expose as an effect dependency for anything else that should re-check on the same external trigger (e.g. worktrees). */
  refreshKey: number;
  /** Direct reload of the current machine's list — manual refresh, or an internal auto-trigger. Does not bump `refreshKey`. */
  refresh(force?: boolean): void;
  /** External "something changed" signal (session created/deleted/forked, rename, auto-name, project trust...). Also reloads the list. */
  bumpRefreshKey(): void;
  /** One-off fetch for an arbitrary machine — used by the navigation pipeline to validate a deeplink/resume target before it becomes "current". Bypasses the reactive state above entirely. */
  fetchSessionsFor(machineId: string): Promise<SessionInfo[]>;
  /** Threads the currently-selected session id in from AppShellBody so its
   *  own completion never double-reloads/flashes the list via the polling
   *  transition below — `bumpRefreshKey()` on agent-end already covers it
   *  (issue #10 stage-3 review, minor #6). */
  setActiveSessionId(id: string | null): void;
}

async function fetchSessionList(
  machineId: string,
  force: boolean,
): Promise<{ sessions: SessionInfo[]; runningSessionIds: string[] }> {
  let res: Response;
  try {
    res = await fetch(apiPath(force ? "/api/sessions?force=1" : "/api/sessions", machineId), { cache: "no-store" });
  } catch {
    throw new NavOfflineError(`Machine unreachable: ${machineId}`);
  }
  if (res.status === 502) throw new NavOfflineError(`Machine unreachable: ${machineId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
  return { sessions: data.sessions, runningSessionIds: data.runningSessionIds ?? [] };
}

const SessionListContext = createContext<SessionListContextValue | null>(null);

export function SessionListProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { machineId } = useMachines();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [refreshDone, setRefreshDone] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; a slower /api/sessions response must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const previousRunningRef = useRef<Set<string>>(new Set());
  const refreshDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Threaded in from AppShellBody (minor #6) so its own completion never
  // double-reloads/flashes the list via the polling transition below.
  const activeSessionIdRef = useRef<string | null>(null);
  const setActiveSessionId = useCallback((id: string | null) => {
    activeSessionIdRef.current = id;
  }, []);

  // Machine-switch reset, done synchronously during render (the React
  // "adjusting state during render" pattern) rather than in an effect —
  // otherwise the previous machine's session list paints for one frame
  // under the new machineId before the effect below clears it (issue #10
  // stage-3 review, minor #7).
  const sessionsMachineIdRef = useRef(machineId);
  if (sessionsMachineIdRef.current !== machineId) {
    sessionsMachineIdRef.current = machineId;
    runningPollAuthoritativeRef.current = false;
    previousRunningRef.current = new Set();
    setSessions([]);
    setRunningSessionIds(new Set());
    setError(null);
    setLoading(true);
  }

  const load = useCallback(async (showLoading: boolean, force: boolean) => {
    try {
      if (showLoading) setLoading(true);
      const { sessions: fetched, runningSessionIds: running } = await fetchSessionList(machineId, force);
      setSessions(fetched);
      if (!runningPollAuthoritativeRef.current) setRunningSessionIds(new Set(running));
      setError(null);
      if (!showLoading) {
        setRefreshDone(true);
        clearTimeout(refreshDoneTimerRef.current ?? undefined);
        refreshDoneTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [machineId]);

  // The initial (or machine-switch) load. State reset now happens
  // synchronously during render above — this effect only kicks off the
  // fetch itself.
  useEffect(() => {
    void load(true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is recreated with `machineId`; listing both is redundant, not incorrect.
  }, [machineId]);

  // External refreshKey bumps (session created/deleted/forked, rename, ...)
  // reload in the background, same as every such trigger did pre-lift.
  // `load`'s identity also changes on every machine switch (it closes over
  // `machineId`) — depending on it directly would refire this effect
  // alongside the one above and double-fetch (issue #10 stage-3 review,
  // minor #4), so only `refreshKey` itself is a dependency; `loadRef` reads
  // the current `load` without retriggering on its identity changing.
  const loadRef = useRef(load);
  loadRef.current = load;
  const isInitialRefreshKeyRef = useRef(true);
  useEffect(() => {
    if (isInitialRefreshKeyRef.current) {
      isInitialRefreshKeyRef.current = false;
      return;
    }
    void loadRef.current(false, true);
  }, [refreshKey]);

  // 2.5s running-session poll, paused while the tab is hidden.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      clearTimeout(timer ?? undefined);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch(apiPath("/api/agent/running", machineId), {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[] };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [machineId]);

  // Refetch when a running session isn't listed yet, or one just completed
  // in the background — the list itself is stale in both cases. The
  // currently-active session is excluded from "completed": its own
  // completion is already handled by `bumpRefreshKey()` on agent-end, so
  // including it here would reload (and flash `refreshDone`) twice for the
  // same event (issue #10 stage-3 review, minor #6).
  useEffect(() => {
    const previous = previousRunningRef.current;
    const completed = [...previous].filter((id) => !runningSessionIds.has(id) && id !== activeSessionIdRef.current);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));
    const hasUnlisted = newlyRunning.some((id) => !sessions.some((s) => s.id === id));
    if (completed.length > 0 || hasUnlisted) void load(false, true);
    previousRunningRef.current = runningSessionIds;
  }, [runningSessionIds, sessions, load]);

  useEffect(() => () => {
    clearTimeout(refreshDoneTimerRef.current ?? undefined);
  }, []);

  const refresh = useCallback((force = true) => {
    void load(false, force);
  }, [load]);

  const bumpRefreshKey = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const fetchSessionsFor = useCallback(async (targetMachineId: string): Promise<SessionInfo[]> => {
    const { sessions: fetched } = await fetchSessionList(targetMachineId, false);
    return fetched;
  }, []);

  const value = useMemo<SessionListContextValue>(() => ({
    sessions, loading, error, runningSessionIds, refreshDone, refreshKey, refresh, bumpRefreshKey, fetchSessionsFor, setActiveSessionId,
  }), [sessions, loading, error, runningSessionIds, refreshDone, refreshKey, refresh, bumpRefreshKey, fetchSessionsFor, setActiveSessionId]);

  return <SessionListContext.Provider value={value}>{children}</SessionListContext.Provider>;
}

export function useSessionList(): SessionListContextValue {
  const ctx = useContext(SessionListContext);
  if (!ctx) throw new Error("useSessionList must be used inside SessionListProvider");
  return ctx;
}
