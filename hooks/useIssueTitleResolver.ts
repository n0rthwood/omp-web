"use client";

/**
 * Lazy, cached GitHub issue-title resolution for the sidebar's hover
 * popover and detail drawer (issue #22). Owner decision: resolved titles
 * are shown in those two surfaces ONLY, never embedded in the row's own
 * title/chips.
 *
 * The module-level cache is intentionally outside React state — it must
 * survive this hook's owning component unmounting (e.g. the popover
 * closing) so re-hovering the same issue chip is instant. `resolve()` is a
 * no-op once a number is cached or already in flight; callers re-render via
 * the returned version counter once a fetch settles.
 */

import { useCallback, useMemo, useReducer, useRef } from "react";
import { apiPath } from "@/lib/api-path";

interface IssueTitleEntry {
  title: string | null;
  reason?: string;
}

const issueTitleCache = new Map<string, IssueTitleEntry>();

function cacheKeyFor(projectRoot: string, issueNumber: number): string {
  return `${projectRoot}#${issueNumber}`;
}

export interface IssueTitleResolver {
  /** Cached result for `issueNumber`, or `undefined` if never resolved. */
  get(projectRoot: string, issueNumber: number): IssueTitleEntry | undefined;
  /** Kick off resolution when not already cached or in flight. Safe to call
   *  every render — it no-ops once satisfied. */
  resolve(projectRoot: string, issueNumber: number): void;
}

/** Shared lazy GitHub issue-title resolver, backed by the server's own LRU
 *  cache (app/api/issue-title) plus a client-side cache for instant re-hover. */
export function useIssueTitleResolver(): IssueTitleResolver {
  const [, forceRerender] = useReducer((n: number) => n + 1, 0);
  const pendingRef = useRef<Set<string>>(new Set());

  const resolve = useCallback((projectRoot: string, issueNumber: number) => {
    if (!projectRoot || !Number.isInteger(issueNumber) || issueNumber <= 0) return;
    const key = cacheKeyFor(projectRoot, issueNumber);
    if (issueTitleCache.has(key) || pendingRef.current.has(key)) return;
    pendingRef.current.add(key);

    const params = new URLSearchParams({ issueNumber: String(issueNumber), projectRoot });
    fetch(apiPath(`/api/issue-title?${params.toString()}`))
      .then((res) => res.json())
      .then((data: { title?: string | null; reason?: string; definitive?: boolean }) => {
        // Only cache definitive outcomes (resolved title, confirmed 404,
        // deterministic validation/no-remote failure). Transient failures
        // (timeout, rate limit, network error) stay uncached so the next
        // hover — a fresh mount of the popover — retries instead of
        // permanently showing a stale failure.
        if (data.definitive) {
          issueTitleCache.set(key, { title: data.title ?? null, reason: data.reason });
        }
      })
      .catch(() => {
        // Fetch itself failed (network down, etc.) — transient, leave
        // uncached.
      })
      .finally(() => {
        pendingRef.current.delete(key);
        forceRerender();
      });
  }, []);

  const get = useCallback(
    (projectRoot: string, issueNumber: number) => issueTitleCache.get(cacheKeyFor(projectRoot, issueNumber)),
    [],
  );

  // `get`/`resolve` are already stable (useCallback, empty deps); memoize
  // the returned object too so consumers using it as an effect dependency
  // (SessionTreeItem's resolve-on-mount effect) don't re-run on every
  // parent render — only `get`/`resolve` identity changes would trigger it,
  // and those never change.
  return useMemo(() => ({ get, resolve }), [get, resolve]);
}
