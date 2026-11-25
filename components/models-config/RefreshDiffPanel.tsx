"use client";

import { useI18n } from "@/hooks/useI18n";
import type { ProviderModelDiff } from "@/lib/models-config-diff";
import type { ProviderRefreshState } from "./types";

/**
 * Structured result of "refresh models" for one provider.
 *
 * Replaces the bare "refresh completed" line: the route diffs the registry
 * snapshot taken before and after the refresh, so a provider that dropped a
 * model or changed a context window says so instead of looking like a no-op.
 */

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.join(" + ") || "—";
  if (typeof value === "number") {
    if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
    return String(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const FIELD_LABEL_KEYS: Record<string, string> = {
  name: "models.diffField.name",
  contextWindow: "models.diffField.contextWindow",
  maxTokens: "models.diffField.maxTokens",
  input: "models.diffField.input",
  reasoning: "models.diffField.reasoning",
  cost: "models.diffField.cost",
};

export function RefreshDiffPanel({ state, providerName }: {
  state: ProviderRefreshState;
  providerName: string;
}) {
  const { t } = useI18n();
  if (state.phase === "idle" || state.providerName !== providerName) return null;

  if (state.phase === "loading") {
    return <div role="status" style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("models.refreshingProvider")}</div>;
  }

  if (state.phase === "error") {
    return (
      <div role="alert" style={{ padding: "7px 9px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", fontSize: 11, lineHeight: 1.4 }}>
        {state.message}
      </div>
    );
  }

  const diff: ProviderModelDiff | undefined = state.diff;
  const changedCount = diff?.changed.length ?? 0;
  const addedCount = diff?.added.length ?? 0;
  const removedCount = diff?.removed.length ?? 0;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
        <b style={{ fontSize: 11.5, color: "var(--text)" }}>{t("models.diffTitle")}</b>
        <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("models.diffCounts", { added: addedCount, removed: removedCount, changed: changedCount })}</span>
      </div>
      <div style={{ padding: "6px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        {state.warning && (
          <div style={{ fontSize: 11, color: "var(--warning, #d29922)", lineHeight: 1.4 }}>{state.warning}</div>
        )}
        {diff && (addedCount > 0 || removedCount > 0 || changedCount > 0) ? (
          <>
            {addedCount > 0 && (
              <div>
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginBottom: 2 }}>{t("models.diffAdded")}</div>
                {diff!.added.map((entry) => (
                  <div key={entry.id} style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--success, #3fb950)" }}>+ {entry.id}</div>
                ))}
              </div>
            )}
            {removedCount > 0 && (
              <div>
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginBottom: 2 }}>{t("models.diffRemoved")}</div>
                {diff!.removed.map((entry) => (
                  <div key={entry.id} style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--danger, #f85149)", textDecoration: "line-through" }}>− {entry.id}</div>
                ))}
              </div>
            )}
            {changedCount > 0 && (
              <div>
                <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginBottom: 2 }}>{t("models.diffChanged")}</div>
                {diff!.changed.map((entry) => (
                  <div key={entry.id} style={{ marginBottom: 3 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text)" }}>{entry.id}</div>
                    {entry.fields.map((field) => (
                      <div key={field.field} style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 10 }}>
                        {t(FIELD_LABEL_KEYS[field.field] ?? "models.diffField.other", { field: field.field })}
                        {" "}
                        <span style={{ color: "var(--text-dim)", textDecoration: "line-through" }}>{formatValue(field.before)}</span>
                        {" → "}
                        <span style={{ color: "var(--accent)" }}>{formatValue(field.after)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {diff ? t("models.diffNone") : t("models.diffUnavailable")}
          </div>
        )}
      </div>
    </div>
  );
}