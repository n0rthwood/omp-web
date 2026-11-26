"use client";

import { useI18n } from "@/hooks/useI18n";
import type { ModelHealth, ModelHealthState, ProviderHealth } from "./types";

/**
 * Availability dot for a model or provider row.
 *
 * Health comes from the background scanner (`modelHealth`, keyed
 * `provider/modelId`); when it has no entry for a model the row reads
 * "unverified" rather than claiming the model works.
 *
 * A provider's `expiring` state is a badge of its own: an access token close
 * to expiry is still a working credential, not a disabled one (#144).
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
  health?: ModelHealth | ProviderHealth;
  label?: string;
  title?: string;
}) {
  const { t } = useI18n();
  const state = health?.state ?? "unverified";
  const text = label ?? (health?.cause ? `${t(STATE_LABEL_KEYS[state])}: ${health.cause}` : t(STATE_LABEL_KEYS[state]));
  return (
    <span
      title={title ?? health?.cause}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, minWidth: 0, maxWidth: "100%", color: state === "ok" ? "var(--text-muted)" : STATE_COLORS[state] }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: STATE_COLORS[state], flex: "none" }} />
      {/* #146: a long failure cause must not push the card title out of the
          row — ellipsis here, full text in the `title` tooltip and the
          card's own cause block. */}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </span>
  );
}