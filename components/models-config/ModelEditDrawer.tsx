"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModalityIcons } from "./ModalityIcons";
import { Field, NumInput, TextInput } from "./ui";
import type { ModelEntry } from "./types";

/**
 * Inline editor for one model row.
 *
 * Saves into the `models.yml` provider entry, which omp merges over the
 * catalog model with the same key — so editing a catalog row here creates an
 * override instead of pretending the catalog changed.
 */

const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;

export function ModelEditDrawer({ model, onSave, onCancel }: {
  model: ModelEntry;
  onSave: (next: ModelEntry) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ModelEntry>(model);
  const map = draft.thinkingLevelMap ?? {};

  const toggleEffort = (level: (typeof EFFORT_LEVELS)[number]) => {
    const next = { ...map };
    if (level in next) delete next[level];
    else next[level] = level;
    setDraft({ ...draft, thinkingLevelMap: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <div data-testid="model-edit-drawer" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, padding: "10px 12px", background: "var(--bg-elev, var(--bg-panel))", borderBottom: "1px solid var(--border)" }}>
      <Field label="Name">
        <TextInput value={draft.name ?? ""} onChange={(v) => setDraft({ ...draft, name: v || undefined })} placeholder="Display name" />
      </Field>
      <Field label="contextWindow">
        <NumInput value={draft.contextWindow !== undefined ? String(draft.contextWindow) : ""}
          onChange={(v) => setDraft({ ...draft, contextWindow: v ? parseInt(v) : undefined })} placeholder="128000" />
      </Field>
      <Field label="maxTokens">
        <NumInput value={draft.maxTokens !== undefined ? String(draft.maxTokens) : ""}
          onChange={(v) => setDraft({ ...draft, maxTokens: v ? parseInt(v) : undefined })} placeholder="16384" />
      </Field>
      <Field label="cost.in $/M">
        <NumInput value={draft.cost?.input !== undefined ? String(draft.cost.input) : ""}
          onChange={(v) => setDraft({ ...draft, cost: { ...(draft.cost ?? {}), input: v ? parseFloat(v) : undefined } })} placeholder="0" />
      </Field>
      <Field label="cost.out $/M">
        <NumInput value={draft.cost?.output !== undefined ? String(draft.cost.output) : ""}
          onChange={(v) => setDraft({ ...draft, cost: { ...(draft.cost ?? {}), output: v ? parseFloat(v) : undefined } })} placeholder="0" />
      </Field>
      <Field label={t("models.modalityLabel")}>
        <ModalityIcons input={draft.input} onChange={(input) => setDraft({ ...draft, input })} />
      </Field>
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
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
        <button type="button" onClick={() => onSave(draft)}
          style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
          {t("i18n.save")}
        </button>
        <button type="button" onClick={onCancel}
          style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
          {t("i18n.cancel")}
        </button>
      </div>
    </div>
  );
}