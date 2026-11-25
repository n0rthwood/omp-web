"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelRoleAssignment, ModelRoleScope, RoleFallbackChain } from "@/lib/api-types";
import { apiPath } from "@/lib/api-path";
import {
  formatModelRoleSelector,
  getModelRoleThinkingLevel,
  getModelRoleThinkingOptions,
} from "@/lib/model-role-selection";
import { useI18n } from "@/hooks/useI18n";
import { FallbackChainEditor } from "./FallbackChainEditor";
import { HealthBadge } from "./HealthBadge";
import { ModelSearchSelect } from "./ModelSearchSelect";
import { modelSelector, type ModelHealthMap, type ModelOption } from "./types";

interface ModelsResponse {
  modelList?: ModelOption[];
  thinkingLevels?: Record<string, string[]>;
}

const SCOPES: ModelRoleScope[] = ["global", "project"];

/**
 * Tab 1 — which model each of omp's roles uses.
 *
 * Writing goes through the same endpoints the old panel used:
 * `PUT /api/model-roles` for the assignment (selector includes the `:level`
 * suffix) and `PUT /api/model-roles/fallbacks` for the chain, so a role set
 * here is what the next terminal session uses too.
 */
export function RolesTab({ cwd, health, onModelsChanged, onSync }: {
  cwd: string | null;
  health?: ModelHealthMap;
  onModelsChanged?: () => void;
  onSync: () => void;
}) {
  const { t } = useI18n();
  const [roles, setRoles] = useState<ModelRoleAssignment[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<Record<string, string[]>>({});
  const [scope, setScope] = useState<ModelRoleScope>("global");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [rotation, setRotation] = useState<{ enabled: boolean; roles: Record<string, boolean> }>({ enabled: false, roles: {} });
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
      const rolesData = await rolesRes.json() as { roles?: ModelRoleAssignment[]; fallbackChains?: RoleFallbackChain[]; error?: string };
      if (rolesData.error) throw new Error(rolesData.error);
      if (!modelsRes.ok) throw new Error(`HTTP ${modelsRes.status}`);
      const modelsData = await modelsRes.json() as ModelsResponse;
      setRoles(rolesData.roles ?? []);
      setChains(rolesData.fallbackChains ?? []);
      setModels(modelsData.modelList ?? []);
      setThinkingLevels(modelsData.thinkingLevels ?? {});
      if (rotationRes.ok) {
        const rotationData = await rotationRes.json() as { rotation?: { enabled?: boolean; roles?: Record<string, boolean> } };
        setRotation({ enabled: rotationData.rotation?.enabled === true, roles: rotationData.rotation?.roles ?? {} });
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
      const data = await res.json() as { rotation?: { enabled?: boolean; roles?: Record<string, boolean> }; error?: string };
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
      onModelsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingRole(null);
    }
  }, [cwd, onModelsChanged, scope]);

  /**
   * `chain: null` drops the role's key so omp's `default` chain covers it
   * again; `[]` persists "no backups", which omp treats as a real value.
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
      const data = await res.json() as { roles?: ModelRoleAssignment[]; fallbackChains?: RoleFallbackChain[]; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRoles(data.roles ?? []);
      setChains(data.fallbackChains ?? []);
      onModelsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingRole(null);
    }
  }, [cwd, onModelsChanged]);

  const chainByRole = useMemo(() => {
    const byRole: Record<string, RoleFallbackChain> = {};
    for (const entry of chains) byRole[entry.role] = entry;
    return byRole;
  }, [chains]);

  if (!cwd) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("roles.needsProject")}</div>;
  }

  const visibleRoles = roles.filter((role) => !role.hidden);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <p style={{ flex: 1, margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("roles.description")}
        </p>
        <button type="button" onClick={onSync} style={syncButtonStyle}>{t("models.syncRoles")}</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("roles.scope")}</span>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {SCOPES.map((option) => (
            <button key={option} type="button" onClick={() => setScope(option)}
              style={{
                padding: "4px 10px",
                border: "none",
                background: scope === option ? "var(--bg-selected)" : "transparent",
                color: scope === option ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: scope === option ? 600 : 400,
              }}>
              {option === "global" ? t("roles.scopeGlobal") : t("roles.scopeProject")}
            </button>
          ))}
        </div>
        <label title={t("roles.rotationHint")} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
          <input type="checkbox" checked={rotation.enabled} onChange={(event) => void writeRotation({ enabled: event.target.checked })} />
          {t("roles.rotation")}
        </label>
      </div>

      {error && <div style={{ fontSize: 12, color: "var(--danger, #ff4757)" }}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              {["roles.role", "roles.currentModel", "roles.thinking", "roles.backups", "roles.sourceColumn"].map((key) => (
                <th key={key} style={{ textAlign: "left", fontWeight: 600, color: "var(--text-muted)", fontSize: 11.5, padding: "7px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRoles.map((role) => {
              const current = role.resolved ? `${role.resolved.provider}/${role.resolved.modelId}` : "";
              const currentThinkingLevel = getModelRoleThinkingLevel(role.selector);
              const thinkingKey = role.resolved ? `${role.resolved.provider}:${role.resolved.modelId}` : "";
              const thinkingOptions = getModelRoleThinkingOptions(thinkingLevels[thinkingKey]);
              const chain = chainByRole[role.role];
              const backups = chain?.effective ?? [];
              const busy = pendingRole === role.role;
              const currentHealth = current ? health?.[current] : undefined;
              return (
                <tr key={role.role}>
                  <td style={{ width: 150, padding: "8px 10px", borderBottom: "1px solid var(--border)", verticalAlign: "top" }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--text)" }}>{role.role}</div>
                    <div style={{ color: "var(--text-dim)", fontSize: 11.5 }}>{role.name}</div>
                  </td>
                  <td style={{ width: 300, padding: "8px 10px", borderBottom: "1px solid var(--border)", verticalAlign: "top" }}>
                    <ModelSearchSelect
                      value={current}
                      models={models}
                      health={health}
                      allowUnset
                      disabled={busy}
                      ariaLabel={role.name}
                      onChange={(value) => {
                        if (!value) { void assign(role.role, null); return; }
                        const selected = models.find((model) => modelSelector(model.provider, model.id) === value);
                        const supported = selected ? thinkingLevels[`${selected.provider}:${selected.id}`] : undefined;
                        const nextLevel = getModelRoleThinkingOptions(supported).includes(currentThinkingLevel) ? currentThinkingLevel : "inherit";
                        void assign(role.role, formatModelRoleSelector(value, nextLevel));
                      }}
                    />
                    <div style={{ marginTop: 4 }}>
                      <HealthBadge health={currentHealth} />
                    </div>
                    {currentHealth?.cause && (
                      <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--danger, #f85149)" }}>
                        {t("models.healthDisabled")}: {currentHealth.cause}
                      </div>
                    )}
                    {role.warning && (
                      <div title={role.warning} style={{ marginTop: 3, fontSize: 11, color: "var(--warning, #ffb347)" }}>{role.warning}</div>
                    )}
                  </td>
                  <td style={{ width: 110, padding: "8px 10px", borderBottom: "1px solid var(--border)", verticalAlign: "top", fontFamily: "var(--font-mono)" }}>
                    {role.resolved ? (
                      <div role="group" aria-label={`${role.name} ${t("roles.thinking")}`} style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                        {thinkingOptions.map((level) => {
                          const active = currentThinkingLevel === level;
                          return (
                            <button key={level} type="button" aria-pressed={active} disabled={busy}
                              title={level === "inherit" ? t("roles.thinkingInherit") : level}
                              onClick={() => { if (!active) void assign(role.role, formatModelRoleSelector(current, level)); }}
                              style={{
                                padding: "3px 7px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 4,
                                background: active ? "var(--bg-selected)" : "transparent",
                                color: active ? "var(--accent)" : "var(--text-muted)",
                                cursor: busy ? "not-allowed" : "pointer",
                                fontSize: 10,
                                fontWeight: active ? 700 : 500,
                                lineHeight: 1.2,
                                opacity: busy ? 0.55 : 1,
                              }}>
                              {level}
                            </button>
                          );
                        })}
                      </div>
                    ) : <span style={{ color: "var(--text-dim)" }}>—</span>}
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", verticalAlign: "top" }}>
                    {rotation.enabled && backups.length > 0 && (
                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-muted)", marginBottom: 4, cursor: "pointer" }}>
                        <input type="checkbox" checked={rotation.roles[role.role] === true}
                          aria-label={`${role.name}: ${rotation.roles[role.role] === true ? t("roles.rotationOff") : t("roles.rotationOn")}`}
                          onChange={(event) => void writeRotation({ role: role.role, rotate: event.target.checked })} />
                        ⟳ {t("roles.rotation")}
                      </label>
                    )}
                    <FallbackChainEditor
                      chain={backups}
                      models={models}
                      health={health}
                      inherited={chain?.inherited ?? false}
                      configured={chain?.configured}
                      busy={busy}
                      roleLabel={role.name}
                      onChange={(next) => void writeChain(role.role, next)}
                    />
                  </td>
                  <td style={{ width: 90, padding: "8px 10px", borderBottom: "1px solid var(--border)", verticalAlign: "top" }}>
                    <span style={{ fontSize: 11, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {t(`roles.source.${role.source}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const syncButtonStyle: React.CSSProperties = {
  flex: "none",
  marginTop: -2,
  padding: "4px 10px",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11.5,
};