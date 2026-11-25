"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useI18n } from "@/hooks/useI18n";
import {
  beginOAuthVerification,
  clearOAuthLoginError,
  failOAuthVerification,
  oauthInputRequest,
  OAUTH_POST_ERROR_KEYS,
  OAUTH_SERVER_MESSAGE_KEYS,
  reduceOAuthLoginEvent,
  type OAuthLoginEvent,
  type OAuthLoginState,
} from "../models-config-helpers";
import { HealthBadge } from "./HealthBadge";
import { SectionTitle } from "./ui";
import type { OAuthProvider, ProviderHealth } from "./types";

/**
 * Authentication card for an OAuth (subscription) provider.
 *
 * The flow is the existing one: `GET /api/auth/login/:provider` streams the
 * login URL or device code, the redirect URL pasted back is verified through
 * `POST /api/auth/login/:provider`, and disconnecting is
 * `POST /api/auth/logout/:provider`. The card adds the credential facts the
 * merged provider list needs — account, expiry, and the raw failure cause from
 * the health scan — which the old detail pane only showed as a green dot.
 */
export function OAuthCard({ provider, health, onRefresh }: {
  provider: OAuthProvider;
  health?: ProviderHealth;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The paste input stays mounted for the whole auth→success/error window,
  // including while a paste is being verified (issue #90).
  const inputRequest = oauthInputRequest(loginState);
  const hasInput = inputRequest !== null;
  const verifying = loginState.phase === "progress";

  // Fixed server/SDK strings get a localized equivalent; provider-specific
  // messages are shown verbatim so nothing is lost in translation.
  const localizeServerMessage = (message: string | null | undefined): string | null => {
    if (!message) return null;
    const key = OAUTH_SERVER_MESSAGE_KEYS[message];
    return key ? t(key) : message;
  };

  useEffect(() => {
    if (hasInput) setTimeout(() => inputRef.current?.focus(), 50);
  }, [hasInput]);

  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  const handleLogin = useCallback(() => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const es = new EventSource(apiPath(`/api/auth/login/${encodeURIComponent(provider.id)}`));
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data) as OAuthLoginEvent;
      if (data.type === "auth" && data.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code" && data.verificationUri) {
        window.open(data.verificationUri, "_blank", "noopener,noreferrer");
      } else if (data.type === "success") {
        es.close();
        onRefresh();
      } else if (data.type === "error" || data.type === "cancelled") {
        es.close();
      }
      setLoginState((prev) => reduceOAuthLoginEvent(prev, data));
    };
    es.onerror = () => {
      // Never let EventSource auto-reconnect: a reconnect starts a NEW login
      // attempt with a different state, silently invalidating the paste the
      // user is about to make. Any drop is terminal — close and report it.
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: t("models.oauthConnectionLost") });
    };
  }, [onRefresh, provider.id, t]);

  const handleLogout = useCallback(async () => {
    await fetch(apiPath(`/api/auth/logout/${encodeURIComponent(provider.id)}`), { method: "POST" });
    setLoginState({ phase: "idle" });
    onRefresh();
  }, [onRefresh, provider.id]);

  const submitCode = useCallback(async (token: string, code: string) => {
    if (!code.trim()) return;
    const next = beginOAuthVerification(loginState);
    if (!next) return;
    setLoginState(next);
    try {
      const res = await fetch(apiPath(`/api/auth/login/${encodeURIComponent(provider.id)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        // 4xx rejects the paste WITHOUT consuming the token: restore the
        // input with an inline error so the same token can be retried.
        const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
        const key = data.code ? OAUTH_POST_ERROR_KEYS[data.code] : undefined;
        const message = key ? t(key) : (data.error ?? t("models.oauthServerError", { status: res.status }));
        setLoginState((prev) => failOAuthVerification(prev, message));
        return;
      }
      // 200 only means the paste was accepted for processing; the outcome
      // arrives via SSE success/error. Keep verifying until then.
      setInputValue("");
    } catch {
      setLoginState((prev) => failOAuthVerification(prev, t("i18n.networkError")));
    }
  }, [loginState, provider.id, t]);

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress"
    || loginState.phase === "auth" || loginState.phase === "device_code"
    || loginState.phase === "prompt" || loginState.phase === "select";

  const progressMessage = loginState.phase === "progress" ? loginState.message : (inputRequest?.progress ?? null);
  const showProgress = verifying || Boolean(inputRequest?.progress);
  const expiresAt = health?.expiresAt ? new Date(health.expiresAt).toLocaleString() : null;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <SectionTitle>{t("models.oauthCardTitle")}</SectionTitle>
        <HealthBadge
          health={health}
          label={health ? undefined : provider.loggedIn ? t("i18n.connected") : t("i18n.notConnected")}
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
        <span>{t("models.oauthAccount")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{health?.account ?? "—"}</code></span>
        <span>{t("models.oauthExpires")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{expiresAt ?? "—"}</code></span>
      </div>

      {health?.cause && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--danger, #f85149)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{health.cause}</p>
      )}

      <div style={{ minHeight: 0 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.loggedIn ? t("models.oauthAlreadyConnected") : t("models.oauthConnectAccount", { provider: provider.name })}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.openingBrowser")}</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{loginState.message}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button key={option.id} type="button"
                  onClick={() => void submitCode(loginState.token, option.id)}
                  disabled={loginState.verifying}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: loginState.verifying ? "not-allowed" : "pointer", fontSize: 12, textAlign: "left" }}>
                  {option.label}
                </button>
              ))}
            </div>
            {loginState.verifying && <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.continuing")}</p>}
            {loginState.error && <p role="alert" style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{localizeServerMessage(loginState.error)}</p>}
          </div>
        )}
        {inputRequest && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {inputRequest.phase === "auth" ? t("models.oauthPasteHint") : (inputRequest.message || t("models.oauthPasteHint"))}
            </p>
            {inputRequest.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                {t("models.oauthBrowserNotOpened")}{" "}
                <a href={inputRequest.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                  {t("models.oauthOpenLoginPage")}
                </a>
              </p>
            )}
            {showProgress && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                {localizeServerMessage(progressMessage) ?? t("models.oauthVerifying")}
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(event) => { setInputValue(event.target.value); setLoginState((prev) => clearOAuthLoginError(prev)); }}
                onKeyDown={(event) => { if (event.key === "Enter" && !verifying) void submitCode(inputRequest.token, inputValue); }}
                placeholder={inputRequest.phase === "auth" ? t("models.oauthPastePlaceholder") : (inputRequest.placeholder ?? t("models.oauthEnterValue"))}
                style={{ flex: 1, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button type="button"
                onClick={() => void submitCode(inputRequest.token, inputValue)}
                disabled={!inputValue.trim() || verifying}
                style={{ padding: "6px 12px", background: inputValue.trim() && !verifying ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 5, color: inputValue.trim() && !verifying ? "#fff" : "var(--text-dim)", cursor: inputValue.trim() && !verifying ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, flexShrink: 0 }}>
                {t("i18n.submit")}
              </button>
            </div>
            {inputRequest.error && <p role="alert" style={{ margin: 0, fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{localizeServerMessage(inputRequest.error)}</p>}
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("models.oauthDeviceCodeHint")}</p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? ` ${t("models.oauthExpiresIn", { minutes: Math.ceil(loginState.expiresInSeconds / 60) })}` : ""}
            </p>
          </div>
        )}
        {verifying && !inputRequest && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            {localizeServerMessage(loginState.phase === "progress" ? loginState.message : null) ?? t("models.oauthVerifying")}
          </p>
        )}
        {loginState.phase === "success" && <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{t("i18n.connectedSuccessfully")}</p>}
        {loginState.phase === "error" && <p role="alert" style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{localizeServerMessage(loginState.message)}</p>}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button type="button"
            onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
            {t("i18n.cancel")}
          </button>
        ) : (
          <>
            <button type="button" onClick={handleLogin}
              style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              {provider.loggedIn ? t("i18n.relogin") : t("i18n.login")}
            </button>
            {provider.loggedIn && (
              <button type="button" onClick={() => void handleLogout()}
                style={{ padding: "5px 12px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", cursor: "pointer", fontSize: 12 }}>
                {t("i18n.disconnect")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}