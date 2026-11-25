/**
 * Provider status poller + snapshot store (issue #134).
 *
 * One process-wide poller (globalThis-guarded, like lib/omp-runtime) keeps
 * OAuth credentials alive and publishes a secret-free quota snapshot for
 * `GET /api/provider-status`. Each cycle:
 *
 * - `authStorage.usage.reports()` for every provider with an SDK usage probe.
 *   The SDK refreshes OAuth tokens ≤60s before expiry and persists the rotated
 *   token (pi-ai/src/auth/usage.ts `#fetchUsageUncached`) — that IS the
 *   keepalive; no new token logic lives here. Its per-credential cache
 *   (5min TTL ±25% jitter + failure backoff) bounds upstream cost regardless
 *   of our poll rate.
 * - OpenRouter REST aggregation: quota is ACCOUNT-scoped, so sibling keys of
 *   one account share a single free-tier counter. Keys are grouped by account
 *   (heuristic: equal `GET /api/v1/credits` total_credits + total_usage),
 *   counted once per account, then summed across distinct accounts.
 * - Presence-only entries for configured providers without a usage probe
 *   (zhipu-coding-plan, alibaba-coding-plan, …): green dot = credential rows
 *   exist. ZERO upstream requests for these.
 *
 * Cycle spacing: base 30min + uniform random 0–300s, recomputed EVERY cycle
 * (owner decision). `OMP_WEB_PROVIDER_POLL_MS` overrides the base for tests.
 * The poller never journals and never starts session hosts.
 */

import type { UsageLimit, UsageReport, UsageStatus, UsageUnit } from "@oh-my-pi/pi-ai";
import { resolveUsedFraction } from "@oh-my-pi/pi-ai";
import { usageStatus } from "@oh-my-pi/pi-ai/usage/shared";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { getOmpRuntime } from "./omp-runtime";

// ── Snapshot wire types (secret-free; shared with the strip component) ──────

export type ProviderStatusKind = "oauth-usage" | "openrouter" | "presence";
export type ProviderStatusState = "ok" | "warning" | "exhausted" | "error" | "absent";

export interface ProviderStatusWindow {
  id: string;
  label: string;
  unit: UsageUnit;
  used?: number;
  limit?: number;
  /** 0..100, derived server-side; >100 means overage. */
  usedPercent?: number;
  resetsAt?: number;
  status: UsageStatus;
  /** SDK window id when the report carried one ("5h", "7d", …); names a window compactly. */
  windowId?: string;
}

/** One OpenRouter key's own view of its account counter (labels only). */
export interface OpenRouterKeyInfo {
  label?: string;
  isFreeTier?: boolean;
  used?: number;
  limit?: number;
  error?: string;
}

export interface ProviderStatusEntry {
  id: string;
  displayName: string;
  kind: ProviderStatusKind;
  status: ProviderStatusState;
  windows: ProviderStatusWindow[];
  /** Stored credential row count (rows only — never key material). */
  keyCount?: number;
  error?: string;
  /** OpenRouter only: distinct accounts after dedup + per-key breakdown. */
  accountCount?: number;
  keys?: OpenRouterKeyInfo[];
  /**
   * Epoch ms the numbers in `windows` were measured (issue #145). The SDK
   * keeps serving a cached / last-good report after an upstream failure, so
   * this can be far older than the cycle's `fetchedAt`; absent when the entry
   * was computed in the cycle itself (presence, OpenRouter REST).
   */
  recordedAt?: number;
  /**
   * Epoch ms of the provider's newest successful usage probe — the keepalive
   * that rotates an OAuth token when due (see `keepaliveTime`). The OAuth card
   * reports it as the credential's last refresh; absent without a report.
   */
  refreshedAt?: number;
}

export interface ProviderStatusSnapshot {
  /** Last completed cycle, epoch ms; null before the first one lands. */
  fetchedAt: number | null;
  /** When the next cycle is scheduled, epoch ms. */
  nextPollAt: number | null;
  providers: ProviderStatusEntry[];
}

// ── Poll cycle ───────────────────────────────────────────────────────────────

export const PROVIDER_POLL_BASE_MS = 30 * 60 * 1000;
export const PROVIDER_POLL_JITTER_MS = 300 * 1000;
const OPENROUTER_REQUEST_TIMEOUT_MS = 10_000;
/** Cap on upstream error text kept in the snapshot (never echoes request headers). */
const MAX_ERROR_TEXT = 300;

export interface ProviderStatusDeps {
  /** All providers' SDK usage reports (keepalive happens inside the SDK). */
  fetchReports: () => Promise<UsageReport[] | null>;
  /** Stored credential rows per provider id (live pool only). */
  listCredentials: (provider: string) => Array<{ type: "api_key" | "oauth"; key?: string }>;
  /** Providers with a stored row or another concrete key source. */
  configuredProviders: () => string[];
  /** Usage-capable check (SDK registry); presence-only otherwise. */
  hasUsageProvider: (provider: string) => boolean;
  displayName: (provider: string) => string;
  fetchImpl?: typeof fetch;
}

/** Base + uniform [0, PROVIDER_POLL_JITTER_MS); recomputed every cycle. */
export function nextCycleDelayMs(random: () => number = Math.random) {
  const raw = Number(process.env.OMP_WEB_PROVIDER_POLL_MS);
  const base = Number.isFinite(raw) && raw > 0 ? raw : PROVIDER_POLL_BASE_MS;
  return base + Math.floor(random() * PROVIDER_POLL_JITTER_MS);
}

function clampErrorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/** Map one SDK limit to the wire window (numbers only — no scope identity). */
export function toStatusWindow(limit: UsageLimit) {
  const fraction = resolveUsedFraction(limit);
  const amount = limit.amount;
  return {
    id: limit.id,
    label: limit.label,
    unit: amount.unit,
    ...(amount.used !== undefined ? { used: amount.used } : {}),
    ...(amount.limit !== undefined ? { limit: amount.limit } : {}),
    ...(fraction !== undefined ? { usedPercent: Math.round(fraction * 1000) / 10 } : {}),
    ...(limit.window?.resetsAt !== undefined ? { resetsAt: limit.window.resetsAt } : {}),
    ...(limit.window?.id !== undefined ? { windowId: limit.window.id } : {}),
    status: limit.status ?? usageStatus(fraction),
  };
}

/**
 * Oldest `fetchedAt` among the reports that contributed limits: the merged
 * windows are never fresher than this, so it is the honest "as of" time.
 */
function dataTime(reports: UsageReport[]): number | undefined {
  let oldest: number | undefined;
  for (const report of reports) {
    if (report.limits.length === 0 || !Number.isFinite(report.fetchedAt) || report.fetchedAt <= 0) continue;
    if (oldest === undefined || report.fetchedAt < oldest) oldest = report.fetchedAt;
  }
  return oldest;
}

/**
 * Newest `fetchedAt` across all of a provider's reports: the last successful
 * keepalive probe. The SDK's usage fetch is what rotates an OAuth token when
 * it is due, and it keeps replaying an older report after an upstream failure,
 * so this time stops advancing exactly when the credential stops being
 * refreshed. The OAuth card shows it as the credential's last refresh.
 */
function keepaliveTime(reports: UsageReport[]): number | undefined {
  let newest: number | undefined;
  for (const report of reports) {
    if (!Number.isFinite(report.fetchedAt) || report.fetchedAt <= 0) continue;
    if (newest === undefined || report.fetchedAt > newest) newest = report.fetchedAt;
  }
  return newest;
}

const STATUS_RANK: Record<UsageStatus, number> = { unknown: 0, ok: 1, warning: 2, exhausted: 3 };

/** Worst window status wins; no windows → unknown maps to ok (nothing to warn about). */
function rollupStatus(windows: ProviderStatusWindow[]) {
  let worst: UsageStatus = "unknown";
  for (const window of windows) {
    if (STATUS_RANK[window.status] > STATUS_RANK[worst]) worst = window.status;
  }
  return worst === "unknown" ? "ok" : worst;
}

function dedupeWindows(limits: UsageLimit[]) {
  const seen = new Set<string>();
  const windows: ProviderStatusWindow[] = [];
  for (const limit of limits) {
    if (seen.has(limit.id)) continue;
    seen.add(limit.id);
    windows.push(toStatusWindow(limit));
  }
  return windows;
}

// ── OpenRouter REST aggregation ─────────────────────────────────────────────

interface OpenRouterKeyData {
  label?: string;
  isFreeTier?: boolean;
  used?: number;
  limit?: number;
}

interface OpenRouterAccountData {
  totalCredits?: number;
  totalUsage?: number;
}

async function fetchOpenRouterJson(
  url: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(OPENROUTER_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  if (typeof body?.data !== "object" || body.data === null) throw new Error("malformed response");
  return body.data as Record<string, unknown>;
}

/** Wire-number guard: OpenRouter counters arrive as JSON numbers, but a null
 *  or string must never become NaN in the snapshot. */
function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Probe every stored OpenRouter key, dedup by account, sum across accounts.
 *
 * Account identity heuristic (documented per issue #134): OpenRouter exposes
 * no account id on the key endpoint, but `GET /api/v1/credits` totals are
 * account-scoped — two keys reporting identical (total_credits, total_usage)
 * are treated as one account. Keys whose credits probe fails cannot be
 * matched and count as their own account (conservative: never under-reports
 * distinct accounts, may over-count a transient failure).
 */
export async function fetchOpenRouterStatus(keys: string[], fetchImpl: typeof fetch = fetch) {
  const entry: ProviderStatusEntry = {
    id: "openrouter",
    displayName: "OpenRouter",
    kind: "openrouter",
    status: "absent",
    windows: [],
    keyCount: keys.length,
    keys: [],
  };
  if (keys.length === 0) return entry;

  const probed: Array<{ key: OpenRouterKeyInfo; account?: OpenRouterAccountData; quota?: OpenRouterKeyData }> = [];
  for (const key of keys) {
    const info: OpenRouterKeyInfo = {};
    let account: OpenRouterAccountData | undefined;
    let quota: OpenRouterKeyData | undefined;
    try {
      const data = await fetchOpenRouterJson("https://openrouter.ai/api/v1/key", key, fetchImpl);
      if (typeof data.label === "string" && data.label) info.label = data.label;
      if (typeof data.is_free_tier === "boolean") info.isFreeTier = data.is_free_tier;
      const daily = data.free_model_daily_requests;
      if (typeof daily === "object" && daily !== null) {
        const record = daily as Record<string, unknown>;
        quota = {
          used: finiteNumber(record.used),
          limit: finiteNumber(record.limit),
        };
        info.used = quota.used;
        info.limit = quota.limit;
      }
    } catch (error) {
      info.error = clampErrorText(error);
    }
    try {
      const data = await fetchOpenRouterJson("https://openrouter.ai/api/v1/credits", key, fetchImpl);
      account = { totalCredits: finiteNumber(data.total_credits), totalUsage: finiteNumber(data.total_usage) };
    } catch {
      // Identity probe failed: this key stays its own account (see heuristic above).
    }
    probed.push({ key: info, account, quota });
    entry.keys!.push(info);
  }

  // Group by account identity; keys without a credits answer never merge.
  const accounts = new Map<string, { used: number; limit: number; hasQuota: boolean }>();
  let unmatched = 0;
  for (const item of probed) {
    const identity = item.account
      && item.account.totalCredits !== undefined
      && item.account.totalUsage !== undefined
      ? `${item.account.totalCredits}:${item.account.totalUsage}`
      : `__unmatched_${unmatched++}`;
    const bucket = accounts.get(identity) ?? { used: 0, limit: 0, hasQuota: false };
    if (item.quota?.used !== undefined && item.quota.limit !== undefined) {
      // One counter per account: sibling keys report the same numbers, so
      // taking the max (not summing) keeps a single account counted once.
      bucket.used = Math.max(bucket.used, item.quota.used);
      bucket.limit = Math.max(bucket.limit, item.quota.limit);
      bucket.hasQuota = true;
    }
    accounts.set(identity, bucket);
  }

  entry.accountCount = accounts.size;
  let used = 0;
  let limit = 0;
  let hasQuota = false;
  for (const bucket of accounts.values()) {
    if (!bucket.hasQuota) continue;
    used += bucket.used;
    limit += bucket.limit;
    hasQuota = true;
  }
  if (hasQuota) {
    const fraction = limit > 0 ? used / limit : undefined;
    const status = usageStatus(fraction);
    entry.windows = [{
      id: "openrouter:free-daily",
      label: "Free models · daily requests",
      unit: "requests",
      used,
      limit,
      ...(fraction !== undefined ? { usedPercent: Math.round(fraction * 1000) / 10 } : {}),
      status,
    }];
    entry.status = status === "unknown" ? "ok" : status;
  } else {
    entry.status = "error";
    entry.error = probed.find((item) => item.key.error)?.key.error ?? "no quota data";
  }
  return entry;
}

// ── Snapshot assembly ────────────────────────────────────────────────────────

/** Friendlier names, mirroring lib/provider-listing.ts's OAuth display names. */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  "openai-codex": "OpenAI",
  "zhipu-coding-plan": "Zhipu",
  "alibaba-coding-plan": "Bailian",
  "alibaba-token-plan": "Bailian Token Plan",
  "github-copilot": "GitHub Copilot",
};

export function providerDisplayName(provider: string) {
  const override = DISPLAY_NAME_OVERRIDES[provider];
  if (override) return override;
  for (const oauth of getOAuthProviders()) {
    if ((oauth.storeCredentialsAs ?? oauth.id) === provider) return oauth.name;
  }
  return provider;
}

/** Pure cycle body: reports + OpenRouter + presence rows → provider entries. */
export async function collectProviderStatus(deps: ProviderStatusDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const entries = new Map<string, ProviderStatusEntry>();

  let reports: UsageReport[] | null = null;
  let reportsError: string | undefined;
  try {
    reports = await deps.fetchReports();
  } catch (error) {
    reportsError = clampErrorText(error);
  }

  const byProvider = new Map<string, UsageReport[]>();
  for (const report of reports ?? []) {
    const list = byProvider.get(report.provider) ?? [];
    list.push(report);
    byProvider.set(report.provider, list);
  }

  const configured = deps.configuredProviders();
  for (const provider of configured) {
    if (provider === "openrouter") continue; // aggregated separately below
    const rows = deps.listCredentials(provider);
    const providerReports = byProvider.get(provider) ?? [];
    const hasUsage = deps.hasUsageProvider(provider);

    if (providerReports.length === 0 && (!hasUsage || rows.length === 0)) {
      // Presence-only: a configured provider with no probe answer and either
      // no usage provider at all, or no stored credential row (env/.env keys —
      // usage probes like alibaba-token-plan need a stored cookie credential,
      // an env API key can never yield windows). Green, zero extra requests.
      entries.set(provider, {
        id: provider,
        displayName: deps.displayName(provider),
        kind: "presence",
        status: "ok",
        windows: [],
        keyCount: rows.length,
      });
      continue;
    }

    const windows = dedupeWindows(providerReports.flatMap((report) => report.limits));
    // "oauth-usage" = OAuth rows with real numbers; key-backed usage probes
    // (zai, alibaba-token-plan, …) render as presence-style rows with windows.
    const kind: ProviderStatusKind =
      hasUsage && windows.length > 0 && rows.some((row) => row.type === "oauth") ? "oauth-usage" : "presence";
    let status: ProviderStatusState;
    let error: string | undefined;
    if (windows.length > 0) {
      status = rollupStatus(windows);
    } else if (reportsError) {
      status = "error";
      error = reportsError;
    } else {
      // Usage-capable provider, configured, but the probe answered nothing
      // (endpoint failure / unsupported credential shape).
      status = "error";
      error = "no usage data";
    }
    const recordedAt = dataTime(providerReports);
    const refreshedAt = keepaliveTime(providerReports);
    entries.set(provider, {
      id: provider,
      displayName: deps.displayName(provider),
      kind,
      status,
      windows,
      keyCount: rows.length,
      ...(recordedAt !== undefined ? { recordedAt } : {}),
      ...(refreshedAt !== undefined ? { refreshedAt } : {}),
      ...(error ? { error } : {}),
    });
  }

  // Providers that produced reports without a configured-listing entry
  // (e.g. env-only keys) still deserve a row.
  for (const [provider, providerReports] of byProvider) {
    if (entries.has(provider) || provider === "openrouter") continue;
    const windows = dedupeWindows(providerReports.flatMap((report) => report.limits));
    const recordedAt = dataTime(providerReports);
    const refreshedAt = keepaliveTime(providerReports);
    entries.set(provider, {
      id: provider,
      displayName: deps.displayName(provider),
      kind: "oauth-usage",
      status: windows.length > 0 ? rollupStatus(windows) : "error",
      windows,
      ...(recordedAt !== undefined ? { recordedAt } : {}),
      ...(refreshedAt !== undefined ? { refreshedAt } : {}),
      ...(windows.length === 0 ? { error: "no usage data" } : {}),
    });
  }

  const openrouterKeys = deps
    .listCredentials("openrouter")
    .filter((row) => row.type === "api_key" && row.key)
    .map((row) => row.key!);
  if (openrouterKeys.length > 0 || configured.includes("openrouter")) {
    entries.set("openrouter", await fetchOpenRouterStatus(openrouterKeys, fetchImpl));
  }

  // Stable, human-friendly order: headline providers first, then the rest.
  const HEADLINE = ["anthropic", "openai-codex", "openrouter", "zhipu-coding-plan", "alibaba-coding-plan"];
  return [...entries.values()].sort((a, b) => {
    const ia = HEADLINE.indexOf(a.id);
    const ib = HEADLINE.indexOf(b.id);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? HEADLINE.length : ia) - (ib === -1 ? HEADLINE.length : ib);
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Stamp a live credential's "last refresh" (issue #145) onto a health scan's
 * provider rows. The scan never probes upstream, so it cannot know when a
 * credential was last refreshed; this poller can — its usage probe is the
 * keepalive that rotates an OAuth token when due. A disabled credential
 * already carries the time its refresh failed, straight from the scan, and a
 * row without a successful probe gets nothing rather than an invented time.
 */
export function stampKeepaliveTime<T extends { state: string; lastRefreshAt?: number }>(
  providers: Record<string, T>,
  keepalive: ReadonlyMap<string, number | undefined>,
): Record<string, T> {
  const stamped: Record<string, T> = {};
  for (const [id, entry] of Object.entries(providers)) {
    const touched = keepalive.get(id);
    stamped[id] = entry.lastRefreshAt === undefined && touched !== undefined && (entry.state === "ok" || entry.state === "expiring")
      ? { ...entry, lastRefreshAt: touched }
      : entry;
  }
  return stamped;
}

// ── Process-wide poller singleton ────────────────────────────────────────────

interface PollerState {
  snapshot: ProviderStatusSnapshot;
  timer: NodeJS.Timeout | undefined;
  cycle: Promise<void> | null;
  started: boolean;
}

declare global {
  var __ompProviderStatusPoller: PollerState | undefined;
}

function pollerState(): PollerState {
  globalThis.__ompProviderStatusPoller ??= {
    snapshot: { fetchedAt: null, nextPollAt: null, providers: [] },
    timer: undefined,
    cycle: null,
    started: false,
  };
  return globalThis.__ompProviderStatusPoller;
}

async function runtimeDeps(): Promise<ProviderStatusDeps> {
  const { authStorage, modelRegistry } = await getOmpRuntime();
  return {
    fetchReports: async () => {
      // The usage path reads the in-process pool without adopting external
      // commits (only OAuth selection / markUsageLimitReached poll). A web
      // tier that never runs turns would otherwise keep alive a boot-time
      // snapshot forever: tokens rotated by hosts/CLI stay invisible, and a
      // row edited or re-logged-in elsewhere never reaches the probe. Re-list
      // stored rows once per cycle (a few ms on this fleet's credential count).
      await authStorage.credentials.reload();
      return authStorage.usage.reports({
        baseUrlResolver: (provider) => modelRegistry.getProviderBaseUrl(provider),
      });
    },
    listCredentials: (provider) =>
      authStorage.credentials.list(provider).map((row) => ({
        type: row.credential.type,
        ...(row.credential.type === "api_key" ? { key: row.credential.key } : {}),
      })),
    configuredProviders: () => {
      // Stored rows plus any provider with a concrete key source (env/.env,
      // models.yml) — the fleet keeps most plain keys in ~/.omp/agent/.env,
      // and those deserve presence dots too. Candidate ids come from the
      // catalog descriptors + OAuth registry + stored rows; keys.source()
      // decides concreteness, never key material.
      const ids = new Set<string>(Object.keys(authStorage.credentials.all()));
      for (const descriptor of PROVIDER_DESCRIPTORS) ids.add(descriptor.providerId);
      for (const oauth of getOAuthProviders()) ids.add(oauth.storeCredentialsAs ?? oauth.id);
      return [...ids].filter((provider) => authStorage.keys.source(provider)?.concrete);
    },
    hasUsageProvider: (provider) => authStorage.usage.providerFor(provider) !== undefined,
    displayName: providerDisplayName,
  };
}

async function runCycle() {
  const state = pollerState();
  const now = Date.now();
  console.info("[provider-status] cycle start");
  try {
    const deps = await runtimeDeps();
    const providers = await collectProviderStatus(deps);
    state.snapshot = { fetchedAt: Date.now(), nextPollAt: state.snapshot.nextPollAt, providers };
  } catch (error) {
    // Keep the previous snapshot; a failed cycle must not blank the strip.
    console.warn(`[provider-status] cycle failed: ${clampErrorText(error)}`);
  }
  const delay = nextCycleDelayMs();
  state.snapshot = { ...state.snapshot, nextPollAt: Date.now() + delay };
  console.info(`[provider-status] cycle done in ${Date.now() - now}ms; next in ${Math.round(delay / 1000)}s`);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    state.cycle = runCycle().finally(() => {
      state.cycle = null;
    });
  }, delay);
  state.timer.unref?.();
}

/**
 * Start the poller once per process and return the current snapshot.
 * The first cycle runs immediately; later GETs read the cached snapshot.
 */
export function ensureProviderStatusPoller(): ProviderStatusSnapshot {
  const state = pollerState();
  if (!state.started) {
    state.started = true;
    state.cycle = runCycle().finally(() => {
      state.cycle = null;
    });
  }
  return state.snapshot;
}

/** Current snapshot without starting anything (tests / introspection). */
export function getProviderStatusSnapshot() {
  return pollerState().snapshot;
}

/** Stop the poller and reset state (tests only). */
export function resetProviderStatusPoller(): void {
  clearTimeout(globalThis.__ompProviderStatusPoller?.timer);
  globalThis.__ompProviderStatusPoller = undefined;
}

// Server boot: start lazily-but-eagerly so keepalive runs even before the
// first browser asks. Client bundles never evaluate this (typeof window).
if (typeof window === "undefined" && process.env.OMP_WEB_PROVIDER_POLL_DISABLE !== "1") {
  ensureProviderStatusPoller();
}
