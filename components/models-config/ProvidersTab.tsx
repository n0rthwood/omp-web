"use client";

import { useEffect, useMemo, useState } from "react";
import type { DiscoveredModel } from "@/lib/model-discovery";
import { useI18n } from "@/hooks/useI18n";
import { ApiKeyForm } from "./ApiKeyForm";
import { OAuthCard } from "./OAuthCard";
import { ProviderConfigForm } from "./ProviderConfigForm";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderModelTable } from "./ProviderModelTable";
import { buildProviderModelRows } from "./provider-model-rows";
import { mergeProviderRows, providerRowGroup } from "./provider-merge";
import { RefreshDiffPanel } from "./RefreshDiffPanel";
import type {
  ApiKeyProvider,
  ModelEntry,
  ModelHealthMap,
  ModelOption,
  ModelOverridePatch,
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
 * `models` is the provider's untrimmed registry list: neither the
 * `enabledModels` allow-list nor a missing project scope narrows it, so a
 * catalog provider shows every model it serves with the catalog facts
 * (modalities, thinking, pricing, windows) the runtime resolves (#144).
 */
export function ProvidersTab({
  config,
  savedProviderNames,
  oauthProviders,
  apiKeyProviders,
  models,
  modelHealth,
  thinkingLevels,
  hiddenProviders,
  providerHealth,
  focusProviderId,
  refreshState,
  refreshBusy,
  saving,
  onRefresh,
  onUpdateProvider,
  onRenameProvider,
  onDeleteProvider,
  onOverrideModel,
  onAddDiscoveredModels,
  onAuthChanged,
  onModelsChanged,
  onHideProvider,
  onShowProvider,
  onAddProvider,
  onSync,
}: {
  config: ModelsJson;
  savedProviderNames: string[];
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  models: ModelOption[];
  modelHealth?: ModelHealthMap;
  /** `provider:modelId` → efforts the registry supports, for the Thinking column. */
  thinkingLevels?: Readonly<Record<string, readonly string[]>>;
  /** Provider ids this machine's user hid from the list (#144). */
  hiddenProviders: ReadonlySet<string>;
  providerHealth?: Record<string, ProviderHealth>;
  focusProviderId: string | null;
  refreshState: ProviderRefreshState;
  refreshBusy: boolean;
  saving: boolean;
  onRefresh: (name: string) => void;
  onUpdateProvider: (name: string, provider: ProviderEntry) => void;
  onRenameProvider: (oldName: string, newName: string) => void;
  onDeleteProvider: (name: string) => void;
  onOverrideModel: (providerName: string, modelId: string, changed: ModelOverridePatch) => void;
  onAddDiscoveredModels: (providerName: string, models: DiscoveredModel[]) => void;
  onAuthChanged: () => void;
  onModelsChanged?: () => void;
  onHideProvider: (id: string) => void;
  onShowProvider: (id: string) => void;
  onAddProvider: () => void;
  onSync: () => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(
    () => mergeProviderRows(oauthProviders, apiKeyProviders, config.providers ?? {}),
    [apiKeyProviders, config.providers, oauthProviders],
  );

  // A key that comes from the environment cannot be disconnected, so its row
  // is hidden on request instead. Hidden rows stay listed here so the choice
  // can be undone, and an id without a row any more is simply not shown.
  const hiddenRows = useMemo(() => rows.filter((row) => hiddenProviders.has(row.id)), [hiddenProviders, rows]);
  const visibleRows = useMemo(() => rows.filter((row) => !hiddenProviders.has(row.id)), [hiddenProviders, rows]);

  const grouped = useMemo(() => GROUP_ORDER
    .map((source) => ({
      source,
      rows: visibleRows
        .filter((row) => providerRowGroup(row) === source)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.rows.length > 0), [visibleRows]);

  useEffect(() => {
    if (focusProviderId && visibleRows.some((row) => row.id === focusProviderId)) {
      setSelectedId(focusProviderId);
      return;
    }
    if (selectedId && visibleRows.some((row) => row.id === selectedId)) return;
    setSelectedId(visibleRows[0]?.id ?? null);
  }, [focusProviderId, visibleRows, selectedId]);

  const selected = visibleRows.find((row) => row.id === selectedId) ?? null;

  const modelRows = useMemo(
    () => (selected ? buildProviderModelRows(selected, models, thinkingLevels ?? {}) : []),
    [models, selected, thinkingLevels],
  );

  const updateModelAt = (index: number, model: ModelEntry) => {
    if (!selected?.config) return;
    const next = [...(selected.config.models ?? [])];
    next[index] = model;
    onUpdateProvider(selected.id, { ...selected.config, models: next });
  };

  const createModel = (model: ModelEntry) => {
    if (!selected?.config) return;
    onUpdateProvider(selected.id, { ...selected.config, models: [...(selected.config.models ?? []), model] });
  };

  // omp serves a `models[]` definition only under an entry that says where to
  // send it and in which dialect. Without both the file fails validation and
  // every models.yml provider disappears, so the entry is not offered.
  const canAddModel = Boolean(selected?.config?.baseUrl && selected.config.api);

  // Hiding is for rows nothing else can remove: a models.yml entry has Delete,
  // a login or stored key has Disconnect.
  const hideable = selected !== null && !selected.config && selected.apiKey?.source === "env";

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
                  data-provider-id={row.id}
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
        {hiddenRows.length > 0 && (
          <div data-testid="hidden-providers" style={{ margin: "4px 0 10px" }}>
            <p style={{ margin: "0 4px 4px", fontSize: 11, color: "var(--text-dim)" }}>{t("models.hiddenProviders", { count: hiddenRows.length })}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 4px" }}>
              {hiddenRows.map((row) => (
                <button key={row.id} type="button" data-testid="show-provider-button" onClick={() => onShowProvider(row.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 7px", background: "none", border: "1px dashed var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
                  <ProviderIcon id={row.id} size={12} />
                  {row.name}
                  <span style={{ color: "var(--accent)" }}>{t("models.showProvider")}</span>
                </button>
              ))}
            </div>
          </div>
        )}
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
                onHide={hideable ? () => onHideProvider(selected.id) : undefined}
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
                  {selected.config?.apiKey
                    ?? (selected.apiKey?.source === "env" && selected.apiKey.sourceEnvVar
                      ? t("models.envKeyVariable", { name: selected.apiKey.sourceEnvVar })
                      : selected.apiKey?.source)
                    ?? (selected.oauth ? t("models.credentialOAuth") : "—")}
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
              canAddModel={canAddModel}
              addModelBlockedReason={t("models.addModelNeedsHost")}
              onUpdateModel={updateModelAt}
              onOverrideModel={(modelId, changed) => onOverrideModel(selected.id, modelId, changed)}
              onCreateModel={createModel}
            />
          </div>
        )}
      </div>
    </div>
  );
}
