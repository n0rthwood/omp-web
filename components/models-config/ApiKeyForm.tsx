"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useI18n } from "@/hooks/useI18n";
import { Field, SecretTextInput } from "./ui";
import type { ApiKeyProvider } from "./types";

/**
 * API-key connection card for a catalog provider.
 *
 * The key is written to the auth store through `POST /api/auth/api-key/:id` and
 * removed with `DELETE`; the panel only ever holds the text being typed, never
 * a value read back from the server.
 *
 * A key that comes from the environment is outside that store, so "disconnect"
 * cannot remove it: the card says so up front, repeats it after a disconnect,
 * and offers to hide the row instead (#144).
 */
export function ApiKeyForm({ provider, onHide, onRefresh }: {
  provider: ApiKeyProvider;
  /** Offered when the key is env-sourced and no models.yml entry owns the row. */
  onHide?: () => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
    setNotice(null);
  }, [provider.id]);

  const envSourced = provider.source === "env";
  const envSource = provider.sourceEnvVar
    ? t("models.envKeyVariable", { name: provider.sourceEnvVar })
    : t("models.envKeyUnnamed");

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(apiPath(`/api/auth/api-key/${encodeURIComponent(provider.id)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || data.error) setError(data.error ?? `HTTP ${res.status}`);
      else {
        setApiKey("");
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, onRefresh, provider.id]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(apiPath(`/api/auth/api-key/${encodeURIComponent(provider.id)}`), { method: "DELETE" });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || data.error) setError(data.error ?? `HTTP ${res.status}`);
      else {
        // The stored credential is gone, but an env key keeps the provider configured.
        if (envSourced) setNotice(t("models.envKeyDisconnectResult", { variable: envSource }));
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [envSource, envSourced, onRefresh, provider.id, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {envSourced && (
        <div role="note" data-testid="env-key-note"
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 9px", border: "1px solid rgba(210,153,34,0.35)", borderRadius: 5, background: "rgba(210,153,34,0.08)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
          <span style={{ flex: 1, minWidth: 0 }}>{t("models.envKeyNote", { variable: envSource })}</span>
          {onHide && (
            <button type="button" data-testid="hide-provider-button" onClick={onHide}
              style={{ padding: "2px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}>
              {t("models.hideProvider")}
            </button>
          )}
        </div>
      )}

      <Field label="API Key">
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(event) => { if (event.key === "Enter" && apiKey.trim()) void handleSave(); }}
            placeholder={provider.configured ? t("models.apiKeyReplacePlaceholder") : "sk-…"}
            style={{ flex: 1 }}
            mono
          />
          <button type="button" onClick={() => void handleSave()} disabled={saving || !apiKey.trim() || savedOk}
            style={{
              padding: "6px 12px",
              background: savedOk ? "var(--success, #16a34a)" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
              border: "none", borderRadius: 5,
              color: apiKey.trim() || savedOk ? "#fff" : "var(--text-dim)",
              cursor: saving || !apiKey.trim() || savedOk ? "not-allowed" : "pointer",
              fontSize: 12, fontWeight: 600, flexShrink: 0,
            }}>
            {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
          </button>
        </div>
      </Field>

      {error && <p style={{ margin: 0, fontSize: 12, color: "var(--danger, #f87171)" }}>{error}</p>}

      {notice && (
        <p role="status" data-testid="env-key-disconnect-result" style={{ margin: 0, fontSize: 12, color: "var(--warning, #d29922)", lineHeight: 1.45 }}>
          {notice}
        </p>
      )}

      {provider.configured && (
        <button type="button" onClick={() => void handleRemove()} disabled={removing}
          style={{ alignSelf: "flex-start", padding: "5px 12px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", cursor: removing ? "not-allowed" : "pointer", fontSize: 12 }}>
          {removing ? t("i18n.removing") : t("i18n.disconnect")}
        </button>
      )}
    </div>
  );
}
