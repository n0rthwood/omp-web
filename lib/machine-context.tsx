"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { SafeMachine } from "@/lib/api-types";
import { LOCAL_MACHINE_ID, setCurrentMachineId } from "@/lib/api-path";

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
  machines: SafeMachine[]; // local first
  setMachineId(id: string): void; // updates ?machine= and remounts the app subtree
  refreshMachines(): Promise<void>;
  loading: boolean;
  error: string | null;
}

const MachineContext = createContext<MachineContextValue | null>(null);

/**
 * Read ?machine= and push it into the module-level seam synchronously.
 *
 * Runs at module scope AND at provider mount so the id is settled before any
 * child effect issues an API call or touches a namespaced storage key. An
 * unknown or missing value falls back to `local`.
 */
function readMachineFromLocation(): string {
  if (typeof window === "undefined") return LOCAL_MACHINE_ID;
  const raw = window.location.search
    ? new URLSearchParams(window.location.search).get("machine")
    : null;
  const id = raw?.trim();
  return id ? id : LOCAL_MACHINE_ID;
}

setCurrentMachineId(readMachineFromLocation());

export function MachineProvider(props: { children: React.ReactNode }): React.ReactElement {
  const router = useRouter();
  const [machineId, setMachineIdState] = useState<string>(readMachineFromLocation);
  const [machines, setMachines] = useState<SafeMachine[]>([localMachine]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The seam must be correct before any child effect runs; state updates alone
  // would leave the first render's children pointing at the wrong machine.
  setCurrentMachineId(machineId);

  const refreshMachines = useCallback(async () => {
    // Gateway-local fleet administration; never proxied.
    try {
      const res = await fetch("/api/machines", { cache: "no-store" });
      if (res.status === 403) {
        // Non-admin user: the fleet is admin-only, degrade to local-only.
        setMachines([localMachine]);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { machines?: SafeMachine[] };
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

  const setMachineId = useCallback((id: string) => {
    const next = id.trim() || LOCAL_MACHINE_ID;
    setMachineIdState((prev) => {
      if (prev !== next) setCurrentMachineId(next);
      return prev === next ? prev : next;
    });
    // Same router.replace mechanism AppShell uses for ?session=; a session id
    // from another machine is meaningless, so ?session= is cleared on switch.
    const params = new URLSearchParams(window.location.search);
    const search = new URLSearchParams();
    if (next !== LOCAL_MACHINE_ID) search.set("machine", next);
    params.delete("session");
    for (const [k, v] of params) if (k !== "machine") search.set(k, v);
    router.replace(search.size ? `?${search.toString()}` : "/", { scroll: false });
  }, [router]);

  // Keep the seam in sync if ?machine= is changed out-of-band (back/forward,
  // shareable link) — replaceState-only history updates don't remount us.
  useEffect(() => {
    const onPop = () => {
      const next = readMachineFromLocation();
      setMachineIdState(next);
      setCurrentMachineId(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const value = useMemo<MachineContextValue>(
    () => ({ machineId, machines, setMachineId, refreshMachines, loading, error }),
    [machineId, machines, setMachineId, refreshMachines, loading, error],
  );

  return <MachineContext.Provider value={value}>{props.children}</MachineContext.Provider>;
}

export function useMachines(): MachineContextValue {
  const context = useContext(MachineContext);
  if (!context) throw new Error("useMachines must be used inside MachineProvider");
  return context;
}
