import type { ModelCatalogFields } from "@/lib/models-cache";
import type { ProviderModelDiff } from "@/lib/models-config-diff";

/**
 * Shared shapes for the model-configuration panel.
 *
 * The health types mirror `lib/models-health.ts` (owned by the background
 * scanner); they are declared here so the panel compiles and degrades to "no
 * health strip" while that endpoint is absent, instead of inventing a second
 * set of types at each call site.
 */

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  /**
   * Sparse per-model patches over catalog rows, keyed by model id. A field
   * that is present overrides the catalog value; an absent one inherits it,
   * which is what makes an override follow later catalog updates (#144).
   */
  modelOverrides?: Record<string, ModelOverridePatch>;
}

/**
 * The fields this panel writes into `modelOverrides`, plus whatever a
 * hand-edited `models.yml` carries (headers, compat, promptCache, …).
 */
export interface ModelOverridePatch {
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  [field: string]: unknown;
}

export interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

export interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
  /** Provider also accepts an API key, so it appears in both picker sections. */
  supportsApiKey?: boolean;
  /** A credential of this provider was disabled and never replaced: the card is where the login is redone. */
  hasCredentialHistory?: boolean;
}

export interface ApiKeyProvider {
  id: string;
  /** Catalog base URL, when the provider is a built-in catalog entry. */
  baseUrl?: string;
  /** Catalog API kind, e.g. `openai-completions`. */
  api?: string;
  /** Env var the catalog expects the key in, e.g. `ZHIPU_API_KEY`. */
  envVar?: string;
  displayName: string;
  configured: boolean;
  source?: string;
  /** The environment variable backing an env-sourced key, when a single named one does. */
  sourceEnvVar?: string;
  modelCount: number;
  /** Provider also supports OAuth, so it appears in both picker sections. */
  supportsOAuth?: boolean;
}

/** Which configuration layer a provider row comes from. */
export type ProviderSource = "oauth" | "api_key" | "config";

export type ModelHealthState = "ok" | "disabled" | "unverified";

export type ProviderHealthState = "ok" | "disabled" | "missing" | "expiring";

export interface ModelHealth {
  state: ModelHealthState;
  cause?: string;
}

/** Keyed by `provider/modelId`. */
export type ModelHealthMap = Record<string, ModelHealth>;

export interface ProviderHealth {
  state: ProviderHealthState;
  cause?: string;
  expiresAt?: number;
  account?: string;
  /** Epoch ms of the credential's last refresh: the failed refresh that disabled it, or the last successful keepalive probe while alive. */
  lastRefreshAt?: number;
}

export interface ModelsHealthResponse {
  scannedAt: number;
  providers: Record<string, ProviderHealth>;
  availableModelCount: number;
  disabledModelCount: number;
}

/** One selectable model, as the roles/allow-list pickers consume them. */
export interface ModelOption extends ModelCatalogFields {
  id: string;
  name: string;
  provider: string;
}

/** One provider's refresh, as the panel tracks it. */
export type ProviderRefreshState =
  | { phase: "idle" }
  | { phase: "loading"; providerName: string }
  | { phase: "success"; providerName: string; warning?: string; diff?: ProviderModelDiff; /** Epoch ms the refresh finished; stamps the diff header. */ completedAt?: number }
  | { phase: "error"; providerName: string; message: string };

export function modelHealthKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** `provider/modelId` for a role or fallback selector, without a `:level` suffix. */
export function modelSelector(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}