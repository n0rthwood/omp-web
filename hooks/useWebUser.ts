"use client";

import { useCallback, useEffect, useState } from "react";

export type WebMeUser = {
  username: string;
  role: "admin" | "user";
  visibleProjects: string[] | "*";
};

export type WebMeSnapshot = {
  user: WebMeUser | null;
  authRequired: boolean;
};

type WebMeState = WebMeSnapshot & { loading: boolean };

// Module-level cache + in-flight dedupe so the several components that call
// this hook (AppShell, SessionSidebar, SettingsConfig) share one /api/auth/web-me
// request per mount wave instead of each issuing their own.
let cached: WebMeSnapshot | null = null;
let inflight: Promise<WebMeSnapshot> | null = null;

async function fetchWebMe(): Promise<WebMeSnapshot> {
  const response = await fetch("/api/auth/web-me", { cache: "no-store" });
  const result = (await response.json().catch(() => ({}))) as Partial<WebMeSnapshot> & { error?: string };
  if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
  const snapshot: WebMeSnapshot = {
    user: result.user ?? null,
    authRequired: Boolean(result.authRequired),
  };
  cached = snapshot;
  return snapshot;
}

function loadWebMe(): Promise<WebMeSnapshot> {
  if (!inflight) {
    inflight = fetchWebMe().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function useWebUser() {
  const [state, setState] = useState<WebMeState>(
    () => (cached ? { ...cached, loading: false } : { user: null, authRequired: false, loading: true }),
  );

  useEffect(() => {
    let cancelled = false;
    void loadWebMe()
      .then((snapshot) => {
        if (!cancelled) setState({ ...snapshot, loading: false });
      })
      .catch(() => {
        // Keep the logged-out defaults; the proxy middleware will redirect to
        // /login on the next navigation if auth is actually required.
        if (!cancelled) setState({ user: null, authRequired: false, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async (): Promise<WebMeSnapshot> => {
    const snapshot = await loadWebMe();
    setState({ ...snapshot, loading: false });
    return snapshot;
  }, []);

  return { user: state.user, authRequired: state.authRequired, loading: state.loading, refresh };
}
