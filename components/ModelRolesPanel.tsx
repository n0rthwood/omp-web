"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelRoleAssignment, ModelRoleScope, RoleFallbackChain } from "@/lib/api-types";
import { apiPath } from "@/lib/api-path";
import {
  formatModelRoleSelector,
  getModelRoleThinkingLevel,
  getModelRoleThinkingOptions,
  type ModelRoleThinkingLevel,
} from "@/lib/model-role-selection";
import { useI18n } from "@/hooks/useI18n";
import { SearchableSelect } from "./SearchableSelect";

interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

interface ModelsResponse {
  modelList?: ModelEntry[];
  thinkingLevels?: Record<string, string[]>;
}

interface Props {
  /** Working directory the roles are resolved against (project layer + model scope). */
  cwd: string | null;
  /** Notifies the shell that a role changed so open sessions refresh their picker. */
  onRolesChanged?: () => void;
}

const SCOPES: ModelRoleScope[] = ["global", "project"];

function selectorFor(model: ModelEntry): string {
  return `${model.provider}/${model.id}`;
}

/** Compact affordance sized to sit inside a backup chip without changing its height. */
function chipButtonStyle(disabled: boolean, wide = false): React.CSSProperties {
  return {
    padding: wide ? "2px 6px" : "0 3px",
    border: wide ? "1px dashed var(--border)" : "none",
    borderRadius: 3,
    background: "transparent",
    color: "var(--text-dim)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    lineHeight: 1.2,
    opacity: disabled ? 0.4 : 1,
  };
}

/**
 * Assign a model to each of omp's roles.
 *
 * omp routes work by role rather than by "the current model": `default` runs
 * ordinary turns, `smol` runs cheap subagent work, `slow` runs deep reasoning,
 * `plan` drives plan mode, `commit` writes changelogs. This panel writes the
 * same `modelRoles` record `omp`'s `/model` selector writes, so an assignment
 * made here is what the next terminal session uses too.
 */
export function ModelRolesPanel({ cwd, onRolesChanged }: Props) {
  const { t } = useI18n();
  const [roles, setRoles] = useState<ModelRoleAssignment[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<Record<string, string[]>>({});
  const [scope, setScope] = useState<ModelRoleScope>("global");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [rotation, setRotation] = useState<{ enabled: boolean; roles: Record<string, boolean> }>({
    enabled: false,
    roles: {},
  });
  const [chains, setChains] = useState<RoleFallbackChain[]>([]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!cwd) {
      setRoles([]);
      setChains([]);
      setModels([]);
      setThinkingLevels({});
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = `?cwd=${encodeURIComponent(cwd)}`;
      const [rolesRes, modelsRes, rotationRes] = await Promise.all([
        fetch(apiPath(`/api/model-roles${query}`), signal ? { signal } : undefined),
        fetch(apiPath(`/api/models${query}`), signal ? { signal } : undefined),
        fetch(apiPath("/api/model-roles/rotation"), signal ? { signal } : undefined),
      ]);
      if (!rolesRes.ok) throw new Error(`HTTP ${rolesRes.status}`);
      const rolesData = await rolesRes.json() as {
        roles?: ModelRoleAssignment[];
        fallbackChains?: RoleFallbackChain[];
        error?: string;
      };
      if (rolesData.error) throw new Error(rolesData.error);
      if (!modelsRes.ok) throw new Error(`HTTP ${modelsRes.status}`);
      const modelsData = await modelsRes.json() as ModelsResponse;
      setRoles(rolesData.roles ?? []);
      setChains(rolesData.fallbackChains ?? []);
      setModels(modelsData.modelList ?? []);
      setThinkingLevels(modelsData.thinkingLevels ?? {});
      if (rotationRes.ok) {
        const rotationData = await rotationRes.json() as {
          rotation?: { enabled?: boolean; roles?: Record<string, boolean> };
        };
        setRotation({
          enabled: rotationData.rotation?.enabled === true,
          roles: rotationData.rotation?.roles ?? {},
        });
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const writeRotation = useCallback(async (patch: { enabled?: boolean; role?: string; rotate?: boolean }) => {
    setError(null);
    try {
      const res = await fetch(apiPath("/api/model-roles/rotation"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json() as {
        rotation?: { enabled?: boolean; roles?: Record<string, boolean> };
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRotation({ enabled: data.rotation?.enabled === true, roles: data.rotation?.roles ?? {} });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const assign = useCallback(async (role: string, selector: string | null) => {
    if (!cwd) return;
    setPendingRole(role);
    setError(null);
    try {
      const res = await fetch(apiPath("/api/model-roles"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, role, selector, scope }),
      });
      const data = await res.json() as { roles?: ModelRoleAssignment[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRoles(data.roles ?? []);
      onRolesChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingRole(null);
    }
  }, [cwd, scope, onRolesChanged]);

  /**
   * Rewrite one role's backup chain.
   *
   * `chain: null` drops the role's key so omp's `default` chain covers it
   * again; `[]` persists "no backups", which omp treats as a real value rather
   * than an absent one.
   */
  const writeChain = useCallback(async (role: string, chain: string[] | null) => {
    if (!cwd) return;
    setPendingRole(role);
    setError(null);
    try {
      const res = await fetch(apiPath("/api/model-roles/fallbacks"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, role, chain }),
      });
      const data = await res.json() as {
        roles?: ModelRoleAssignment[];
        fallbackChains?: RoleFallbackChain[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRoles(data.roles ?? []);
      setChains(data.fallbackChains ?? []);
      onRolesChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingRole(null);
    }
  }, [cwd, onRolesChanged]);

  const chainByRole = useMemo(() => {
    const byRole: Record<string, RoleFallbackChain> = {};
    for (const entry of chains) byRole[entry.role] = entry;
    return byRole;
  }, [chains]);

  const visibleRoles = useMemo(() => roles.filter((role) => !role.hidden), [roles]);

  if (!cwd) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("roles.needsProject")}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
          {t("roles.title")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("roles.description")}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("roles.scope")}</span>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {SCOPES.map((option) => (
            <button
              key={option}
              onClick={() => setScope(option)}
              style={{
                padding: "4px 10px",
                border: "none",
                background: scope === option ? "var(--bg-selected)" : "transparent",
                color: scope === option ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: scope === option ? 600 : 400,
              }}
            >
              {option === "global" ? t("roles.scopeGlobal") : t("roles.scopeProject")}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {scope === "global" ? "~/.omp/agent/config.yml" : ".omp/config.yml"}
        </span>
      </div>

      <label
        title={t("roles.rotationHint")}
        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={rotation.enabled}
          onChange={(event) => void writeRotation({ enabled: event.target.checked })}
        />
        {t("roles.rotation")}
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          ~/.omp/agent/omp-web-model-rotation.json
        </span>
      </label>

      {error && (
        <div style={{ fontSize: 12, color: "var(--danger, #ff4757)" }}>{error}</div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {visibleRoles.map((role) => {
            const current = role.resolved ? `${role.resolved.provider}/${role.resolved.modelId}` : "";
            const currentThinkingLevel = getModelRoleThinkingLevel(role.selector);
            const thinkingKey = role.resolved ? `${role.resolved.provider}:${role.resolved.modelId}` : "";
            const thinkingOptions = getModelRoleThinkingOptions(thinkingLevels[thinkingKey]);
            const chain = chainByRole[role.role];
            const backups = chain?.effective ?? [];
            const inherited = chain?.inherited ?? false;
            const busy = pendingRole === role.role;
            return (
              <div
                key={role.role}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background: "var(--bg-panel)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    flexShrink: 0,
                    minWidth: 62,
                    padding: "2px 6px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-subtle)",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textAlign: "center",
                  }}>
                    {role.tag ?? role.role.toUpperCase()}
                  </span>

                  <div style={{ minWidth: 0, flex: "0 0 auto", width: 128 }}>
                    <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{role.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                      {t(`roles.source.${role.source}`)}
                    </div>
                  </div>

                  <SearchableSelect
                    value={current}
                    disabled={pendingRole === role.role}
                    ariaLabel={role.name}
                    style={{ flex: 1, minWidth: 160 }}
                    onChange={(value) => {
                      if (!value) {
                        void assign(role.role, null);
                        return;
                      }
                      const selectedModel = models.find((model) => selectorFor(model) === value);
                      const supported = selectedModel
                        ? thinkingLevels[`${selectedModel.provider}:${selectedModel.id}`]
                        : undefined;
                      const preservedLevel = getModelRoleThinkingLevel(role.selector);
                      const nextLevel = getModelRoleThinkingOptions(supported).includes(preservedLevel)
                        ? preservedLevel
                        : "inherit";
                      void assign(role.role, formatModelRoleSelector(value, nextLevel));
                    }}
                    options={[
                      { value: "", label: t("roles.unset") },
                      ...models.map((model) => ({
                        value: selectorFor(model),
                        label: `${model.name} — ${model.provider}`,
                        searchText: selectorFor(model),
                      })),
                      ...current && !models.some((model) => selectorFor(model) === current)
                        ? [{ value: current, label: current }]
                        : [],
                    ]}
                  />

                  {role.warning && (
                    <span title={role.warning} style={{ color: "var(--warning, #ffb347)", fontSize: 12 }}>!</span>
                  )}
                </div>

                {role.resolved && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingLeft: 72 }}>
                    <span style={{ color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap" }}>
                      {t("roles.thinking")}
                    </span>
                    <div
                      role="group"
                      aria-label={`${role.name} ${t("roles.thinking")}`}
                      style={{
                        display: "flex",
                        flex: "1 1 auto",
                        minWidth: 0,
                        flexWrap: "wrap",
                        gap: 3,
                      }}
                    >
                      {thinkingOptions.map((level: ModelRoleThinkingLevel) => {
                        const active = currentThinkingLevel === level;
                        return (
                          <button
                            key={level}
                            type="button"
                            aria-pressed={active}
                            disabled={pendingRole === role.role}
                            title={level === "inherit" ? t("roles.thinkingInherit") : level}
                            onClick={() => {
                              if (active) return;
                              void assign(role.role, formatModelRoleSelector(current, level));
                            }}
                            style={{
                              padding: "3px 7px",
                              border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                              borderRadius: 4,
                              background: active ? "var(--bg-selected)" : "transparent",
                              color: active ? "var(--accent)" : "var(--text-muted)",
                              cursor: pendingRole === role.role ? "not-allowed" : "pointer",
                              fontFamily: "var(--font-mono)",
                              fontSize: 10,
                              fontWeight: active ? 700 : 500,
                              lineHeight: 1.2,
                              opacity: pendingRole === role.role ? 0.55 : 1,
                            }}
                          >
                            {level}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap", paddingLeft: 72 }}>
                  <span
                    title={t("roles.backupsHint")}
                    style={{ color: "var(--text-dim)", fontSize: 10, whiteSpace: "nowrap", paddingTop: 4 }}
                  >
                    {t("roles.backups")}
                  </span>

                  <label
                    title={backups.length === 0 ? t("roles.rotationNeedsPool") : t("roles.rotationHint")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                      paddingTop: 3,
                      fontSize: 10,
                      color: rotation.enabled && backups.length > 0 ? "var(--text-muted)" : "var(--text-dim)",
                      cursor: rotation.enabled && backups.length > 0 ? "pointer" : "not-allowed",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={rotation.roles[role.role] === true}
                      disabled={!rotation.enabled || backups.length === 0}
                      aria-label={`${role.name}: ${
                        rotation.roles[role.role] === true ? t("roles.rotationOff") : t("roles.rotationOn")
                      }`}
                      onChange={(event) => void writeRotation({ role: role.role, rotate: event.target.checked })}
                    />
                    ⟳
                  </label>

                  <div style={{ display: "flex", flex: "1 1 auto", minWidth: 0, flexWrap: "wrap", gap: 3, alignItems: "center" }}>
                    {backups.length === 0 && (
                      <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
                        {t("roles.backupsNone")}
                      </span>
                    )}
                    {backups.map((entry, index) => (
                      <span
                        key={`${entry}-${index}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          padding: "2px 4px 2px 6px",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          background: inherited ? "transparent" : "var(--bg-subtle)",
                          color: inherited ? "var(--text-dim)" : "var(--text-muted)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          opacity: busy ? 0.55 : 1,
                        }}
                      >
                        <span style={{ color: "var(--text-dim)" }}>{index + 1}.</span>
                        {entry}
                        {!inherited && (
                          <>
                            <button
                              type="button"
                              disabled={busy || index === 0}
                              title={t("roles.backupsUp")}
                              aria-label={`${t("roles.backupsUp")}: ${entry}`}
                              onClick={() => {
                                const next = [...backups];
                                const prev = next[index - 1];
                                const cur = next[index];
                                if (prev === undefined || cur === undefined) return;
                                next[index - 1] = cur;
                                next[index] = prev;
                                void writeChain(role.role, next);
                              }}
                              style={chipButtonStyle(busy || index === 0)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={busy || index === backups.length - 1}
                              title={t("roles.backupsDown")}
                              aria-label={`${t("roles.backupsDown")}: ${entry}`}
                              onClick={() => {
                                const next = [...backups];
                                const after = next[index + 1];
                                const cur = next[index];
                                if (after === undefined || cur === undefined) return;
                                next[index + 1] = cur;
                                next[index] = after;
                                void writeChain(role.role, next);
                              }}
                              style={chipButtonStyle(busy || index === backups.length - 1)}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              title={t("roles.backupsRemove")}
                              aria-label={`${t("roles.backupsRemove")}: ${entry}`}
                              onClick={() => void writeChain(role.role, backups.filter((_, i) => i !== index))}
                              style={chipButtonStyle(busy)}
                            >
                              ×
                            </button>
                          </>
                        )}
                      </span>
                    ))}

                    {inherited && backups.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        title={t("roles.backupsOverrideHint")}
                        onClick={() => void writeChain(role.role, backups)}
                        style={chipButtonStyle(busy, true)}
                      >
                        {t("roles.backupsInherited")} — {t("roles.backupsOverride")}
                      </button>
                    )}

                    {!inherited && chain?.configured !== undefined && (
                      <button
                        type="button"
                        disabled={busy}
                        title={t("roles.backupsResetHint")}
                        onClick={() => void writeChain(role.role, null)}
                        style={chipButtonStyle(busy, true)}
                      >
                        {t("roles.backupsReset")}
                      </button>
                    )}
                  </div>

                  <SearchableSelect
                    value=""
                    disabled={busy}
                    ariaLabel={`${role.name} — ${t("roles.backupsAdd")}`}
                    style={{ flex: "0 0 auto", width: 190 }}
                    onChange={(value) => {
                      if (!value) return;
                      // Editing an inherited chain forks it onto this role first,
                      // which is exactly what appending to it should mean.
                      void writeChain(role.role, [...backups, value]);
                    }}
                    options={[
                      { value: "", label: t("roles.backupsAdd") },
                      ...models
                        .filter((model) => !backups.includes(selectorFor(model)))
                        .map((model) => ({
                          value: selectorFor(model),
                          label: `${model.name} — ${model.provider}`,
                          searchText: selectorFor(model),
                        })),
                    ]}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
