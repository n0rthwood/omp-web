"use client";

import { useEffect, useState } from "react";
import { serverVersionFromHealth, shouldShowBanner } from "@/lib/version-check";

/**
 * Version-staleness banner (issue #63). After a `.deb` upgrade the server
 * restarts onto the new build while open tabs keep running the old client
 * bundle for hours; this detects the skew and offers a reload.
 *
 * Polls the BARE local `/api/health` (never through `apiPath()`/machine
 * proxy — only the same-origin gateway that served this tab's JS can be
 * stale for this tab) while the tab is visible, comparing the server's
 * `ompWebVersion` against the `NEXT_PUBLIC_APP_VERSION` inlined into the
 * loaded bundle. Poll shape follows lib/session-list-context.tsx: fetch on
 * mount and on visibilitychange→visible, abort in flight when hidden, skip
 * while hidden. Any fetch/parse failure is silent — the banner is a
 * convenience, not an error surface.
 *
 * Mounted from app/layout.tsx next to <PwaRegistration /> — outside the
 * `key={machineId}` app subtree (components/AppShell.tsx), so a machine
 * switch never tears it down. Purely client-side state (server version is
 * unknown until the first poll), so there is no hydration risk.
 */

const HEALTH_POLL_MS = 5 * 60 * 1000;

export function VersionRefreshBanner() {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [dismissedServerVersion, setDismissedServerVersion] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      window.clearTimeout(timer ?? undefined);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => void poll(), HEALTH_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/health", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (stopped || controller !== current) return;
        const version = serverVersionFromHealth(data);
        // Keep the last known version on a malformed payload; the next
        // visible-tab poll retries.
        if (version !== undefined) setServerVersion(version);
      } catch {
        // Aborted or unreachable: silent, no banner, no console spam.
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
  }, []);

  const clientVersion = process.env.NEXT_PUBLIC_APP_VERSION;
  if (!shouldShowBanner(clientVersion, serverVersion, dismissedServerVersion)) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: "calc(env(safe-area-inset-bottom) + 14px)",
        right: "calc(env(safe-area-inset-right) + 14px)",
        zIndex: 400,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px 8px 14px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        color: "var(--text)",
        fontSize: 12,
      }}
    >
      <span style={{ whiteSpace: "nowrap" }}>
        omp-web updated:{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {clientVersion} → {serverVersion}
        </span>
      </span>
      <button
        onClick={() => window.location.reload()}
        style={{
          padding: "5px 12px",
          border: "none",
          borderRadius: 6,
          background: "var(--accent)",
          color: "#fff",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        Refresh
      </button>
      <button
        onClick={() => setDismissedServerVersion(serverVersion)}
        title="Dismiss"
        aria-label="Dismiss"
        style={{
          padding: "2px 6px",
          border: 0,
          background: "none",
          color: "var(--text-muted)",
          fontSize: 20,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}
