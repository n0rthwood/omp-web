"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import type { DiscoveredModel } from "@/lib/model-discovery";
import { apiPath } from "@/lib/api-path";
import { refreshProviderModels } from "./models-config-helpers";
import { AddProviderFlow } from "./models-config/AddProviderFlow";
import { AllowListTab } from "./models-config/AllowListTab";
import { HealthStrip } from "./models-config/HealthStrip";
import { ProvidersTab } from "./models-config/ProvidersTab";
import { RolesTab } from "./models-config/RolesTab";
import type {
  ApiKeyProvider,
  ModelHealthMap,
  ModelOption,
  ModelsHealthResponse,
  ModelsJson,
  OAuthProvider,
  ProviderEntry,
  ProviderRefreshState,
} from "./models-config/types";

type TabId = "roles" | "allowList" | "providers";

const TABS: { id: TabId; labelKey: string }[] = [
  { id: "roles", labelKey: "roles.title" },
  { id: "allowList", labelKey: "i18n.modelAllowList" },
  { id: "providers", labelKey: "models.providersTab" },
];

interface ModelsResponse {
  modelList?: ModelOption[];
  modelHealth?: ModelHealthMap;
}

/**
 * Model configuration: one dialog, three tabs.
 *
 * Each tab owns exactly one configuration layer — roles (+ fallback chains),
 * the `enabledModels` allow-list, and providers — so the OAuth/API-key/
 * models.yml layers that used to sit side by side in one tree no longer read as
 * three separate providers. Writes go through the same endpoints as before
 * (`/api/model-roles*`, `/api/models-config`, `/api/auth/*`).
 */
export function ModelsConfig({ cwd, onClose, embedded = false, onModelsChanged }: { cwd?: string | null; onClose: () => void; embedded?: boolean; onModelsChanged?: () => void }) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [tab, setTab] = useState<TabId>("roles");
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [savedProviderNames, setSavedProviderNames] = useState<string[]>([]);
  const [providerRefresh, setProviderRefresh] = useState<ProviderRefreshState>({ phase: "idle" });
  const providerRefreshPendingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [modelList, setModelList] = useState<ModelOption[]>([]);
  const [modelHealth, setModelHealth] = useState<ModelHealthMap | undefined>(undefined);
  const [health, setHealth] = useState<ModelsHealthResponse | null>(null);
  const [healthToken, setHealthToken] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focusProviderId, setFocusProviderId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  const loadAuthProviders = useCallback(() => {
    fetch(apiPath("/api/auth/providers"))
      .then((res) => res.json())
      .then((data: { providers: OAuthProvider[] }) => setOauthProviders(data.providers))
      .catch(() => {});
    fetch(apiPath("/api/auth/all-providers"))
      .then((res) => res.json())
      .then((data: { providers: ApiKeyProvider[] }) => setApiKeyProviders(data.providers))
      .catch(() => {});
  }, []);

  // A dual-auth provider moves between the two lists when its credential type
  // changes, so any auth change reloads both — refreshing only one leaves the
  // provider rendered twice, and disconnecting the stale row would delete the
  // credential that was just created (#309).
  const refreshAuthProviders = useCallback(() => {
    loadAuthProviders();
    setHealthToken((token) => token + 1);
  }, [loadAuthProviders]);

  const loadModels = useCallback((signal?: AbortSignal) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(apiPath(`/api/models${query}`), signal ? { signal } : undefined)
      .then((res) => res.json())
      .then((data: ModelsResponse) => {
        setModelList(data.modelList ?? []);
        setModelHealth(data.modelHealth);
      })
      .catch(() => {});
  }, [cwd]);

  useEffect(() => {
    fetch(apiPath("/api/models-config"))
      .then((res) => res.json())
      .then((data: ModelsJson) => {
        setConfig(data.providers ? data : { ...data, providers: {} });
        setSavedProviderNames(Object.keys(data.providers ?? {}));
      })
      .catch(() => setConfig({ providers: {} }))
      .finally(() => setLoading(false));
    refreshAuthProviders();
  }, [refreshAuthProviders]);

  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal);
    return () => controller.abort();
  }, [loadModels]);

  // The background health scan is a separate service; a 404 (not deployed yet)
  // or any failure simply leaves the strip hidden.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(apiPath("/api/models/health"), { signal: controller.signal });
        if (!res.ok) {
          setHealth(null);
          return;
        }
        const data = await res.json() as ModelsHealthResponse;
        setHealth(data);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setHealth(null);
      }
    })();
    return () => controller.abort();
  }, [healthToken]);

  useEffect(() => () => {
    clearTimeout(toastTimerRef.current);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  const addProviderEntry = useCallback((id: string, entry: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [id]: entry } }));
  }, []);

  const addCustomProvider = useCallback(() => {
    let name = "new-provider";
    let counter = 1;
    while (config.providers?.[name]) name = `new-provider-${counter++}`;
    addProviderEntry(name, { api: "openai-completions" });
  }, [addProviderEntry, config.providers]);

  // Catalog pick: prefill the models.yml entry from the catalog defaults so the
  // user only supplies the key. The key value itself is never read back.
  const addCatalogProvider = useCallback((provider: ApiKeyProvider) => {
    addProviderEntry(provider.id, {
      api: provider.api ?? "openai-completions",
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.envVar ? { apiKey: provider.envVar } : {}),
      models: [],
    });
    setTab("providers");
  }, [addProviderEntry]);

  const updateProvider = useCallback((name: string, provider: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: provider } }));
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const index = entries.findIndex(([key]) => key === oldName);
      if (index === -1) return prev;
      entries[index] = [newName, entries[index][1]];
      return { ...prev, providers: Object.fromEntries(entries) };
    });
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
  }, []);

  const addDiscoveredModels = useCallback((providerName: string, discovered: DiscoveredModel[]) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      const existing = new Set(models.map((model) => model.id));
      for (const model of discovered) {
        if (existing.has(model.id)) continue;
        existing.add(model.id);
        models.push({ id: model.id, name: model.name });
      }
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const handleProviderRefresh = useCallback(async (providerName: string) => {
    const isPersisted = savedProviderNames.includes(providerName)
      || oauthProviders.some((provider) => provider.id === providerName)
      || apiKeyProviders.some((provider) => provider.id === providerName);
    if (providerRefreshPendingRef.current || saving || !isPersisted) return;
    providerRefreshPendingRef.current = true;
    setProviderRefresh({ phase: "loading", providerName });
    try {
      const result = await refreshProviderModels(providerName, onModelsChanged);
      setProviderRefresh({ phase: "success", providerName, warning: result.warning, diff: result.diff });
    } catch (error) {
      setProviderRefresh({ phase: "error", providerName, message: error instanceof Error ? error.message : String(error) });
    } finally {
      providerRefreshPendingRef.current = false;
    }
  }, [apiKeyProviders, oauthProviders, onModelsChanged, savedProviderNames, saving]);

  const handleSave = useCallback(async () => {
    if (providerRefreshPendingRef.current) return;
    setProviderRefresh({ phase: "idle" });
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch(apiPath("/api/models-config"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || data.error) setSaveError(data.error ?? `HTTP ${res.status}`);
      else {
        setSavedProviderNames(Object.keys(config.providers ?? {}));
        setSavedOk(true);
        onModelsChanged?.();
        setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  }, [config, onModelsChanged]);

  const refreshBusy = providerRefresh.phase === "loading";

  return (
    <>
      <div style={{ position: embedded ? "relative" : "fixed", inset: embedded ? undefined : 0, width: "100%", height: "100%", zIndex: embedded ? undefined : 1000, background: embedded ? "transparent" : "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={(event) => { if (!embedded && event.target === event.currentTarget) onClose(); }}>
        <div style={{ width: embedded ? "100%" : isMobile ? "calc(100vw - 16px)" : 1100, maxWidth: embedded ? "none" : "calc(100vw - 16px)", height: embedded ? "100%" : isMobile ? "calc(100dvh - 16px)" : "82vh", maxHeight: embedded ? "none" : "calc(100dvh - 16px)", background: "var(--bg)", border: embedded ? "none" : "1px solid var(--border)", borderRadius: embedded ? 0 : 10, display: "flex", flexDirection: "column", boxShadow: embedded ? "none" : "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{t("common.models")}</span>
              <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>~/.omp/agent/models.yml</code>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <HealthStrip health={health} />
              <button type="button" onClick={onClose} aria-label={t("i18n.cancel")}
                style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
            </div>
          </div>

          <nav role="tablist" aria-label={t("common.models")} style={{ display: "flex", gap: 4, padding: "0 18px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                data-testid={`models-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                onClick={() => setTab(entry.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  borderBottom: `2px solid ${tab === entry.id ? "var(--accent)" : "transparent"}`,
                  padding: "11px 14px",
                  color: tab === entry.id ? "var(--text)" : "var(--text-muted)",
                  fontSize: 13.5,
                  fontWeight: tab === entry.id ? 600 : 400,
                  cursor: "pointer",
                }}>
                {t(entry.labelKey)}
              </button>
            ))}
          </nav>

          <div style={{ flex: 1, overflow: "auto", padding: "16px 18px 8px", minWidth: 0 }}>
            {loading ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
            ) : tab === "roles" ? (
              <RolesTab cwd={cwd ?? null} health={modelHealth} onModelsChanged={onModelsChanged} onSync={() => showToast(t("models.syncComingSoon"))} />
            ) : tab === "allowList" ? (
              <AllowListTab cwd={cwd ?? null} models={modelList} health={modelHealth} onSaved={onModelsChanged} onSync={() => showToast(t("models.syncComingSoon"))} />
            ) : (
              <ProvidersTab
                config={config}
                savedProviderNames={savedProviderNames}
                oauthProviders={oauthProviders}
                apiKeyProviders={apiKeyProviders}
                models={modelList}
                modelHealth={modelHealth}
                providerHealth={health?.providers}
                focusProviderId={focusProviderId}
                refreshState={providerRefresh}
                refreshBusy={refreshBusy}
                saving={saving}
                onRefresh={(name) => { void handleProviderRefresh(name); }}
                onUpdateProvider={updateProvider}
                onRenameProvider={renameProvider}
                onDeleteProvider={deleteProvider}
                onAddDiscoveredModels={addDiscoveredModels}
                onAuthChanged={refreshAuthProviders}
                onModelsChanged={onModelsChanged}
                onAddProvider={() => setPickerOpen(true)}
                onSync={() => showToast(t("models.syncComingSoon"))}
              />
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
            {saveError && <span style={{ fontSize: 12, color: "var(--danger, #f87171)", flex: 1 }}>{saveError}</span>}
            {toast && (
              <span role="status" style={{ fontSize: 12, color: "var(--text-muted)", flex: 1 }}>{toast}</span>
            )}
            <button type="button" onClick={onClose} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>
              {t("i18n.cancel")}
            </button>
            <button type="button" onClick={handleSave} disabled={saving || savedOk || refreshBusy} style={{
              minWidth: 92,
              padding: "6px 16px",
              background: savedOk ? "var(--success, #16a34a)" : saving || refreshBusy ? "var(--bg-panel)" : "var(--accent)",
              border: "none", borderRadius: 6,
              color: savedOk || (!saving && !refreshBusy) ? "#fff" : "var(--text-muted)",
              cursor: saving || savedOk || refreshBusy ? "default" : "pointer", fontSize: 13, fontWeight: 600,
            }}>
              {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
            </button>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <AddProviderFlow
          oauthProviders={oauthProviders}
          apiKeyProviders={apiKeyProviders}
          onSelectOAuth={(id) => {
            setTab("providers");
            setPickerOpen(false);
            setFocusProviderId(id);
          }}
          onAddApiKey={addCatalogProvider}
          onAddCustom={addCustomProvider}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}