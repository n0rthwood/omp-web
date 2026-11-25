"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ApiKeyForm } from "./ApiKeyForm";
import { OAuthCard } from "./OAuthCard";
import { ProviderConfigForm } from "./ProviderConfigForm";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderModelTable, type ModelRow } from "./ProviderModelTable";
import { RefreshDiffPanel } from "./RefreshDiffPanel";
import { mergeProviderRows, providerRowGroup } from "./provider-merge";
import type {
  ApiKeyProvider,
  ModelEntry,
  ModelHealthMap,
  ModelOption,
  ModelsJson,
  OAuthProvider,
  ProviderEntry,
  ProviderHealth,
  ProviderRefreshState,
  ProviderSource,
} from "./types";

const GROUP_ORDER: ProviderSource[] = ["oauth", "api_key", "config"];

const GROUP_LABEL_KEYS: Record<ProviderSource, { title: string; sub: string }> = {
  oauth: { title: "models.groupOAuth", sub: "models.groupOAuthSub" },
  api_key: { title: "models.groupApiKey", sub: "models.groupApiKeySub" },
  config: { title: "models.groupConfig", sub: "models.groupConfigSub" },
};

/**
 * Tab 3 — providers, merged into one row per provider.
 *
 * A provider that exists both in the built-in catalog and in `models.yml` used
 * to render twice ("two Zhipu"); here the rows are keyed by provider id and the
 * config layer wins, with a badge naming every layer that contributed. The
 * right half is the connection info, the OAuth card (subscriptions only), the
 * refresh diff, and the merged model table.
 */
export function ProvidersTab({
  config,
  savedProviderNames,
  oauthProviders,
  apiKeyProviders,
  models,
  modelHealth,
  providerHealth,
  focusProviderId,
  refreshState,
  refreshBusy,
  saving,
  onRefresh,
  onUpdateProvider,
  onRenameProvider,
  onDeleteProvider,
  onAddDiscoveredModels,
  onAuthChanged,
  onModelsChanged,
  onAddProvider,
  onSync,
}: {
  config: ModelsJson;
  savedProviderNames: readonly string[];
  oauthProviders: readonly OAuthProvider[];
  apiKeyProviders: readonly ApiKeyProvider[];
  models: readonly ModelOption[];
  modelHealth?: ModelHealthMap;
  providerHealth?: Record<string, ProviderHealth>;
  /** Provider to select when the tab opens (e.g. just added from the catalog). */
  focusProviderId?: string | null;
  refreshState: ProviderRefreshState;
  refreshBusy: boolean;
  saving: boolean;
  onRefresh: (providerName: string) => void;
  onUpdateProvider: (name: string, provider: ProviderEntry) => void;
  onRenameProvider: (oldName: string, newName: string) => void;
  onDeleteProvider: (name: string) => void;
  onAddDiscoveredModels: (name: string, models: { id: string; name?: string }[]) => void;
  onAuthChanged: () => void;
  onModelsChanged?: () => void;
  onAddProvider: () => void;
  onSync: () => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(
    () => mergeProviderRows(oauthProviders, apiKeyProviders, config.providers ?? {}),
    [apiKeyProviders, config.providers, oauthProviders],
  );

  const grouped = useMemo(() => GROUP_ORDER
    .map((source) => ({
      source,
      rows: rows
        .filter((row) => providerRowGroup(row) === source)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.rows.length > 0), [rows]);

  useEffect(() => {
    if (focusProviderId && rows.some((row) => row.id === focusProviderId)) {
      setSelectedId(focusProviderId);
      return;
    }
    if (selectedId && rows.some((row) => row.id === selectedId)) return;
    setSelectedId(rows[0]?.id ?? null);
  }, [focusProviderId, rows, selectedId]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const modelRows = useMemo<ModelRow[]>(() => {
    if (!selected) return [];
    const byId = new Map<string, ModelRow>();
    for (const model of models) {
      if (model.provider !== selected.id) continue;
      byId.set(model.id, {
        id: model.id,
        source: "catalog",
        configIndex: null,
        entry: { id: model.id },
        contextWindow: model.contextWindow,
      });
    }
    (selected.config?.models ?? []).forEach((entry, index) => {
      const existing = byId.get(entry.id);
      const merged: ModelRow = {
        id: entry.id,
        source: existing ? "merged" : "config",
        configIndex: index,
        entry,
        contextWindow: entry.contextWindow ?? existing?.contextWindow,
        maxTokens: entry.maxTokens ?? existing?.maxTokens,
        cost: entry.cost ?? existing?.cost,
        reasoning: entry.reasoning ?? existing?.reasoning,
      };
      byId.set(entry.id, merged);
    });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [models, selected]);

  const updateModelAt = (index: number, model: ModelEntry) => {
    if (!selected?.config) return;
    const next = [...(selected.config.models ?? [])];
    next[index] = model;
    onUpdateProvider(selected.id, { ...selected.config, models: next });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 340px) 1fr", gap: 16, height: "100%" }}>
      <div style={{ borderRight: "1px solid var(--border)", paddingRight: 14, overflowY: "auto" }}>
        {grouped.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 4px" }}>{t("models.noProviders")}</div>
        )}
        {grouped.map((group) => (
          <div key={group.source} style={{ marginBottom: 14 }}>
            <h3 style={{ margin: "0 0 3px", fontSize: 11.5, color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.04em" }}>
              {t(GROUP_LABEL_KEYS[group.source].title)}
            </h3>
            <p style={{ margin: "0 0 7px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.4 }}>
              {t(GROUP_LABEL_KEYS[group.source].sub)}
            </p>
            {group.rows.map((row) => {
              const isSelected = row.id === selectedId;
              const health = providerHealth?.[row.id];
              return (
                <button
                  key={row.id}
                  type="button"
                  data-testid="provider-list-item"
                  aria-current={isSelected}
                  onClick={() => setSelectedId(row.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    textAlign: "left",
                    background: isSelected ? "var(--bg-selected)" : "transparent",
                    border: "1px solid transparent",
                    borderRadius: 6,
                    padding: "6px 8px",
                    marginBottom: 2,
                    cursor: "pointer",
                  }}>
                  <ProviderIcon id={row.id} size={16} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>{row.name}</span>
                  {row.tag && (
                    <span style={{ fontSize: 11, color: row.tag === "override" ? "var(--accent)" : "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {row.tag === "override" ? t("models.tagOverride") : t("models.tagCustom")}
                    </span>
                  )}
                  <span aria-hidden="true" style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flex: "none",
                    background: health
                      ? health.state === "ok" ? "var(--success, #3fb950)"
                        : health.state === "expiring" ? "var(--warning, #d29922)"
                        : "var(--danger, #f85149)"
                      : row.loggedIn || row.configured ? "var(--success, #3fb950)" : "var(--text-dim)",
                  }} />
                </button>
              );
            })}
          </div>
        ))}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          <button type="button" data-testid="add-provider-button" onClick={onAddProvider}
            style={{ padding: "6px 0", width: "100%", background: "none", border: "1px dashed var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
            + {t("i18n.addProvider")}
          </button>
          <button type="button" onClick={onSync}
            style={{ padding: "6px 0", width: "100%", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
            {t("models.syncConfig")}
          </button>
        </div>
      </div>

      <div style={{ overflowY: "auto", minWidth: 0 }}>
        {!selected ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
            {t("i18n.selectProviderModel")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {selected.tag === "override" && (
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5, border: "1px solid var(--border)", background: "var(--bg-panel)", borderRadius: 6, padding: "8px 10px" }}>
                {t("models.mergeBanner", { provider: selected.id })}
              </div>
            )}

            {selected.oauth && (
              <OAuthCard
                provider={selected.oauth}
                health={providerHealth?.[selected.id]}
                onRefresh={() => { onAuthChanged(); onModelsChanged?.(); }}
              />
            )}

            {selected.apiKey && !selected.config && (
              <ApiKeyForm
                provider={selected.apiKey}
                onRefresh={() => { onAuthChanged(); onModelsChanged?.(); }}
              />
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", fontSize: 11.5 }}>
                <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>baseUrl</span>
                <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", wordBreak: "break-all" }}>{selected.config?.baseUrl ?? "—"}</code>
                <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>API</span>
                <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{selected.config?.api ?? "—"}</code>
                <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{t("models.credential")}</span>
                <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                  {selected.config?.apiKey ?? selected.apiKey?.source ?? (selected.oauth ? t("models.credentialOAuth") : "—")}
                </code>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button type="button"
                  onClick={() => onRefresh(selected.id)}
                  disabled={refreshBusy || saving || (!savedProviderNames.includes(selected.id) && !selected.oauth && !selected.apiKey)}
                  style={{
                    height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5,
                    background: "var(--bg-panel)",
                    color: refreshBusy || saving ? "var(--text-dim)" : "var(--text-muted)",
                    cursor: refreshBusy || saving ? "not-allowed" : "pointer", fontSize: 11,
                  }}>
                  {t("models.refreshProvider")}
                </button>
                <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("models.refreshHint")}</span>
              </div>
              <RefreshDiffPanel state={refreshState} providerName={selected.id} />
            </div>

            {selected.config && (
              <ProviderConfigForm
                key={selected.id}
                name={selected.id}
                provider={selected.config}
                onChange={(next) => onUpdateProvider(selected.id, next)}
                onRename={(next) => onRenameProvider(selected.id, next)}
                onDelete={() => onDeleteProvider(selected.id)}
                onAddModels={(discovered) => onAddDiscoveredModels(selected.id, discovered)}
              />
            )}

            <ProviderModelTable
              providerName={selected.id}
              rows={modelRows}
              health={modelHealth}
              canAddModel={Boolean(selected.config)}
              onAddModel={() => {
                if (!selected.config) return;
                const next = [...(selected.config.models ?? []), { id: "" }];
                onUpdateProvider(selected.id, { ...selected.config, models: next });
              }}
              onUpdateModel={updateModelAt}
            />
          </div>
        )}
      </div>
    </div>
  );
}