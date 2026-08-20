/**
 * GitHub issue title resolution for the sidebar's hover popover / detail
 * drawer (issue #22). Owner decision: issue titles are resolved for display
 * in those two surfaces ONLY — the row itself keeps the bare "#N" chip.
 *
 * Repo resolution: `projectRoot`'s `origin` remote, parsed for a
 * github.com owner/repo pair (matches how components/HomeCalendar.tsx's
 * IssueChips already link plainly to
 * `https://github.com/n0rthwood/omp-web/issues/<n>` — this generalizes that
 * to whatever repo the session's own project actually points at). An
 * explicit `repo` (owner/name) skips the git lookup entirely.
 *
 * This is deliberately a *remote-resolve* endpoint (see the proxy-allowlist
 * entry): `projectRoot` only exists on disk on whichever machine hosts that
 * project, so the git remote lookup — and thus the whole resolution — must
 * run on that machine, not centrally on the gateway.
 *
 * Results are cached (LRU, ~10 min TTL) so a hover-heavy sidebar session
 * doesn't hammer the GitHub REST API. Every failure mode (no remote, 404,
 * rate limit, network error) degrades to `{ title: null }` so the caller
 * can fall back to the bare issue number — never thrown, never a non-200.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  title: string | null;
  fetchedAt: number;
}

interface RepoCacheEntry {
  repo: string | null;
  resolvedAt: number;
}

declare global {
  var __ompIssueTitleCache: Map<string, CacheEntry> | undefined;
  var __ompIssueTitleRepoCache: Map<string, RepoCacheEntry> | undefined;
}

function getCache(): Map<string, CacheEntry> {
  if (!globalThis.__ompIssueTitleCache) globalThis.__ompIssueTitleCache = new Map();
  return globalThis.__ompIssueTitleCache;
}

function getRepoCache(): Map<string, RepoCacheEntry> {
  if (!globalThis.__ompIssueTitleRepoCache) globalThis.__ompIssueTitleRepoCache = new Map();
  return globalThis.__ompIssueTitleRepoCache;
}

/** Re-insert `key` as most-recently-used and evict the oldest entry past the cap. */
function touchLru(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}

const GITHUB_REMOTE_RE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/** Parse "owner/repo" out of a GitHub remote URL (https:// or git@ form). */
export function parseGithubRemote(remoteUrl: string): string | null {
  const match = remoteUrl.trim().match(GITHUB_REMOTE_RE);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Resolve `projectRoot`'s GitHub "owner/repo" from its origin remote,
 *  cached (TTL ~10 min, same as the issue cache) so a hover-heavy sidebar
 *  session doesn't re-exec `git` on every request. A stable "no remote"
 *  result (`null`) is cached too — it's stable per repo until the remote
 *  actually changes. */
async function resolveRepoFromProjectRoot(projectRoot: string): Promise<string | null> {
  const cache = getRepoCache();
  const cached = cache.get(projectRoot);
  const now = Date.now();
  if (cached && now - cached.resolvedAt < CACHE_TTL_MS) return cached.repo;

  let repo: string | null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectRoot, "remote", "get-url", "origin"],
      { timeout: 5_000, maxBuffer: 65_536, env: { ...process.env, LC_ALL: "C" } },
    );
    repo = parseGithubRemote(stdout);
  } catch {
    repo = null;
  }
  cache.set(projectRoot, { repo, resolvedAt: now });
  return repo;
}

export interface ResolveIssueTitleOptions {
  /** Explicit "owner/repo"; skips the git remote lookup when valid. */
  repo?: string;
  /** Session project root to resolve a repo from, when `repo` is not given. */
  projectRoot?: string;
  issueNumber: number;
  /** Optional token for higher GitHub API rate limits — never echoed back. */
  githubToken?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface IssueTitleResult {
  title: string | null;
  /** "owner/repo" once resolved, even on a failed/not-found lookup. */
  repo?: string;
  /** Present on every non-success outcome; absent on a resolved title. */
  reason?: "invalid-issue-number" | "no-github-remote" | "not-found" | "timeout" | string;
  /** True when this result was served from the LRU cache. */
  cached: boolean;
  /** True when this outcome is stable and safe for a client to cache
   *  indefinitely (a resolved title, a confirmed 404, or a deterministic
   *  validation/no-remote failure). False for transient outcomes — network
   *  errors, timeouts, rate limits — that deserve a retry on next hover. */
  definitive: boolean;
  /** ISO timestamp of the underlying fetch (unchanged across cache hits —
   *  callers can use this to demonstrate caching without any debug output). */
  resolvedAt: string;
}

export async function resolveIssueTitle(options: ResolveIssueTitleOptions): Promise<IssueTitleResult> {
  const { issueNumber, githubToken, fetchImpl = fetch } = options;
  const now = Date.now();
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return { title: null, reason: "invalid-issue-number", cached: false, definitive: true, resolvedAt: new Date(now).toISOString() };
  }

  let repo = options.repo?.trim();
  if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) repo = undefined;
  if (!repo && options.projectRoot) {
    repo = (await resolveRepoFromProjectRoot(options.projectRoot)) ?? undefined;
  }
  if (!repo) {
    return { title: null, reason: "no-github-remote", cached: false, definitive: true, resolvedAt: new Date(now).toISOString() };
  }

  const cache = getCache();
  const key = `${repo}#${issueNumber}`;
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    touchLru(cache, key, cached);
    return {
      title: cached.title,
      repo,
      ...(cached.title === null ? { reason: "not-found" as const } : {}),
      cached: true,
      definitive: true,
      resolvedAt: new Date(cached.fetchedAt).toISOString(),
    };
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "omp-web",
    };
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });

    if (res.status === 404) {
      touchLru(cache, key, { title: null, fetchedAt: now });
      return { title: null, repo, reason: "not-found", cached: false, definitive: true, resolvedAt: new Date(now).toISOString() };
    }
    if (!res.ok) {
      // Transient/rate-limit/auth failure: degrade gracefully without
      // caching the failure, so a retry once the condition clears can
      // still succeed within the same TTL window.
      return { title: null, repo, reason: `github-${res.status}`, cached: false, definitive: false, resolvedAt: new Date(now).toISOString() };
    }

    const payload = await res.json() as { title?: unknown };
    const title = typeof payload.title === "string" ? payload.title : null;
    touchLru(cache, key, { title, fetchedAt: now });
    return { title, repo, cached: false, definitive: true, resolvedAt: new Date(now).toISOString() };
  } catch (error) {
    // AbortSignal.timeout() rejects the fetch with a "TimeoutError"
    // DOMException (Node/Bun's undici-based fetch); some runtimes surface a
    // generic "AbortError" instead — treat either as a transient timeout,
    // never cached, so the next hover gets a fresh attempt.
    const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      title: null,
      repo,
      reason: isTimeout ? "timeout" : error instanceof Error ? error.message : "fetch-failed",
      cached: false,
      definitive: false,
      resolvedAt: new Date(now).toISOString(),
    };
  }
}
