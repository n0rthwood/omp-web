"use client";

import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api-path";
import type { ProviderStatusSnapshot } from "@/lib/provider-status";

const POLL_INTERVAL_MS = 60_000;

/**
 * Shared provider-status poll (issue #145).
 *
 * Lives in the shell rather than in the strip itself: ChatWindow is re-keyed
 * per session, so a poll owned by the strip would restart from an empty
 * snapshot on every session switch. One poll here means the strip above the
 * composer re-renders instantly with the last snapshot. Requests go through
 * apiPath(), so a remote machine view shows that machine's snapshot via the
 * gateway proxy.
 */
export function useProviderStatus(): ProviderStatusSnapshot | null {
  const [snapshot, setSnapshot] = useState<ProviderStatusSnapshot | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;

    async function poll() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(apiPath("/api/provider-status"), { signal: controller.signal });
        if (response.ok && mountedRef.current) {
          setSnapshot((await response.json()) as ProviderStatusSnapshot);
        }
      } catch {
        // Transient network failure: keep the last snapshot, retry next tick.
      }
      if (mountedRef.current) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
    void poll();

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  return snapshot;
}
