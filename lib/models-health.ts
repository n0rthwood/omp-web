/**
 * Model catalog freshness + credential health scan (issue #139).
 *
 * Two problems this module solves:
 *
 * 1. Freshness — `/api/models` used to read a boot-time snapshot: the
 *    credential pool only reloaded on this process's own writes, and the
 *    registry only rebuilt when a web route happened to call `refresh`. A
 *    `omp auth` login/logout in another terminal, or a hand-edited
 *    `models.yml`, stayed invisible until the web tier restarted.
 *    {@link refreshModelsFreshness} is the one call the models route makes
 *    before reading: `credentials.reload()` (incremental — one
 *    `PRAGMA data_version` read, no re-list when nothing committed) plus
 *    `ModelRegistry.refreshIfStale()` (rebuilds only when `models.yml`'s
 *    mtime moved).
 *
 * 2. Health — a process-wide poller (globalThis-guarded, like
 *    lib/provider-status) re-reads stored credentials on a timer and
 *    publishes a secret-free snapshot: per-provider state
 *    (ok/disabled/missing/expiring) and per-model state
 *    (ok/disabled/unverified). When the provider signature changes the
 *    models cache is invalidated, so the next `/api/models` request reflects
 *    the external change without a restart.
 *
 * The scan never probes upstream: "disabled" comes from SQLite tombstones
 * (`disabled_cause`), "expiring" from the stored OAuth `expires` field of a
 * grant the SDK cannot renew by itself.
 * No credential material leaves this module — only provider ids, states,
 * causes and account labels.
 */

import type { AuthCredential } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { invalidateModelsCache } from "./models-cache";
import { getOmpRuntime } from "./omp-runtime";

// ── Wire types ───────────────────────────────────────────────────────────────

export type ModelHealthState = "ok" | "disabled" | "unverified";

/** Per-model health, keyed `provider/modelId` in {@link ModelsData.modelHealth}. */
export interface ModelHealth {
  state: ModelHealthState;
  cause?: string;
}

export type ProviderHealthState = "ok" | "disabled" | "missing" | "expiring";

/** Per-provider credential state (secret-free). */
export interface ProviderHealth {
  state: ProviderHealthState;
  cause?: string;
  /** Epoch ms the stored OAuth access token expires, when known. */
  expiresAt?: number;
  /** Account label (email or account id) the credential is signed in as. */
  account?: string;
}

export interface ModelsHealthSnapshot {
  scannedAt: number;
  providers: Record<string, ProviderHealth>;
  /** `provider/modelId` → health for every model the registry serves. */
  modelHealth: Record<string, ModelHealth>;
  availableModelCount: number;
  disabledModelCount: number;
}

/** `GET /api/models/health` body. */
export interface ModelsHealthResponse {
  scannedAt: number;
  providers: Record<string, ProviderHealth>;
  availableModelCount: number;
  disabledModelCount: number;
}

// ── Scan policy ──────────────────────────────────────────────────────────────

export const MODELS_HEALTH_SCAN_BASE_MS = 60_000;
/**
 * OAuth grants WITHOUT a refresh token inside this window are reported as
 * `expiring`. A grant that carries one is renewed by the SDK at `expires`, so
 * its access token is always short of a day from expiry — a day-wide window
 * flagged every healthy short-lived login as expiring permanently (#144).
 */
const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Cap on upstream error text kept in a cause (never echoes key material). */
const MAX_CAUSE_TEXT = 300;

/** Base scan interval; `OMP_WEB_MODELS_HEALTH_MS` overrides it (tests). */
export function modelsHealthScanIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMP_WEB_MODELS_HEALTH_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 10) return Math.floor(parsed);
  }
  return MODELS_HEALTH_SCAN_BASE_MS;
}

function clampCauseText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.slice(0, MAX_CAUSE_TEXT);
}

// ── Cycle body (dependency-injected so tests never touch ~/.omp) ─────────────

export interface ModelsHealthRow {
  provider: string;
  credential: AuthCredential;
  disabledCause: string | null;
}

export interface ModelsHealthDisabledRow {
  provider: string;
  cause: string;
  email?: string;
  accountId?: string;
}

export interface ModelsHealthDeps {
  /** Re-list stored credential rows (incremental in the SDK). */
  reloadCredentials(): Promise<void>;
  /** Rebuild the catalog when `models.yml` changed; resolves false when current. */
  refreshRegistry(): Promise<boolean>;
  listCredentials(): ModelsHealthRow[];
  listDisabled(): Promise<ModelsHealthDisabledRow[]>;
  /** A concrete key source (env, models.yml, runtime override) backs the provider. */
  hasConcreteSource(provider: string): boolean;
  /** Configured-but-keyless endpoint (empty paste at an optional-key login). */
  keyless(provider: string): boolean;
  availableModels(): { provider: string; id: string }[];
  /** Candidate provider ids worth reporting (catalog + stored rows). */
  providerIds(): string[];
  invalidateModelsCache(): void;
}

/** Map a provider's credential state onto each of its models' health. */
export function modelHealthForProvider(provider: ProviderHealth | undefined): ModelHealth {
  if (!provider) return { state: "unverified" };
  switch (provider.state) {
    case "ok":
    case "expiring":
      return { state: "ok" };
    case "disabled":
      return { state: "disabled", ...(provider.cause ? { cause: provider.cause } : {}) };
    case "missing":
      // No credential and no key source: the model is listed but cannot run.
      // Report it as unverified rather than red — a keyless endpoint that the
      // catalog has not classified yet lands here too.
      return { state: "unverified", ...(provider.cause ? { cause: provider.cause } : {}) };
  }
}

/**
 * One scan: reload credentials, catch the catalog up, then classify every
 * candidate provider and every available model. Pure with respect to the
 * process-wide poller state — the caller decides what to do with the result.
 */
export async function collectModelsHealth(deps: ModelsHealthDeps): Promise<ModelsHealthSnapshot> {
  await deps.reloadCredentials();
  await deps.refreshRegistry();

  const available = deps.availableModels();
  const rows = deps.listCredentials();
  const disabledRows = await deps.listDisabled();

  const activeByProvider = new Map<string, ModelsHealthRow[]>();
  const disabledByProvider = new Map<string, ModelsHealthDisabledRow[]>();
  // A row that carries `disabled_cause` is a tombstone even when a deps
  // source hands it back inline instead of through `listDisabled()`.
  for (const row of rows) {
    if (row.disabledCause) {
      const tombstone = { provider: row.provider, cause: row.disabledCause };
      const list = disabledByProvider.get(row.provider);
      if (list) list.push(tombstone);
      else disabledByProvider.set(row.provider, [tombstone]);
      continue;
    }
    const list = activeByProvider.get(row.provider);
    if (list) list.push(row);
    else activeByProvider.set(row.provider, [row]);
  }
  for (const row of disabledRows) {
    const list = disabledByProvider.get(row.provider);
    if (list) list.push(row);
    else disabledByProvider.set(row.provider, [row]);
  }

  const ids = new Set<string>(deps.providerIds());
  for (const model of available) ids.add(model.provider);
  for (const provider of activeByProvider.keys()) ids.add(provider);
  for (const provider of disabledByProvider.keys()) ids.add(provider);

  const now = Date.now();
  const providers: Record<string, ProviderHealth> = {};
  for (const provider of [...ids].sort()) {
    const active = activeByProvider.get(provider) ?? [];
    if (active.length > 0) {
      // Soonest unexpired access token across the provider's live OAuth rows:
      // the "valid until" the provider card shows.
      let expiresAt: number | undefined;
      let expiring = false;
      let account: string | undefined;
      for (const row of active) {
        if (row.credential.type !== "oauth") continue;
        account ??= row.credential.email ?? row.credential.accountId;
        const expires = row.credential.expires;
        // An already-expired token is renewed on demand, not a warning.
        if (expires === undefined || expires <= now) continue;
        if (expiresAt === undefined || expires < expiresAt) expiresAt = expires;
        if (row.credential.refresh) continue;
        if (expires - now <= EXPIRING_WINDOW_MS) expiring = true;
      }
      providers[provider] = {
        state: expiring ? "expiring" : "ok",
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(account ? { account } : {}),
      };
      continue;
    }
    const disabled = disabledByProvider.get(provider) ?? [];
    if (disabled.length > 0) {
      const first = disabled[0]!;
      const account = first.email ?? first.accountId;
      providers[provider] = {
        state: "disabled",
        cause: first.cause,
        ...(account ? { account } : {}),
      };
      continue;
    }
    if (deps.keyless(provider) || deps.hasConcreteSource(provider)) {
      providers[provider] = { state: "ok" };
      continue;
    }
    providers[provider] = { state: "missing", cause: "No credentials configured" };
  }

  const modelHealth: Record<string, ModelHealth> = {};
  let disabledModelCount = 0;
  for (const model of available) {
    const health = modelHealthForProvider(providers[model.provider]);
    modelHealth[`${model.provider}/${model.id}`] = health;
    if (health.state === "disabled") disabledModelCount += 1;
  }

  return {
    scannedAt: now,
    providers,
    modelHealth,
    availableModelCount: available.length,
    disabledModelCount,
  };
}

/** Provider-state fingerprint: only real state changes should drop the cache. */
export function modelsHealthSignature(snapshot: ModelsHealthSnapshot): string {
  const providers = Object.entries(snapshot.providers)
    .map(([provider, health]) => `${provider}=${health.state}${health.cause ? `:${health.cause}` : ""}`)
    .sort();
  return `${snapshot.availableModelCount}|${providers.join(",")}`;
}

// ── Runtime deps ─────────────────────────────────────────────────────────────

/**
 * The freshness call the models route makes before reading the catalog.
 * `credentials.reload()` is incremental (a `data_version` read; it re-lists
 * only when another connection committed), and `refreshIfStale()` rebuilds
 * only when `models.yml`'s mtime moved — so a warm request stays cheap.
 * Resolves `true` when the catalog may have changed.
 */
export async function refreshModelsFreshness(
  runtime: { authStorage: { credentials: { reload(): Promise<void> } }; modelRegistry: { refreshIfStale(): Promise<boolean> } }
): Promise<boolean> {
  await runtime.authStorage.credentials.reload();
  return await runtime.modelRegistry.refreshIfStale();
}

async function runtimeDeps(): Promise<ModelsHealthDeps> {
  const { authStorage, modelRegistry } = await getOmpRuntime();
  return {
    reloadCredentials: () => authStorage.credentials.reload(),
    refreshRegistry: async () => {
      try {
        return await modelRegistry.refreshIfStale();
      } catch (error) {
        // A broken models.yml must not blank the model list; the registry
        // keeps its last good catalog and `getError()` reports the problem.
        console.warn(`[models-health] registry refresh failed: ${clampCauseText(error)}`);
        return false;
      }
    },
    listCredentials: () =>
      authStorage.credentials.list().map((row) => ({
        provider: row.provider,
        credential: row.credential,
        disabledCause: row.disabledCause,
      })),
    listDisabled: async () =>
      (await authStorage.credentials.listDisabled()).map((row) => ({
        provider: row.provider,
        cause: row.cause,
        ...(row.email ? { email: row.email } : {}),
        ...(row.accountId ? { accountId: row.accountId } : {}),
      })),
    hasConcreteSource: (provider) => authStorage.keys.source(provider)?.concrete === true,
    keyless: (provider) => authStorage.keys.keyless(provider),
    availableModels: () => modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id })),
    providerIds: () => {
      // Same candidate set as the provider-status strip: stored rows plus
      // every provider the catalog or OAuth registry knows about, so an
      // env-keyed provider with zero stored rows still gets a state.
      const ids = new Set<string>(Object.keys(authStorage.credentials.all()));
      for (const descriptor of PROVIDER_DESCRIPTORS) ids.add(descriptor.providerId);
      for (const oauth of getOAuthProviders()) ids.add(oauth.storeCredentialsAs ?? oauth.id);
      return [...ids];
    },
    invalidateModelsCache,
  };
}

// ── Process-wide poller singleton ────────────────────────────────────────────

interface HealthPollerState {
  snapshot: ModelsHealthSnapshot | null;
  signature: string;
  timer: NodeJS.Timeout | undefined;
  cycle: Promise<void> | null;
  started: boolean;
}

declare global {
  var __ompModelsHealthPoller: HealthPollerState | undefined;
}

function pollerState(): HealthPollerState {
  globalThis.__ompModelsHealthPoller ??= {
    snapshot: null,
    signature: "",
    timer: undefined,
    cycle: null,
    started: false,
  };
  return globalThis.__ompModelsHealthPoller;
}

function scheduleNext(state: HealthPollerState): void {
  const delay = modelsHealthScanIntervalMs();
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void runCycle(state);
  }, delay);
  state.timer.unref?.();
}

function runCycle(state: HealthPollerState): Promise<void> {
  if (state.cycle) return state.cycle;
  const cycle = (async () => {
    try {
      const deps = await runtimeDeps();
      const snapshot = await collectModelsHealth(deps);
      const signature = modelsHealthSignature(snapshot);
      if (signature !== state.signature) {
        state.signature = signature;
        // Provider states moved (external login/logout, disabled credential,
        // models.yml edit): drop the cached model list so the next request
        // re-reads it instead of serving the boot-time snapshot.
        deps.invalidateModelsCache();
      }
      state.snapshot = snapshot;
    } catch (error) {
      // Keep the previous snapshot; a failed scan must not blank the health bar.
      console.warn(`[models-health] scan failed: ${clampCauseText(error)}`);
    } finally {
      scheduleNext(state);
    }
  })();
  state.cycle = cycle;
  void cycle.then(() => {
    if (state.cycle === cycle) state.cycle = null;
  });
  return cycle;
}

/** Start the poller once per process (first cycle runs immediately). */
export function ensureModelsHealthPoller(): void {
  const state = pollerState();
  if (state.started) return;
  state.started = true;
  void runCycle(state);
}

/**
 * Current snapshot, scanning on demand when the poller has not produced one
 * yet (first request after boot). Resolves `null` when the scan failed.
 */
export async function ensureModelsHealthSnapshot(): Promise<ModelsHealthSnapshot | null> {
  const state = pollerState();
  if (state.snapshot) return state.snapshot;
  await runCycle(state);
  return state.snapshot;
}

/** Current snapshot without starting anything (tests / introspection). */
export function getModelsHealthSnapshot(): ModelsHealthSnapshot | null {
  return pollerState().snapshot;
}

/** Stop the poller and reset state (tests only). */
export function resetModelsHealthPoller(): void {
  clearTimeout(globalThis.__ompModelsHealthPoller?.timer);
  globalThis.__ompModelsHealthPoller = undefined;
}

// Server boot: start lazily-but-eagerly so a change is picked up even before
// the first browser asks. Client bundles never evaluate this (typeof window).
if (typeof window === "undefined" && process.env.OMP_WEB_MODELS_HEALTH_DISABLE !== "1") {
  ensureModelsHealthPoller();
}