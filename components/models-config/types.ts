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
  modelOverrides?: Record<string, unknown>;
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
  modelCount: number;
  /** Provider also supports OAuth, so it appears in both picker sections. */
  supportsOAuth?: boolean;
}

/** Which configuration layer a provider row comes from. */
export type ProviderSource = "oauth" | "api_key" | "config";

export type ModelHealthState = "ok" | "disabled" | "unverified";

export interface ModelHealth {
  state: ModelHealthState;
  cause?: string;
}

/** Keyed by `provider/modelId`. */
export type ModelHealthMap = Record<string, ModelHealth>;

export interface ProviderHealth {
  state: "ok" | "disabled" | "missing" | "expiring";
  cause?: string;
  expiresAt?: number;
  account?: string;
}

export interface ModelsHealthResponse {
  scannedAt: number;
  providers: Record<string, ProviderHealth>;
  availableModelCount: number;
  disabledModelCount: number;
}

/** One selectable model, as the roles/allow-list pickers consume them. */
export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  input?: string[];
  contextWindow?: number;
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