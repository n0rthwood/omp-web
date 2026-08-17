"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { SafeMachine, UserVisibleMachine } from "@/lib/api-types";
import { LOCAL_MACHINE_ID, setCurrentMachineId } from "@/lib/api-path";
import { parseLocation } from "@/lib/nav-url";

export const localMachine: SafeMachine = {
  id: LOCAL_MACHINE_ID,
  name: "This machine",
  baseUrl: "",
  authMode: "none",
  hasCredential: false,
  headerNames: [],
  createdAt: "",
  updatedAt: "",
  isLocal: true,
};

export interface MachineContextValue {
  machineId: string; // current, "local" by default
  // Admin sees the full SafeMachine projection; a user role sees the
  // slimmed UserVisibleMachine (no baseUrl, no headerNames) for granted
  // machines — see `lib/api-types.ts#UserVisibleMachine`.
  machines: (SafeMachine | UserVisibleMachine)[]; // local first
  /**
   * Pure seam sync: updates `machineId` and the `apiPath()` module-level
   * current-machine id, nothing else. No URL write, no history entry, no
   * popstate handling — those are owned exclusively by
   * `NavigationProvider` (issue #10, stage 3), which calls this at its
   * machine-commit stage (async pipeline) and from `navigate()` (an
   * interactive machine switch, already validated against `machines`).
   */
  commitMachineId(id: string): void;
  refreshMachines(): Promise<void>;
  loading: boolean;
  error: string | null;
}

const MachineContext = createContext<MachineContextValue | null>(null);

/**
 * A synchronous best-effort guess at the initial machine, read once from
 * `window.location` before any child effect runs — so the `apiPath()` seam
 * (and this provider's first render) already point at the right machine for
 * the common case of reloading an existing deeplink. This is *not*
 * authoritative: `NavigationProvider`'s async pipeline resolves and commits
 * the final id (validated, with resume/legacy-query support), correcting
 * this guess if it was wrong or absent (e.g. a bare `/`, which resumes from
 * localStorage — this guess has no access to that and falls back to local).
 */
function initialMachineIdGuess(): string {
  if (typeof window === "undefined") return LOCAL_MACHINE_ID;
  const parsed = parseLocation(window.location.pathname, window.location.search);
  return parsed.kind === "target" ? parsed.target.machineId : LOCAL_MACHINE_ID;
}

setCurrentMachineId(initialMachineIdGuess());

export function MachineProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [machineId, setMachineIdState] = useState<string>(initialMachineIdGuess);
  const [machines, setMachines] = useState<(SafeMachine | UserVisibleMachine)[]>([localMachine]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The seam must be correct before any child effect runs; state updates alone
  // would leave the first render's children pointing at the wrong machine.
  setCurrentMachineId(machineId);

  const refreshMachines = useCallback(async () => {
    // Gateway-local fleet administration; never proxied.
    try {
      const res = await fetch("/api/machines", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        // Unauthenticated, or the trust gate rejected the request: degrade
        // to local-only. A signed-in user role is never 403'd here — the
        // route filters + slims the listing to their granted machines.
        setMachines([localMachine]);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { machines?: (SafeMachine | UserVisibleMachine)[] };
      const remote = Array.isArray(body.machines) ? body.machines : [];
      // Local first, remote machines in server order.
      setMachines([localMachine, ...remote.filter((m) => m && m.id !== LOCAL_MACHINE_ID)]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load machines");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMachines();
  }, [refreshMachines]);

  const commitMachineId = useCallback((id: string) => {
    const next = id.trim() || LOCAL_MACHINE_ID;
    setMachineIdState((prev) => {
      if (prev !== next) setCurrentMachineId(next);
      return prev === next ? prev : next;
    });
  }, []);

  const value = useMemo<MachineContextValue>(
    () => ({ machineId, machines, commitMachineId, refreshMachines, loading, error }),
    [machineId, machines, commitMachineId, refreshMachines, loading, error],
  );

  return <MachineContext.Provider value={value}>{props.children}</MachineContext.Provider>;
}

export function useMachines(): MachineContextValue {
  const context = useContext(MachineContext);
  if (!context) throw new Error("useMachines must be used inside MachineProvider");
  return context;
}
