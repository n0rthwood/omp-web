"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscoveredModel } from "@/lib/model-discovery";
import { apiPath } from "@/lib/api-path";
import { useI18n } from "@/hooks/useI18n";
import { HeaderListEditor } from "./HeaderListEditor";
import { API_OPTIONS, Field, Select, SecretTextInput, SectionTitle, TextInput, inputStyle } from "./ui";
import type { ProviderEntry } from "./types";

type DiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; models: DiscoveredModel[]; endpoint: string }
  | { phase: "error"; message: string };

/**
 * Connection fields for a provider defined in `models.yml`.
 *
 * The API key field stores an env-var name, a `!shell-command`, or a literal
 * key — the panel never reads the resolved secret back, so nothing here can
 * print one.
 */
export function ProviderConfigForm({ name, provider, onChange, onRename, onDelete, onAddModels }: {
  name: string;
  provider: ProviderEntry;
  onChange: (provider: ProviderEntry) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddModels: (models: DiscoveredModel[]) => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  const [discovery, setDiscovery] = useState<DiscoveryState>({ phase: "idle" });
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const discoveryRequestIdRef = useRef(0);
  const selectShownRef = useRef<HTMLInputElement>(null);

  useEffect(() => setEditingName(name), [name]);

  const set = <K extends keyof ProviderEntry>(key: K, value: ProviderEntry[K]) => onChange({ ...provider, [key]: value });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  useEffect(() => {
    discoveryRequestIdRef.current += 1;
    setDiscovery({ phase: "idle" });
    setDiscoveryQuery("");
    setSelectedModelIds([]);
  }, [name, provider.baseUrl, provider.api, provider.apiKey]);

  const handleDiscover = useCallback(async () => {
    if (!provider.baseUrl?.trim() || discovery.phase === "loading") return;
    const requestId = ++discoveryRequestIdRef.current;
    setDiscovery({ phase: "loading" });
    setSelectedModelIds([]);
    try {
      const res = await fetch(apiPath("/api/models-config/discover"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: name, provider: { ...provider, models: undefined } }),
      });
      const data = await res.json() as { models?: DiscoveredModel[]; endpoint?: string; error?: string };
      if (requestId !== discoveryRequestIdRef.current) return;
      if (!res.ok || data.error || !data.models) {
        setDiscovery({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setDiscovery({ phase: "success", models: data.models, endpoint: data.endpoint ?? provider.baseUrl ?? "" });
    } catch (error) {
      if (requestId !== discoveryRequestIdRef.current) return;
      setDiscovery({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [discovery.phase, name, provider]);

  const existingModelIds = new Set((provider.models ?? []).map((model) => model.id));
  const discovered = discovery.phase === "success" ? discovery.models : [];
  const normalizedQuery = discoveryQuery.trim().toLocaleLowerCase();
  const filtered = discovered.filter((model) => !normalizedQuery
    || model.id.toLocaleLowerCase().includes(normalizedQuery)
    || model.name?.toLocaleLowerCase().includes(normalizedQuery));
  const shown = filtered.slice(0, 300);
  const selectableIds = shown.filter((model) => !existingModelIds.has(model.id)).map((model) => model.id);
  const selectedCount = selectedModelIds.filter((id) => !existingModelIds.has(id)).length;
  const allShownSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedModelIds.includes(id));
  const someShownSelected = !allShownSelected && selectableIds.some((id) => selectedModelIds.includes(id));

  useEffect(() => {
    if (selectShownRef.current) selectShownRef.current.indeterminate = someShownSelected;
  }, [someShownSelected]);

  const addSelected = () => {
    if (discovery.phase !== "success") return;
    const selected = new Set(selectedModelIds);
    const additions = discovery.models.filter((model) => selected.has(model.id) && !existingModelIds.has(model.id));
    if (additions.length === 0) return;
    onAddModels(additions);
    setSelectedModelIds([]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>{t("i18n.provider")}</SectionTitle>
        <button type="button" onClick={onDelete}
          style={{ padding: "3px 8px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: 11 }}>
          {t("i18n.delete")}
        </button>
      </div>

      <Field label={t("i18n.providerName")}>
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button type="button" onClick={() => onRename(editingName.trim())}
            style={{ marginTop: 4, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer", fontSize: 11, alignSelf: "flex-start" }}>
            {t("i18n.rename")}
          </button>
        )}
      </Field>

      <Field label="Base URL">
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)} placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label="API Key">
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder="ENV_VAR_NAME, !shell-command, or literal key" mono />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Prefix with <code style={{ fontFamily: "var(--font-mono)" }}>!</code> to run a shell command, or use an env var name
        </span>
      </Field>

      <Field label="API">
        <Select value={provider.api ?? "openai-completions"} onChange={(v) => set("api", v)} options={API_OPTIONS} required />
      </Field>

      <Field label="Headers">
        <HeaderListEditor headers={provider.headers} onChange={(headers) => set("headers", headers)} />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Added to every request from this provider (e.g. User-Agent). Useful for gateways with bot detection.
        </span>
      </Field>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {discovery.phase !== "success" && (
          <button type="button" onClick={() => void handleDiscover()}
            disabled={!provider.baseUrl?.trim() || discovery.phase === "loading"}
            style={{
              alignSelf: "flex-start", height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5,
              background: "var(--bg-panel)",
              color: !provider.baseUrl?.trim() || discovery.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
              cursor: !provider.baseUrl?.trim() || discovery.phase === "loading" ? "not-allowed" : "pointer", fontSize: 11,
            }}>
            {discovery.phase === "loading" ? t("models.discoveryFetching") : t("models.discoveryFetch")}
          </button>
        )}

        {discovery.phase === "error" && (
          <div style={{ padding: "7px 9px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", fontSize: 11, lineHeight: 1.4 }}>
            {discovery.message}
          </div>
        )}

        {discovery.phase === "success" && (
          <>
            <input
              value={discoveryQuery}
              onChange={(event) => setDiscoveryQuery(event.target.value)}
              placeholder={t("models.discoveryFilterPlaceholder", { count: discovery.models.length })}
              aria-label={t("models.discoveryFilter")}
              style={{ ...inputStyle, width: "100%", minWidth: 0 }}
            />
            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
              <label style={{
                minHeight: 32, padding: "5px 9px", display: "flex", alignItems: "center", gap: 8,
                position: "sticky", top: 0, zIndex: 1, borderBottom: "1px solid var(--border)",
                background: "var(--bg)", cursor: selectableIds.length ? "pointer" : "default",
                color: "var(--text-muted)", fontSize: 10, fontWeight: 600,
              }}>
                <input ref={selectShownRef} type="checkbox" checked={allShownSelected} disabled={selectableIds.length === 0}
                  onChange={() => setSelectedModelIds((current) => allShownSelected
                    ? current.filter((id) => !selectableIds.includes(id))
                    : Array.from(new Set([...current, ...selectableIds])))}
                  style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }} />
                {t("models.discoverySelectShown")}
              </label>
              {shown.length === 0 ? (
                <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11 }}>{t("models.discoveryNoMatches")}</div>
              ) : shown.map((model, index) => {
                const alreadyAdded = existingModelIds.has(model.id);
                return (
                  <label key={model.id} style={{
                    minHeight: 36, padding: "6px 9px", display: "flex", alignItems: "center", gap: 8,
                    borderTop: index === 0 ? "none" : "1px solid var(--border)", cursor: alreadyAdded ? "default" : "pointer",
                    opacity: alreadyAdded ? 0.65 : 1,
                  }}>
                    <input type="checkbox" checked={selectedModelIds.includes(model.id) || alreadyAdded} disabled={alreadyAdded}
                      onChange={() => setSelectedModelIds((current) => current.includes(model.id)
                        ? current.filter((id) => id !== model.id)
                        : [...current, model.id])}
                      style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11 }}>{model.name ?? model.id}</span>
                      {model.name && <code style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{model.id}</code>}
                    </span>
                    {alreadyAdded && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("models.discoveryAdded")}</span>}
                  </label>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span title={discovery.endpoint} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>
                {filtered.length > shown.length
                  ? t("models.discoveryShowing", { shown: shown.length, total: filtered.length })
                  : t("models.discoveryFetched", { count: discovery.models.length })}
              </span>
              <button type="button" onClick={addSelected} disabled={selectedCount === 0}
                style={{ height: 28, padding: "0 11px", border: "none", borderRadius: 5, background: selectedCount ? "var(--accent)" : "var(--bg-panel)", color: selectedCount ? "#fff" : "var(--text-dim)", cursor: selectedCount ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>
                {selectedCount ? t("models.discoveryAddSelectedCount", { count: selectedCount }) : t("models.discoveryAddSelected")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}