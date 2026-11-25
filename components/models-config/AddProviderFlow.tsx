"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ProviderIcon } from "./ProviderIcon";
import type { ApiKeyProvider, OAuthProvider } from "./types";

/**
 * "+ Add provider" flow.
 *
 * Picking a catalog provider creates a `models.yml` entry prefilled with the
 * catalog's base URL, API kind, and env-var name (the key itself is never
 * fetched), so the user only pastes the key. OAuth providers branch into the
 * subscription login card instead, and the last card is the empty custom form.
 */
export function AddProviderFlow({ oauthProviders, apiKeyProviders, onSelectOAuth, onAddApiKey, onAddCustom, onClose }: {
  oauthProviders: readonly OAuthProvider[];
  apiKeyProviders: readonly ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onAddApiKey: (provider: ApiKeyProvider) => void;
  onAddCustom: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

  const query = search.trim().toLowerCase();
  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!query || p.name.toLowerCase().includes(query)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!query || p.displayName.toLowerCase().includes(query) || p.id.toLowerCase().includes(query)));
  const showCustom = !query || "custom".includes(query) || "openai-compatible".includes(query) || "anthropic-compatible".includes(query);
  const total = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    width: "100%",
  };

  const sectionTitle = (label: string) => (
    <div style={{ gridColumn: "1 / -1", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
      {label}
    </div>
  );

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div style={{ width: 820, maxWidth: "calc(100vw - 32px)", maxHeight: "min(72vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
            placeholder={t("i18n.searchProviders")}
            aria-label={t("i18n.searchProviders")}
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {total === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("i18n.noProviders")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {showCustom && sectionTitle(t("i18n.custom"))}
              {showCustom && (
                <button type="button" onClick={() => { onAddCustom(); onClose(); }} style={cardStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 }}>OpenAI / Anthropic compatible</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{t("i18n.customEndpoint")}</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: 5, background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)" }}>
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && sectionTitle(t("i18n.subscriptions"))}
              {availableOAuth.map((provider) => (
                <button key={provider.id} type="button" onClick={() => { onSelectOAuth(provider.id); onClose(); }} style={cardStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={provider.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && sectionTitle("API Key")}
              {availableApiKey.map((provider) => (
                <button key={provider.id} type="button" data-testid="add-provider-catalog-card"
                  onClick={() => { onAddApiKey(provider); onClose(); }} style={cardStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.displayName}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                      {provider.envVar ? `${provider.envVar} · ` : ""}{provider.modelCount} models
                    </div>
                  </div>
                  <ProviderIcon id={provider.id} size={28} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}