"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelsHealthResponse } from "./types";

/**
 * Background model-health strip: when the scan last ran, how many credentials
 * are dead, and how many models are still usable.
 *
 * The scan itself is a separate service; this only renders
 * `GET /api/models/health`, which the shell fetches. While that endpoint is not
 * deployed the shell passes `null` and the strip renders nothing at all — a
 * missing background service must not put an error banner on the page.
 */
export function HealthStrip({ health }: { health: ModelsHealthResponse | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [now] = useState(() => Date.now());

  if (!health) return null;

  const failing = Object.entries(health.providers).filter(([, entry]) => entry.state !== "ok");
  const scannedMinutesAgo = Math.max(0, Math.round((now - health.scannedAt) / 60_000));

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 999,
          padding: "5px 12px",
          color: "var(--text-muted)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <span>{t("models.healthStrip", { minutes: scannedMinutesAgo })}</span>
        {failing.length > 0 && <span style={{ color: "var(--warning, #d29922)" }}>{t("models.healthFailing", { count: failing.length })}</span>}
        <span>·</span>
        <span style={{ color: "var(--success, #3fb950)" }}>{t("models.healthAvailable", { count: health.availableModelCount })}</span>
        <span>· {t("models.healthDetails")}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("models.healthDetails")}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 430,
            maxWidth: "calc(100vw - 32px)",
            zIndex: 70,
            background: "var(--bg-elev, var(--bg-panel))",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 18px 40px rgba(0,0,0,0.45)",
            padding: "10px 12px",
            fontSize: 12,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.04em", marginBottom: 6 }}>
            {t("models.healthFailingTitle", { count: failing.length })}
          </div>
          {failing.length === 0 ? (
            <div style={{ color: "var(--text-dim)" }}>{t("models.healthNoneFailing")}</div>
          ) : failing.map(([provider, entry]) => (
            <div key={provider} style={{ display: "flex", gap: 10, padding: "6px 0", borderTop: "1px solid var(--border)" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--danger, #f85149)", flexShrink: 0 }}>{provider}</span>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all" }}>{entry.cause ?? entry.state}</code>
            </div>
          ))}
          <div style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 11.5, lineHeight: 1.45 }}>
            {t("models.healthNote", { disabled: health.disabledModelCount })}
          </div>
        </div>
      )}
    </div>
  );
}