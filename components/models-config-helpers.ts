import type { ProviderModelDiff } from "@/lib/models-config-diff";

import { apiPath } from "@/lib/api-path";

export interface CompatEntry {
  compat?: Record<string, unknown>;
}

export interface HeaderRow {
  id: number;
  name: string;
  value: string;
}

export function setCompatBool<T extends CompatEntry>(entry: T, key: string, value: boolean): T {
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), [key]: value },
  };
}

export function updateHeaderRow(
  rows: readonly HeaderRow[],
  id: number,
  changes: Partial<Pick<HeaderRow, "name" | "value">>,
): HeaderRow[] {
  return rows.map((row) => row.id === id ? { ...row, ...changes } : row);
}

export function serializeHeaderRows(rows: readonly HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return Object.keys(headers).length ? headers : undefined;
}

export async function refreshProviderModels(
  providerName: string,
  onModelsChanged?: () => void,
  fetchImpl: typeof fetch = fetch,
): Promise<{ discoveryStatus?: string; warning?: string; diff?: ProviderModelDiff }> {
  try {
    const response = await fetchImpl(apiPath("/api/models-config/refresh-provider"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerName }),
    });
    const result = await response.json().catch(() => null) as {
      success?: boolean;
      discoveryStatus?: string;
      warning?: string;
      diff?: ProviderModelDiff;
      error?: string;
    } | null;
    if (!response.ok || !result?.success) {
      throw new Error(result?.error || `HTTP ${response.status}`);
    }
    return result;
  } finally {
    // A failed or interrupted request may have changed the server registry.
    onModelsChanged?.();
  }
}

// ── OAuth login state (issue #90) ────────────────────────────────────────────
// The paste input must survive SDK progress messages and rejected pastes, so
// the SSE event handling lives in a pure reducer instead of inline setState
// calls that used to overwrite the auth phase with a bare progress phase.

export type OAuthLoginRequest =
  | { phase: "auth"; url: string; instructions: string | null; token: string; progress?: string | null; error?: string | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string; progress?: string | null; error?: string | null };

export type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | OAuthLoginRequest
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string; verifying?: boolean; error?: string | null }
  | { phase: "progress"; message: string | null; request?: OAuthLoginRequest }
  | { phase: "success" }
  | { phase: "error"; message: string };

export interface OAuthLoginEvent {
  type: string;
  url?: string;
  instructions?: string | null;
  token?: string;
  message?: string;
  placeholder?: string | null;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number | null;
  expiresInSeconds?: number | null;
  options?: { id: string; label: string }[];
}

/**
 * Apply one SSE event from /api/auth/login/:provider. Progress never replaces
 * an active auth/prompt request: it is shown alongside the persistent input.
 */
export function reduceOAuthLoginEvent(state: OAuthLoginState, event: OAuthLoginEvent): OAuthLoginState {
  switch (event.type) {
    case "auth":
      return { phase: "auth", url: event.url!, instructions: event.instructions ?? null, token: event.token!, error: null };
    case "device_code":
      return {
        phase: "device_code",
        userCode: event.userCode!,
        verificationUri: event.verificationUri!,
        intervalSeconds: event.intervalSeconds ?? null,
        expiresInSeconds: event.expiresInSeconds ?? null,
      };
    case "prompt_request":
      return { phase: "prompt", message: event.message!, placeholder: event.placeholder ?? null, token: event.token!, error: null };
    case "select_request":
      return { phase: "select", message: event.message!, options: event.options ?? [], token: event.token! };
    case "input_rejected": {
      // The SDK dropped a paste and re-armed manual input. The route sends a
      // fresh token; without one, keep the current request alive.
      const message = event.message ?? null;
      if (event.token) return { phase: "prompt", message: "", placeholder: null, token: event.token, error: message };
      if (state.phase === "progress" && state.request) return { ...state.request, error: message };
      if (state.phase === "auth" || state.phase === "prompt") return { ...state, error: message };
      return state;
    }
    case "progress": {
      // Terminal outcomes are final; a late progress event must not resurrect
      // the flow (the component also closes the stream on success/error).
      if (state.phase === "success" || state.phase === "error") return state;
      const message = event.message ?? null;
      if (state.phase === "auth" || state.phase === "prompt") return { ...state, progress: message, error: null };
      if (state.phase === "progress") return { ...state, message };
      if (state.phase === "select") return { ...state, error: null };
      return { phase: "progress", message };
    }
    case "success":
      return { phase: "success" };
    case "error":
      return { phase: "error", message: event.message ?? "" };
    case "cancelled":
      return { phase: "idle" };
    default:
      return state;
  }
}

/** The request whose token a paste should be posted with, if any. */
export function oauthInputRequest(state: OAuthLoginState): OAuthLoginRequest | null {
  if (state.phase === "auth" || state.phase === "prompt") return state;
  if (state.phase === "progress" && state.request) return state.request;
  return null;
}

/**
 * Enter the verifying state for a paste while keeping the request (and its
 * token) so a rejection can restore the input instead of stranding the UI.
 * Returns null when no submission is possible (e.g. already verifying).
 */
export function beginOAuthVerification(state: OAuthLoginState): OAuthLoginState | null {
  if (state.phase === "auth" || state.phase === "prompt") {
    return { phase: "progress", message: null, request: { ...state, error: null } };
  }
  if (state.phase === "select") return { ...state, verifying: true };
  return null;
}

/**
 * Report a failed paste/selection. Restores the kept request with an inline
 * error so the same token can be retried; terminal outcomes are never undone.
 */
export function failOAuthVerification(state: OAuthLoginState, message: string): OAuthLoginState {
  if (state.phase === "progress") {
    return state.request ? { ...state.request, error: message } : { phase: "error", message };
  }
  if (state.phase === "auth" || state.phase === "prompt") return { ...state, error: message };
  if (state.phase === "select") return { ...state, verifying: false, error: message };
  return state;
}

/** Clear a stale inline error when the user edits the paste input. */
export function clearOAuthLoginError(state: OAuthLoginState): OAuthLoginState {
  if ((state.phase === "auth" || state.phase === "prompt") && state.error) return { ...state, error: null };
  if (state.phase === "progress" && state.request?.error) {
    return { ...state, request: { ...state.request, error: null } };
  }
  return state;
}

/** Stable POST /api/auth/login/:provider error codes → i18n keys (issue #90);
 * unknown codes fall back to the server's English text. */
export const OAUTH_POST_ERROR_KEYS: Record<string, string> = {
  missing_fields: "models.oauthErrorMissingFields",
  invalid_json: "models.oauthErrorInvalidJson",
  invalid_input: "models.oauthErrorInvalidInput",
  missing_code: "models.oauthErrorMissingCode",
  state_mismatch: "models.oauthErrorStateMismatch",
  unknown_token: "models.oauthErrorUnknownToken",
  token_provider_mismatch: "models.oauthErrorTokenProviderMismatch",
};

// Fixed server/SDK strings that have a localized equivalent; anything else is
// shown verbatim so provider-specific messages are not lost.
export const OAUTH_SERVER_MESSAGE_KEYS: Record<string, string> = {
  "Waiting for browser authentication...": "models.oauthWaitingBrowser",
  "Waiting for pasted authorization code...": "models.oauthWaitingPaste",
  "Exchanging authorization code for tokens...": "models.oauthExchanging",
  "The pasted input was rejected (no authorization code, or state mismatch). Paste the redirect URL or code again.": "models.oauthInputRejected",
};
