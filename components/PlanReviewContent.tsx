"use client";

import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";

export type PlanReviewRequest = Extract<ExtensionUiRequest, { method: "plan_review" }>;

export function PlanReviewContent({ request, onRespond, variant, onClose }: {
  request: PlanReviewRequest;
  onRespond: (response: { value: string } | { cancelled: true }) => void;
  variant: "panel" | "drawer";
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const [planFeedback, setPlanFeedback] = useState("");

  useEffect(() => {
    setPlanFeedback("");
  }, [request.id]);

  const approve = () => onRespond({ value: JSON.stringify({ action: "approve" }) });

  return (
    <div
      role="dialog"
      aria-label={t("chat.planApproval")}
      data-testid="plan-review-content"
      onKeyDown={(event) => {
        if (event.key === "Escape") onRespond({ cancelled: true });
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          approve();
        }
      }}
      style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", height: "100%", minHeight: 0, minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <span
          aria-hidden="true"
          style={{
            display: "grid",
            placeItems: "center",
            width: 24,
            height: 24,
            flexShrink: 0,
            borderRadius: 6,
            background: "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))",
            color: "var(--accent)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: "var(--accent)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {t("chat.planApproval")}
          </div>
          <div style={{ marginTop: 2, color: "var(--text)", fontSize: 14, fontWeight: 680 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, overflowWrap: "anywhere" }}>
            {request.planFilePath}
          </div>
        </div>
        {variant === "drawer" && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chat.hideQuestion")}
            style={{ marginLeft: "auto", flexShrink: 0, width: 28, height: 28, display: "grid", placeItems: "center", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="m3 3 6 6m0-6-6 6" />
            </svg>
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 20px" }}>
        <MarkdownBody>{request.planContent}</MarkdownBody>
      </div>

      <div style={{ flexShrink: 0, padding: "12px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <textarea
          value={planFeedback}
          onChange={(event) => setPlanFeedback(event.target.value)}
          placeholder={t("chat.planFeedback")}
          aria-label={t("chat.planFeedback")}
          style={{
            width: "100%",
            minHeight: 64,
            maxHeight: 150,
            padding: "9px 10px",
            border: "1px solid var(--border)",
            borderRadius: 7,
            outline: "none",
            resize: "vertical",
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 9 }}>
          <button
            type="button"
            onClick={() => onRespond({
              value: JSON.stringify({ action: "refine", feedback: planFeedback.trim() }),
            })}
            style={{ padding: "7px 11px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer" }}
          >
            {t("chat.refinePlan")}
          </button>
          <button
            type="button"
            onClick={approve}
            style={{ padding: "7px 12px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 650 }}
          >
            {t("chat.approvePlan")}
          </button>
        </div>
      </div>
    </div>
  );
}
