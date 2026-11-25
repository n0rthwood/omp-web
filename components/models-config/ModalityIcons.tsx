"use client";

import { useI18n } from "@/hooks/useI18n";

/**
 * Text / image input toggles for one model row.
 *
 * `model.input` is the only source of truth: an absent list means "text only"
 * (omp's default), so the text icon starts on and writes `["text","image"]` or
 * `undefined` rather than an empty array the schema would persist as a real
 * value.
 */

const MODALITIES = ["text", "image"] as const;
type Modality = (typeof MODALITIES)[number];

const MOD_LABEL_KEYS: Record<Modality, string> = {
  text: "models.modalityText",
  image: "models.modalityImage",
};

/**
 * Whether a modality is on.
 *
 * An absent `input` is omp's default (text only); an explicitly empty list is a
 * real "no modalities" value, so the two must not be conflated — otherwise
 * turning text off would silently render as on again.
 */
export function isModalityEnabled(input: string[] | undefined, modality: Modality): boolean {
  if (input === undefined) return modality === "text";
  return input.includes(modality);
}

/**
 * Flip one modality and return the `model.input` value to persist.
 *
 * `[]` is preserved as a real value ("no modalities") rather than collapsed to
 * `undefined`, which would mean omp's text-only default.
 */
export function toggleModality(input: string[] | undefined, modality: Modality): string[] | undefined {
  const enabled = new Set(MODALITIES.filter((entry) => isModalityEnabled(input, entry)));
  if (enabled.has(modality)) enabled.delete(modality);
  else enabled.add(modality);
  return MODALITIES.filter((entry) => enabled.has(entry));
}

export function ModalityIcons({ input, onChange, disabled }: {
  input: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();

  const toggle = (modality: Modality) => onChange(toggleModality(input, modality));

  return (
    <span style={{ display: "inline-flex", flexDirection: "row", alignItems: "center", gap: 5 }}>
      {MODALITIES.map((modality) => {
        const on = isModalityEnabled(input, modality);
        const label = `${on ? t("models.modalityDisable") : t("models.modalityEnable")}${t(MOD_LABEL_KEYS[modality])}`;
        return (
          <button
            key={modality}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={label}
            title={label}
            onClick={() => toggle(modality)}
            style={{
              width: 20,
              height: 20,
              padding: 0,
              borderRadius: 4,
              cursor: disabled ? "not-allowed" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: `1px solid ${on ? "rgba(47,129,247,0.4)" : "var(--border-soft, var(--border))"}`,
              background: on ? "rgba(47,129,247,0.13)" : "transparent",
              color: on ? "var(--accent)" : "var(--text-dim)",
              opacity: disabled ? 0.55 : 1,
            }}
          >
            {modality === "text" ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3 4h10M8 4v8" />
                <path d="M5.5 12h5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" />
                <circle cx="6" cy="6.4" r="1.1" />
                <path d="M2.6 11.4 6.2 8.6l2.4 1.9 2.2-1.7 2.4 2.1" />
              </svg>
            )}
          </button>
        );
      })}
    </span>
  );
}