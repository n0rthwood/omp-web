"use client";

import { useI18n } from "@/hooks/useI18n";
import type { ModelHealth, ModelHealthState } from "./types";

/**
 * Availability dot for a model or provider row.
 *
 * Health comes from the background scanner (`modelHealth`, keyed
 * `provider/modelId`); when it has no entry for a model the row reads
 * "unverified" rather than claiming the model works.
 */

const STATE_COLORS: Record<ModelHealthState | "missing" | "expiring", string> = {
  ok: "var(--success, #3fb950)",
  disabled: "var(--danger, #f85149)",
  unverified: "var(--text-dim)",
  missing: "var(--danger, #f85149)",
  expiring: "var(--warning, #d29922)",
};

const STATE_LABEL_KEYS: Record<ModelHealthState | "missing" | "expiring", string> = {
  ok: "models.healthOk",
  disabled: "models.healthDisabled",
  unverified: "models.healthUnverified",
  missing: "models.healthMissing",
  expiring: "models.healthExpiring",
};

export function HealthBadge({ health, label, title }: {
  health?: ModelHealth;
  label?: string;
  title?: string;
}) {
  const { t } = useI18n();
  const state = health?.state ?? "unverified";
  const text = label ?? (health?.cause ? `${t(STATE_LABEL_KEYS[state])}: ${health.cause}` : t(STATE_LABEL_KEYS[state]));
  return (
    <span
      title={title ?? health?.cause}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, whiteSpace: "nowrap", color: state === "ok" ? "var(--text-muted)" : STATE_COLORS[state] }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATE_COLORS[state], flex: "none" }} />
      {text}
    </span>
  );
}