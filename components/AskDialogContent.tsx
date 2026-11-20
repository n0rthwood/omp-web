"use client";

import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";

export type AskDialogRequest = Extract<ExtensionUiRequest, { method: "ask" }>;
export type AskDialogResponse = { value: string } | { confirmed: boolean } | { cancelled: true };
export type AskDialogResponder = (request: AskDialogRequest, response: AskDialogResponse) => void;

function recommendedSelections(request: AskDialogRequest): Record<string, number[]> {
  const recommended: Record<string, number[]> = {};
  for (const question of request.questions) {
    recommended[question.id] = question.recommended !== undefined
      && question.options[question.recommended] !== undefined
      ? [question.recommended]
      : [];
  }
  return recommended;
}

export function AskDialogContent({ request, onRespond, variant, onClose }: {
  request: AskDialogRequest;
  onRespond: (response: AskDialogResponse) => void;
  variant: "panel" | "drawer";
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const [selectedOptions, setSelectedOptions] = useState<Record<string, number[]>>(() => recommendedSelections(request));
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelectedOptions(recommendedSelections(request));
    setCustomAnswers({});
  }, [request]);

  const canSubmit = request.questions.every((question) =>
    (selectedOptions[question.id]?.length ?? 0) > 0
    || (customAnswers[question.id]?.trim().length ?? 0) > 0);
  const toggleOption = (questionId: string, optionIndex: number, multi: boolean) => {
    setSelectedOptions((current) => {
      const selected = current[questionId] ?? [];
      const next = multi
        ? selected.includes(optionIndex)
          ? selected.filter((index) => index !== optionIndex)
          : [...selected, optionIndex]
        : [optionIndex];
      return { ...current, [questionId]: next };
    });
  };
  const submitAnswers = () => {
    if (!canSubmit) return;
    onRespond({
      value: JSON.stringify({
        kind: "submit",
        results: request.questions.map((question) => {
          const customInput = customAnswers[question.id]?.trim();
          return {
            id: question.id,
            question: question.question,
            options: question.options.map((option) => option.label),
            multi: question.multi ?? false,
            selectedOptions: (selectedOptions[question.id] ?? [])
              .map((index) => question.options[index]?.label)
              .filter((option): option is string => option !== undefined),
            ...(customInput ? { customInput } : {}),
          };
        }),
      }),
    });
  };

  return (
    <div
      role="dialog"
      aria-label={t("chat.agentQuestion")}
      data-testid="ask-dialog-content"
      onKeyDown={(event) => {
        if (event.key === "Escape") onRespond({ cancelled: true });
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          submitAnswers();
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
            fontSize: 13,
            fontWeight: 750,
          }}
        >
          ?
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 680 }}>{t("chat.agentQuestion")}</div>
          <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11 }}>{t("chat.agentQuestionHint")}</div>
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

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
        <div style={{ display: "grid", gap: 14 }}>
          {request.questions.map((question, questionIndex) => {
            const selected = selectedOptions[question.id] ?? [];
            return (
              <section
                key={question.id}
                style={{ padding: 14, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                  {question.header && (
                    <span style={{ color: "var(--accent)", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      {question.header}
                    </span>
                  )}
                  {request.questions.length > 1 && (
                    <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
                      {questionIndex + 1}/{request.questions.length}
                    </span>
                  )}
                </div>
                <div style={{ marginBottom: 10, color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
                  <MarkdownBody>{question.question}</MarkdownBody>
                </div>
                <div
                  role={question.multi ? "group" : "radiogroup"}
                  aria-label={question.question}
                  style={{ display: "grid", gap: 7 }}
                >
                  {question.options.map((option, optionIndex) => {
                    const checked = selected.includes(optionIndex);
                    const recommended = question.recommended === optionIndex;
                    return (
                      <div
                        key={`${question.id}:${optionIndex}`}
                        role={question.multi ? "checkbox" : "radio"}
                        tabIndex={0}
                        aria-checked={checked}
                        onClick={() => toggleOption(question.id, optionIndex, question.multi ?? false)}
                        onKeyDown={(event) => {
                          if ((event.key === "Enter" || event.key === " ") && !event.metaKey && !event.ctrlKey) {
                            event.preventDefault();
                            toggleOption(question.id, optionIndex, question.multi ?? false);
                          }
                        }}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "18px minmax(0, 1fr) auto",
                          alignItems: "start",
                          gap: 9,
                          width: "100%",
                          padding: "9px 10px",
                          border: `1px solid ${checked ? "color-mix(in srgb, var(--accent) 55%, var(--border))" : "var(--border)"}`,
                          borderRadius: 7,
                          background: checked ? "color-mix(in srgb, var(--accent) 8%, var(--bg))" : "var(--bg)",
                          color: "var(--text)",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: "grid",
                            placeItems: "center",
                            width: 16,
                            height: 16,
                            marginTop: 1,
                            border: `1px solid ${checked ? "var(--accent)" : "var(--text-dim)"}`,
                            borderRadius: question.multi ? 4 : "50%",
                            background: checked ? "var(--accent)" : "transparent",
                            color: "#fff",
                            fontSize: 10,
                            lineHeight: 1,
                          }}
                        >
                          {checked && (question.multi ? (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="2 5.2 4.1 7.2 8 2.8" />
                            </svg>
                          ) : (
                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                          ))}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 12.5, fontWeight: checked ? 650 : 500 }}>{option.label}</span>
                          {option.description && (
                            <div style={{ marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
                              <MarkdownBody>{option.description}</MarkdownBody>
                            </div>
                          )}
                          {option.preview && (
                            <div style={{ marginTop: 8, padding: "7px 8px", borderLeft: "2px solid var(--accent)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.5 }}>
                              <MarkdownBody>{option.preview}</MarkdownBody>
                            </div>
                          )}
                        </div>
                        {recommended && (
                          <span style={{ color: "var(--accent)", fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                            {t("chat.recommended")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <textarea
                  rows={2}
                  value={customAnswers[question.id] ?? ""}
                  onChange={(event) => setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                  placeholder={t("chat.customAnswer")}
                  aria-label={t("chat.customAnswer")}
                  style={{
                    width: "100%",
                    marginTop: 9,
                    padding: "8px 10px",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    resize: "vertical",
                    minHeight: 52,
                    maxHeight: 200,
                    overflowY: "auto",
                  }}
                />
              </section>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", flexShrink: 0, justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <button
          type="button"
          onClick={() => onRespond({ cancelled: true })}
          style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
        >
          {t("chat.cancel")}
        </button>
        <button
          type="button"
          onClick={() => onRespond({ value: JSON.stringify({ kind: "chat" }) })}
          style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer" }}
        >
          {t("chat.chatAboutThis")}
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submitAnswers}
          style={{
            padding: "7px 12px",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            background: "var(--accent)",
            color: "#fff",
            cursor: canSubmit ? "pointer" : "not-allowed",
            opacity: canSubmit ? 1 : 0.45,
            fontWeight: 650,
          }}
        >
          {t("chat.submitAnswer")}
        </button>
      </div>
    </div>
  );
}
