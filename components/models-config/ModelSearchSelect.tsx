"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatModelRoleSelector } from "@/lib/model-role-selection";
import { fuzzyMatch, highlightSegments } from "./fuzzy";
import { HealthBadge } from "./HealthBadge";
import { modelHealthKey, modelSelector, type ModelHealthMap, type ModelOption } from "./types";

/**
 * Searchable model picker used by the role table and the fallback-chain editor.
 *
 * Both places used to embed a `SearchableSelect` over a flat option list, which
 * cannot express "no model", a per-model availability dot, or excluding the
 * entries already in the chain. This popover takes the model list directly and
 * fuzzy-matches `provider/modelId`, so `q4m` finds `qwen4-max-preview`.
 */
export function ModelSearchSelect({
  value,
  models,
  health,
  onChange,
  ariaLabel,
  disabled,
  exclude,
  allowUnset,
  unsetLabel,
  placeholder,
}: {
  value: string;
  models: readonly ModelOption[];
  health?: ModelHealthMap;
  onChange: (selector: string | null) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Selectors hidden from the list, e.g. entries already in the chain. */
  exclude?: readonly string[];
  allowUnset?: boolean;
  unsetLabel?: string;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const excluded = useMemo(() => new Set(exclude ?? []), [exclude]);

  const matches = useMemo(() => {
    const needle = query.trim();
    const results: { model: ModelOption; selector: string; score: number; indices: number[] }[] = [];
    for (const model of models) {
      const selector = modelSelector(model.provider, model.id);
      if (excluded.has(selector)) continue;
      const match = fuzzyMatch(selector, needle);
      if (!match.hit) continue;
      results.push({ model, selector, score: match.score, indices: match.indices });
    }
    results.sort((a, b) => b.score - a.score || a.selector.localeCompare(b.selector));
    return results.slice(0, 200);
  }, [excluded, models, query]);

  const shown = open ? matches : [];
  const currentLabel = value || (allowUnset ? unsetLabel ?? t("roles.unset") : placeholder ?? t("models.searchModelsPlaceholder"));
  const currentHealth = value ? health?.[formatModelRoleSelector(value, "inherit")] : undefined;

  return (
    <div ref={containerRef} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "4px 8px",
          background: "var(--bg-elev, var(--bg-panel))",
          border: `1px solid ${currentHealth?.state === "disabled" ? "rgba(248,81,73,0.35)" : "var(--border)"}`,
          borderRadius: 6,
          color: "var(--text)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          fontFamily: "var(--font-mono)",
          fontSize: 12.2,
          boxSizing: "border-box",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
          {currentLabel}
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          style={{
            position: "absolute",
            zIndex: 40,
            top: "calc(100% + 4px)",
            left: 0,
            width: "min(520px, 80vw)",
            maxHeight: 420,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-elev, var(--bg-panel))",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--border)" }}>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
                if (event.key === "Enter" && shown.length > 0) {
                  onChange(shown[0].selector);
                  setOpen(false);
                }
              }}
              placeholder={t("models.searchModelsPlaceholder")}
              aria-label={t("models.searchModels")}
              style={{ width: "100%", padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12.5, outline: "none", boxSizing: "border-box" }}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {allowUnset && !query && (
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false); }}
                style={{ display: "flex", width: "100%", padding: "6px 10px", background: "none", border: "none", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", textAlign: "left" }}
              >
                {unsetLabel ?? t("roles.unset")}
              </button>
            )}
            {shown.length === 0 ? (
              <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
                {t("models.searchNoMatches", { query: query.trim() })}
              </div>
            ) : shown.map(({ model, selector, indices }) => (
              <button
                key={selector}
                type="button"
                onClick={() => { onChange(selector); setOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "6px 10px", background: "none", border: "none", borderBottom: "1px solid var(--border-soft, var(--border))", cursor: "pointer", textAlign: "left" }}
              >
                <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {highlightSegments(selector, indices).map((segment, index) => (
                    segment.marked
                      ? <mark key={index} style={{ background: "rgba(47,129,247,0.2)", color: "var(--accent)", borderRadius: 2 }}>{segment.text}</mark>
                      : <span key={index}>{segment.text}</span>
                  ))}
                </span>
                <HealthBadge health={health?.[modelHealthKey(model.provider, model.id)]} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}