"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModalityIcons } from "./ModalityIcons";
import { Field, NumInput, TextInput } from "./ui";
import type { ModelEntry } from "./types";

/**
 * Inline editor for one model row.
 *
 * What a save becomes is the caller's decision: an edit of a catalog row is
 * diffed into a `modelOverrides` patch, a `models.yml` definition is rewritten
 * in place, and a new row is appended as a definition. A new row types its id
 * here, because a definition without one is dropped when the file is saved.
 */

const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;

/** A blank or unparsable field is "not set", never NaN — the models.yml schema rejects it. */
function parseNumber(raw: string): number | undefined {
  const value = Number(raw);
  return raw.trim() && Number.isFinite(value) ? value : undefined;
}

export function ModelEditDrawer({ model, isNew = false, takenIds = [], showEfforts = false, onSave, onCancel }: {
  /** Values editing starts from. */
  model: ModelEntry;
  /** A row being created: its id is typed here and required. */
  isNew?: boolean;
  /** Ids the provider already serves, so a new row cannot shadow one of them. */
  takenIds?: readonly string[];
  /**
   * Offer the `thinkingLevelMap` effort checkboxes of an existing definition.
   * The SDK reads no such key on a catalog row, so the control stays off
   * wherever the save lands in an override.
   */
  showEfforts?: boolean;
  onSave: (next: ModelEntry) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ModelEntry>(model);
  const [id, setId] = useState(model.id);
  const map = draft.thinkingLevelMap ?? {};

  const toggleEffort = (level: (typeof EFFORT_LEVELS)[number]) => {
    const next = { ...map };
    if (level in next) delete next[level];
    else next[level] = level;
    setDraft({ ...draft, thinkingLevelMap: Object.keys(next).length > 0 ? next : undefined });
  };

  const trimmedId = id.trim();
  const idTaken = takenIds.includes(trimmedId);

  return (
    <div data-testid="model-edit-drawer" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, padding: "10px 12px", background: "var(--bg-elev, var(--bg-panel))", borderBottom: "1px solid var(--border)" }}>
      {isNew && (
        <Field label={t("models.modelId")}>
          <TextInput value={id} onChange={setId} placeholder="model-id" mono />
          {idTaken && (
            <span role="alert" style={{ fontSize: 11, color: "var(--danger, #f85149)" }}>{t("models.modelIdTaken")}</span>
          )}
        </Field>
      )}
      <Field label="Name">
        <TextInput value={draft.name ?? ""} onChange={(v) => setDraft({ ...draft, name: v || undefined })} placeholder="Display name" />
      </Field>
      <Field label="contextWindow">
        <NumInput value={draft.contextWindow !== undefined ? String(draft.contextWindow) : ""}
          onChange={(v) => setDraft({ ...draft, contextWindow: parseNumber(v) })} placeholder="128000" />
      </Field>
      <Field label="maxTokens">
        <NumInput value={draft.maxTokens !== undefined ? String(draft.maxTokens) : ""}
          onChange={(v) => setDraft({ ...draft, maxTokens: parseNumber(v) })} placeholder="16384" />
      </Field>
      <Field label="cost.in $/M">
        <NumInput value={draft.cost?.input !== undefined ? String(draft.cost.input) : ""}
          onChange={(v) => setDraft({ ...draft, cost: { ...(draft.cost ?? {}), input: parseNumber(v) } })} placeholder="0" />
      </Field>
      <Field label="cost.out $/M">
        <NumInput value={draft.cost?.output !== undefined ? String(draft.cost.output) : ""}
          onChange={(v) => setDraft({ ...draft, cost: { ...(draft.cost ?? {}), output: parseNumber(v) } })} placeholder="0" />
      </Field>
      <Field label={t("models.modalityLabel")}>
        <ModalityIcons input={draft.input} onChange={(input) => setDraft({ ...draft, input })} />
      </Field>
      {showEfforts && (
        <Field label={t("models.thinkingEfforts")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {EFFORT_LEVELS.map((level) => (
              <label key={level} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
                <input type="checkbox" checked={level in map} onChange={() => toggleEffort(level)} />
                {level}
              </label>
            ))}
          </div>
        </Field>
      )}
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" onClick={() => onSave(isNew ? { ...draft, id: trimmedId } : draft)}
          disabled={isNew && (!trimmedId || idTaken)}
          style={{ padding: "5px 14px", background: isNew && (!trimmedId || idTaken) ? "var(--bg-panel)" : "var(--accent)", border: "none", borderRadius: 5, color: isNew && (!trimmedId || idTaken) ? "var(--text-dim)" : "#fff", cursor: isNew && (!trimmedId || idTaken) ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600 }}>
          {t("i18n.save")}
        </button>
        <button type="button" onClick={onCancel}
          style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
          {t("i18n.cancel")}
        </button>
        {isNew && !trimmedId && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("models.modelIdRequired")}</span>
        )}
      </div>
    </div>
  );
}
