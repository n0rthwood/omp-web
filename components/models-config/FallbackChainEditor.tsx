"use client";

import { useI18n } from "@/hooks/useI18n";
import { ModelSearchSelect } from "./ModelSearchSelect";
import type { ModelHealthMap, ModelOption } from "./types";

/**
 * Ordered fallback chain for one role.
 *
 * Writes go through `PUT /api/model-roles/fallbacks`: `null` drops the role's
 * key so the `default` chain applies again, an array persists an explicit list.
 * The chain shown here is the *effective* one, so an inherited chain is
 * rendered read-only until the first edit forks it onto this role.
 */

function nodeButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "0 3px",
    border: "none",
    borderRadius: 3,
    background: "transparent",
    color: "var(--text-dim)",
    cursor: disabled ? "default" : "pointer",
    fontFamily: "var(--font-mono)",
    fontSize: 10.5,
    lineHeight: 1.2,
    opacity: disabled ? 0.35 : 1,
  };
}

export function FallbackChainEditor({
  chain,
  models,
  health,
  inherited,
  configured,
  busy = false,
  onChange,
  roleLabel,
}: {
  chain: readonly string[];
  models: readonly ModelOption[];
  health?: ModelHealthMap;
  inherited: boolean;
  configured?: string[];
  busy?: boolean;
  roleLabel: string;
  onChange: (chain: string[] | null) => void;
}) {
  const { t } = useI18n();

  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length) return;
    const next = [...chain];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry);
    onChange(next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {chain.length === 0 && (
          <span style={{ fontSize: 11.5, color: "var(--text-dim)", fontStyle: "italic" }}>
            {t("roles.backupsNone")}
          </span>
        )}
        {chain.map((entry, index) => {
          const isBad = health?.[entry]?.state === "disabled";
          return (
            <span
              key={`${entry}-${index}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                padding: "1px 3px 1px 6px",
                border: `1px solid ${isBad ? "rgba(248,81,73,0.3)" : "var(--border)"}`,
                borderRadius: 4,
                background: inherited ? "transparent" : "var(--bg-subtle, var(--bg-panel))",
                color: isBad ? "var(--danger, #f85149)" : inherited ? "var(--text-dim)" : "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                opacity: busy ? 0.55 : 1,
              }}
            >
              <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{index + 1}.</span>
              {entry}
              {!inherited && (
                <>
                  <button type="button" disabled={busy || index === 0} title={t("roles.backupsUp")} aria-label={`${t("roles.backupsUp")}: ${entry}`}
                    onClick={() => move(index, index - 1)} style={nodeButtonStyle(busy || index === 0)}>↑</button>
                  <button type="button" disabled={busy || index === chain.length - 1} title={t("roles.backupsDown")} aria-label={`${t("roles.backupsDown")}: ${entry}`}
                    onClick={() => move(index, index + 1)} style={nodeButtonStyle(busy || index === chain.length - 1)}>↓</button>
                  <button type="button" disabled={busy} title={t("roles.backupsRemove")} aria-label={`${t("roles.backupsRemove")}: ${entry}`}
                    onClick={() => onChange(chain.filter((_, i) => i !== index))}
                    style={{ ...nodeButtonStyle(busy), color: "var(--text-dim)" }}>×</button>
                </>
              )}
            </span>
          );
        })}

        <ModelSearchSelect
          value=""
          models={models}
          health={health}
          exclude={chain}
          disabled={busy}
          ariaLabel={`${roleLabel} — ${t("roles.backupsAdd")}`}
          placeholder={`+ ${t("roles.backupsAdd")}`}
          onChange={(selector) => { if (selector) onChange([...chain, selector]); }}
        />

        {inherited && chain.length > 0 && (
          <button type="button" disabled={busy} title={t("roles.backupsOverrideHint")}
            onClick={() => onChange([...chain])}
            style={{ padding: "2px 6px", border: "1px dashed var(--border)", borderRadius: 3, background: "transparent", color: "var(--text-dim)", cursor: busy ? "default" : "pointer", fontSize: 10, fontFamily: "var(--font-mono)" }}>
            {t("roles.backupsInherited")} — {t("roles.backupsOverride")}
          </button>
        )}

        {!inherited && configured !== undefined && (
          <button type="button" disabled={busy} title={t("roles.backupsResetHint")}
            onClick={() => onChange(null)}
            style={{ padding: "2px 6px", border: "1px dashed var(--border)", borderRadius: 3, background: "transparent", color: "var(--text-dim)", cursor: busy ? "default" : "pointer", fontSize: 10, fontFamily: "var(--font-mono)" }}>
            {t("roles.backupsReset")}
          </button>
        )}
      </div>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {inherited ? t("roles.backupsInheritedHint") : t("roles.backupsEditableHint")}
      </span>
    </div>
  );
}