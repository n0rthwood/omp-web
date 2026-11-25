"use client";

import { Fragment, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { changedModelFields, toModelDefinition } from "./model-override";
import { HealthBadge } from "./HealthBadge";
import { ModelEditDrawer } from "./ModelEditDrawer";
import { ModalityIcons } from "./ModalityIcons";
import type { ModelRow } from "./provider-model-rows";
import { modelHealthKey, type ModelEntry, type ModelHealthMap, type ModelOverridePatch } from "./types";

const SOURCE_LABEL_KEYS: Record<ModelRow["source"], string> = {
  catalog: "models.sourceCatalog",
  config: "models.sourceConfig",
  merged: "models.sourceMerged",
};

const COLUMN_KEYS = [
  "models.modelId",
  "models.sourceColumn",
  "models.contextWindow",
  "models.maxTokens",
  "models.inputModality",
  "models.thinking",
  "models.costColumn",
  "models.statusColumn",
  "models.actionsColumn",
];

const CELL_STYLE = { padding: "4px 10px", borderBottom: "1px solid var(--border)" } as const;

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Which efforts the row offers: a definition's own map, else what the registry supports. */
function thinkingLabel(row: ModelRow, none: string): string {
  if (!row.entry.reasoning) return "—";
  if (row.entry.thinkingLevelMap) return Object.keys(row.entry.thinkingLevelMap).join("·");
  return row.efforts?.length ? row.efforts.join("·") : none;
}

/**
 * The lower half of the provider detail: every model this provider serves,
 * with inline modality toggles, a per-row edit drawer, and the entry that
 * appends a custom definition.
 *
 * Saving a catalog row writes a `modelOverrides` patch holding only the fields
 * that changed, so the rest of the row keeps following the catalog; a
 * `models.yml` definition is rewritten in place. Either way there is exactly
 * one models.yml write path, the panel's own Save button.
 */
export function ProviderModelTable({ providerName, rows, health, canAddModel, addModelBlockedReason, onUpdateModel, onOverrideModel, onCreateModel }: {
  providerName: string;
  rows: readonly ModelRow[];
  health?: ModelHealthMap;
  /** Whether a new definition can be appended to this provider's `models` entry. */
  canAddModel: boolean;
  /** Why it cannot, shown on the disabled control. */
  addModelBlockedReason?: string;
  onUpdateModel: (index: number, model: ModelEntry) => void;
  onOverrideModel: (modelId: string, changed: ModelOverridePatch) => void;
  onCreateModel: (model: ModelEntry) => void;
}) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // A definition is rewritten in place; a catalog row becomes a sparse override.
  const writeEntry = (row: ModelRow, next: ModelEntry) => {
    if (row.configIndex !== null) onUpdateModel(row.configIndex, toModelDefinition(next));
    else onOverrideModel(row.id, changedModelFields(row.entry, next));
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {COLUMN_KEYS.map((key) => (
              <th key={key} style={{ textAlign: "left", fontWeight: 600, color: "var(--text-muted)", fontSize: 11, padding: "6px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !adding && (
            <tr>
              <td colSpan={9} style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
                {t("models.noModels")}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const editing = editingId === row.id;
            const modelHealth = health?.[modelHealthKey(providerName, row.id)];
            const cost = row.entry.cost;
            return (
              <Fragment key={row.id}>
                <tr data-testid="provider-model-row" data-model-id={row.id} style={{ background: editing ? "var(--bg-hover)" : undefined }}>
                  <td style={{ ...CELL_STYLE, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{row.id}</td>
                  <td style={CELL_STYLE}>
                    <span style={{ fontSize: 11, color: row.source === "merged" ? "var(--accent)" : "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                      {t(SOURCE_LABEL_KEYS[row.source])}
                    </span>
                  </td>
                  <td style={{ ...CELL_STYLE, fontFamily: "var(--font-mono)" }}>{formatTokens(row.entry.contextWindow)}</td>
                  <td style={{ ...CELL_STYLE, fontFamily: "var(--font-mono)" }}>{formatTokens(row.entry.maxTokens)}</td>
                  <td style={CELL_STYLE}>
                    <ModalityIcons
                      input={row.entry.input}
                      onChange={(input) => writeEntry(row, { ...row.entry, input })}
                    />
                  </td>
                  <td style={{ ...CELL_STYLE, fontFamily: "var(--font-mono)" }}>{thinkingLabel(row, t("models.thinkingDefault"))}</td>
                  <td style={{ ...CELL_STYLE, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                    {cost ? `${cost.input ?? 0} / ${cost.output ?? 0}` : "—"}
                  </td>
                  <td style={CELL_STYLE}>
                    <HealthBadge health={modelHealth} />
                  </td>
                  <td style={CELL_STYLE}>
                    <button type="button" data-testid="model-edit-button" onClick={() => { setAdding(false); setEditingId(editing ? null : row.id); }}
                      style={{ padding: "0 6px", height: 22, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>
                      {t("models.edit")}
                    </button>
                  </td>
                </tr>
                {editing && (
                  <tr>
                    <td colSpan={9} style={{ padding: 0 }}>
                      <ModelEditDrawer
                        model={row.entry}
                        showEfforts={row.configIndex !== null}
                        onCancel={() => setEditingId(null)}
                        onSave={(next) => { writeEntry(row, next); setEditingId(null); }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {adding && (
            <tr data-testid="model-add-row">
              <td colSpan={9} style={{ padding: 0 }}>
                <ModelEditDrawer
                  isNew
                  model={{ id: "" }}
                  takenIds={rows.map((row) => row.id)}
                  onCancel={() => setAdding(false)}
                  onSave={(next) => { onCreateModel(toModelDefinition(next)); setAdding(false); }}
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div style={{ padding: "6px 10px", borderTop: "1px solid var(--border)" }}>
        <button type="button" data-testid="add-model-button" disabled={!canAddModel} title={canAddModel ? undefined : addModelBlockedReason}
          onClick={() => { setEditingId(null); setAdding(true); }}
          style={{ padding: "3px 10px", background: "none", border: "1px dashed var(--border)", borderRadius: 5, color: canAddModel ? "var(--text-muted)" : "var(--text-dim)", cursor: canAddModel ? "pointer" : "not-allowed", fontSize: 11.5 }}>
          + {t("i18n.model")}
        </button>
      </div>
    </div>
  );
}
