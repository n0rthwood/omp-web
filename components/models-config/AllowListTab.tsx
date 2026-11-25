"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useI18n } from "@/hooks/useI18n";
import { fuzzyMatch, highlightSegments } from "./fuzzy";
import { HealthBadge } from "./HealthBadge";
import { modelHealthKey, modelSelector, type ModelHealthMap, type ModelOption } from "./types";

interface AllowListResponse {
  patterns?: string[];
  warnings?: string[];
  projectOverride?: boolean;
  error?: string;
}

/**
 * Tab 2 — the `enabledModels` allow-list.
 *
 * Patterns are chips instead of a textarea, and the picker below searches every
 * provider/model with substring-then-subsequence matching (`q4m` finds
 * `qwen4-max-preview`). Writes still go through
 * `GET/PUT /api/model-roles/allow-list`, so the stored format is unchanged.
 */
export function AllowListTab({ cwd, models, health, onSaved, onSync }: {
  cwd: string | null;
  models: readonly ModelOption[];
  health?: ModelHealthMap;
  onSaved?: () => void;
  onSync: () => void;
}) {
  const { t } = useI18n();
  const [patterns, setPatterns] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [projectOverride, setProjectOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const cwdQuery = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";

  useEffect(() => {
    if (!cwd) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(apiPath(`/api/model-roles/allow-list${cwdQuery}`), { signal: controller.signal });
        const data = await res.json() as AllowListResponse;
        if (data.error) throw new Error(data.error);
        setPatterns(data.patterns ?? []);
        setWarnings(data.warnings ?? []);
        setProjectOverride(data.projectOverride === true);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd, cwdQuery]);

  const save = useCallback(async (next: string[]) => {
    if (!cwd) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(apiPath("/api/model-roles/allow-list"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, patterns: next }),
      });
      const data = await res.json() as AllowListResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setPatterns(data.patterns ?? []);
      setWarnings(data.warnings ?? []);
      setProjectOverride(data.projectOverride === true);
      setSavedOk(true);
      onSaved?.();
      setTimeout(() => setSavedOk(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [cwd, onSaved]);

  const patternSet = useMemo(() => new Set(patterns), [patterns]);

  const groups = useMemo(() => {
    const needle = query.trim();
    if (!needle) return [];
    const byProvider = new Map<string, { model: ModelOption; selector: string; indices: number[]; score: number }[]>();
    for (const model of models) {
      const selector = modelSelector(model.provider, model.id);
      const match = fuzzyMatch(selector, needle);
      if (!match.hit) continue;
      const list = byProvider.get(model.provider) ?? [];
      list.push({ model, selector, indices: match.indices, score: match.score });
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()]
      .map(([provider, hits]) => ({ provider, hits: hits.sort((a, b) => b.score - a.score || a.selector.localeCompare(b.selector)) }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [models, query]);

  const matchCount = groups.reduce((total, group) => total + group.hits.length, 0);

  if (!cwd) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("i18n.openSessionToReload")}</div>;
  }

  const togglePattern = (pattern: string) => {
    const next = patternSet.has(pattern) ? patterns.filter((entry) => entry !== pattern) : [...patterns, pattern];
    void save(next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <p style={{ flex: 1, margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("i18n.modelAllowListHint")}
        </p>
        <button type="button" onClick={onSync} style={syncButtonStyle}>{t("models.syncAllowList")}</button>
      </div>

      {projectOverride && (
        <div style={{ fontSize: 11, color: "var(--warning, #f59e0b)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", lineHeight: 1.6 }}>
          {t("i18n.modelAllowListProjectOverride")}
        </div>
      )}

      {error && <div style={{ fontSize: 11, color: "var(--danger, #f87171)" }}>{error}</div>}

      <div data-testid="allow-list-chips" style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 10, background: "var(--bg-elev, var(--bg-panel))", border: "1px solid var(--border)", borderRadius: 8, minHeight: 52 }}>
        {loading ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</span>
        ) : patterns.length === 0 ? (
          <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{t("i18n.modelAllowListEmpty")}</span>
        ) : patterns.map((pattern) => {
          const wildcard = pattern.includes("*");
          return (
            <span key={pattern} data-testid="allow-list-chip"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 6px 3px 9px",
                borderRadius: 999,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                background: wildcard ? "rgba(210,153,34,0.13)" : "rgba(31,111,235,0.13)",
                border: `1px solid ${wildcard ? "rgba(210,153,34,0.4)" : "rgba(47,129,247,0.33)"}`,
                color: wildcard ? "var(--warning, #e3b341)" : "var(--accent)",
              }}>
              {pattern}
              <button type="button" disabled={saving} onClick={() => togglePattern(pattern)} aria-label={`${t("i18n.delete")} ${pattern}`}
                style={{ background: "transparent", border: "none", color: "inherit", opacity: 0.7, fontSize: 13, lineHeight: 1, padding: "0 2px", cursor: saving ? "default" : "pointer" }}>
                ×
              </button>
            </span>
          );
        })}
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("models.searchModelsPlaceholder")}
        aria-label={t("models.searchModels")}
        data-testid="allow-list-search"
        style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, padding: "9px 12px", fontSize: 13.5, color: "var(--text)", outline: "none", boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--text-dim)", fontSize: 11.5 }}>
        <span>{query.trim() ? t("models.searchMatchCount", { count: matchCount }) : t("models.searchHint")}</span>
        {savedOk && <span style={{ color: "var(--success, #3fb950)" }}>{t("i18n.saved")}</span>}
      </div>

      <div data-testid="allow-list-results" style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", maxHeight: "44vh", overflowY: "auto" }}>
        {groups.length === 0 ? (
          <div style={{ padding: 14, color: "var(--text-dim)", fontSize: 12.5 }}>
            {query.trim() ? t("models.searchNoMatches", { query: query.trim() }) : t("models.searchHint")}
          </div>
        ) : groups.map((group) => {
          const wildcard = `${group.provider}/*`;
          const allSelected = patternSet.has(wildcard);
          return (
            <div key={group.provider}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "var(--bg-elev, var(--bg-panel))", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)" }}>{group.provider}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("models.searchGroupCount", { count: group.hits.length })}</span>
                <span style={{ flex: 1 }} />
                <button type="button" disabled={saving} onClick={() => togglePattern(wildcard)}
                  style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 999, padding: "2px 9px", fontSize: 11, color: "var(--text-muted)", cursor: saving ? "default" : "pointer" }}>
                  {allSelected ? t("models.searchGroupAllSelected") : t("models.searchGroupSelectAll")}
                </button>
              </div>
              {group.hits.map(({ model, selector, indices }) => {
                const selected = patternSet.has(selector) || allSelected;
                return (
                  <button
                    key={selector}
                    type="button"
                    data-testid="allow-list-result"
                    disabled={saving}
                    onClick={() => togglePattern(selector)}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "6px 12px", background: selected ? "rgba(47,129,247,0.08)" : "none", border: "none", borderBottom: "1px solid var(--border)", cursor: saving ? "default" : "pointer", textAlign: "left" }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`, background: selected ? "var(--accent)" : "transparent", color: "#0d1117", fontSize: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {selected ? "✓" : ""}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {highlightSegments(selector, indices).map((segment, index) => (
                        segment.marked
                          ? <mark key={index} style={{ background: "rgba(47,129,247,0.2)", color: "var(--accent)", borderRadius: 2 }}>{segment.text}</mark>
                          : <span key={index}>{segment.text}</span>
                      ))}
                    </span>
                    <HealthBadge health={health?.[modelHealthKey(model.provider, model.id)]} />
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {warnings.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--warning, #f59e0b)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{warnings.join("\n")}</div>
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