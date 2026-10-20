"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  machineHealthMapFromReports,
  machineHealthPollIntervalMs,
  shouldApplyMachineHealthResponse,
  type MachineHealthLike,
  type MachineHealthReport,
} from "@/lib/machine-health";

/** What the switcher renders: a verdict, or "loading" before the first one. */
export interface SwitcherHealth {
  state: "loading" | "online" | "offline" | "unauthorized";
  reason?: string;
}

/**
 * Polls the gateway's aggregate `GET /api/machines/health` (issue #82) so the
 * machine switcher's status dots follow reality without an F5.
 *
 * - 30s while the tab is visible and every machine is online; 8s as soon as
 *   one is offline/unauthorized/unknown (pure choice in `lib/machine-health`).
 * - Paused while the document is hidden (ticks become no-ops); refreshes
 *   immediately on visibilitychange -> visible, window `online`, `focus`, and
 *   on demand (dropdown open) via the returned `refresh`.
 * - Every poll bumps a monotonic run id; a response is applied only while it
 *   still owns the latest run and the poller is mounted, so out-of-order or
 *   late responses never overwrite a newer verdict. The in-flight request is
 *   aborted when a newer poll takes over and on unmount.
 */
export function useMachineHealth(machines: readonly { id: string }[]): {
  health: Record<string, SwitcherHealth>;
  refresh: () => void;
} {
  const [health, setHealth] = useState<Record<string, SwitcherHealth>>({});
  const idsKey = machines.map((machine) => machine.id).join("\n");
  const healthRef = useRef<Record<string, SwitcherHealth>>(health);
  useEffect(() => {
    healthRef.current = health;
  }, [health]);

  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let latestRunId = 0;
    const ids = idsKey === "" ? [] : idsKey.split("\n");

    function schedule(snapshot: Readonly<Record<string, MachineHealthLike>>): void {
      if (disposed || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (document.hidden) {
          // Paused, but alive: keep rescheduling so the next visibilitychange
          // handler finds a running loop to hand back to.
          schedule(healthRef.current);
          return;
        }
        void pump();
      }, machineHealthPollIntervalMs(ids, snapshot));
    }

    async function pump(): Promise<void> {
      const runId = ++latestRunId;
      controller?.abort();
      controller = new AbortController();
      // Must exceed the gateway's own probe deadline (15s) so the browser
      // never pre-empts the gateway's verdict; WAN remotes need the window.
      const deadline = window.setTimeout(() => controller?.abort(), 20_000);
      let applied: Record<string, MachineHealthLike> | null = null;
      try {
        // Gateway-local fleet surface: bare /api/... — never routed through
        // apiPath(), which would proxy it to the current remote instead.
        const response = await fetch("/api/machines/health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) {
          const body = (await response.json().catch(() => null)) as { machines?: MachineHealthReport[] } | null;
          if (Array.isArray(body?.machines)) {
            if (shouldApplyMachineHealthResponse(runId, latestRunId, disposed)) {
              applied = machineHealthMapFromReports(body.machines);
              setHealth(applied);
            }
          }
        }
        // A non-OK response keeps the last known verdicts; the next tick retries.
      } catch {
        // Aborted (a newer poll took over, or unmount) or the network is
        // down — either way the last known verdicts stay on screen.
      } finally {
        window.clearTimeout(deadline);
        // Only the latest run may (re)arm the timer, and only when none is
        // pending — stale runs defer to the newer poll that superseded them.
        if (!disposed && runId === latestRunId && timer === null) {
          schedule(applied ?? healthRef.current);
        }
      }
    }

    function refreshNow(): void {
      if (disposed) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void pump();
    }

    const onVisibilityChange = () => {
      if (!document.hidden) refreshNow();
    };

    refreshRef.current = refreshNow;
    void pump();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", refreshNow);
    window.addEventListener("focus", refreshNow);

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", refreshNow);
      window.removeEventListener("focus", refreshNow);
    };
  }, [idsKey]);

  return { health, refresh };
}
