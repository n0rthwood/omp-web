"use client";

import { Fragment, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { HealthBadge } from "./HealthBadge";
import { ModelEditDrawer } from "./ModelEditDrawer";
import { ModalityIcons } from "./ModalityIcons";
import { modelHealthKey, type ModelEntry, type ModelHealthMap } from "./types";

/** One row of a provider's model table, merged from catalog + models.yml. */
export interface ModelRow {
  id: string;
  /** Where the row's values come from after the merge. */
  source: "catalog" | "config" | "merged";
  /** Index in the provider's `models` array, or null for a catalog-only row. */
  configIndex: number | null;
  /** Config entry to edit; a catalog-only row starts from `{ id }`. */
  entry: ModelEntry;
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelEntry["cost"];
  reasoning?: boolean;
}

const SOURCE_LABEL_KEYS: Record<ModelRow["source"], string> = {
  catalog: "models.sourceCatalog",
  config: "models.sourceConfig",
  merged: "models.sourceMerged",
};

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * The lower half of the provider detail: every model this provider serves,
 * with inline modality toggles and a per-row edit drawer.
 *
 * Toggling a modality or saving the drawer writes a `models.yml` entry for that
 * model key, which omp merges over the catalog model — the same mechanism the
 * rest of the panel uses, so no second configuration path is introduced.
 */
export function ProviderModelTable({ providerName, rows, health, onUpdateModel, onAddModel, canAddModel }: {
  providerName: string;
  rows: readonly ModelRow[];
  health?: ModelHealthMap;
  onUpdateModel: (index: number, model: ModelEntry) => void;
  onAddModel: () => void;
  canAddModel: boolean;
}) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);

  const writeEntry = (row: ModelRow, entry: ModelEntry) => {
    if (row.configIndex === null) return;
    onUpdateModel(row.configIndex, entry);
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {["models.modelId", "models.sourceColumn", "models.contextWindow", "models.maxTokens", "models.inputModality", "models.thinking", "models.costColumn", "models.statusColumn", "models.actionsColumn"].map((key) => (
              <th key={key} style={{ textAlign: "left", fontWeight: 600, color: "var(--text-muted)", fontSize: 11, padding: "6px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
                {t("models.noModels")}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const editing = editingId === row.id;
            const modelHealth = health?.[modelHealthKey(providerName, row.id)];
            const cost = row.cost;
            return (
              <Fragment key={row.id}>
                <tr key={row.id} style={{ background: editing ? "var(--bg-hover)" : undefined }}>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{row.id}</td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 11, color: row.source === "merged" ? "var(--accent)" : "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {t(SOURCE_LABEL_KEYS[row.source])}
                    </span>
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)" }}>{formatTokens(row.contextWindow)}</td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)" }}>{formatTokens(row.maxTokens)}</td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)" }}>
                    <ModalityIcons
                      input={row.entry.input}
                      disabled={row.configIndex === null}
                      onChange={(input) => writeEntry(row, { ...row.entry, input })}
                    />
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)" }}>
                    {row.reasoning ? (row.entry.thinkingLevelMap ? Object.keys(row.entry.thinkingLevelMap).join("·") : t("models.thinkingDefault")) : "—"}
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                    {cost ? `${cost.input ?? 0} / ${cost.output ?? 0}` : "—"}
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)" }}>
                    <HealthBadge health={modelHealth} />
                  </td>
                  <td style={{ padding: "4px 10px", borderBottom: "1px solid var(--border)" }}>
                    <button type="button" onClick={() => setEditingId(editing ? null : row.id)}
                      style={{ padding: "0 6px", height: 22, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>
                      {t("models.edit")}
                    </button>
                  </td>
                </tr>
                {editing && (
                  <tr key={`${row.id}-drawer`}>
                    <td colSpan={9} style={{ padding: 0 }}>
                      <ModelEditDrawer
                        model={row.entry}
                        onCancel={() => setEditingId(null)}
                        onSave={(next) => { writeEntry(row, next); setEditingId(null); }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {canAddModel && (
        <div style={{ padding: "6px 10px", borderTop: "1px solid var(--border)" }}>
          <button type="button" onClick={onAddModel}
            style={{ padding: "3px 10px", background: "none", border: "1px dashed var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11.5 }}>
            + {t("i18n.model")}
          </button>
        </div>
      )}
    </div>
  );
}