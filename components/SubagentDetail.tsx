"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot, ToolResultMessage } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import { MessageView } from "./MessageView";

type SubagentTranscriptEntry = {
  id: string;
  message: AgentMessage;
};

type SubagentTranscriptResult = {
  fromByte: number;
  nextByte: number;
  reset: boolean;
  entries: Array<{ id?: string; type?: string; message?: AgentMessage }>;
};

function isSubagentActive(subagent: SubagentSnapshot): boolean {
  return subagent.status === "pending" || subagent.status === "running";
}

export function formatSubagentDuration(durationMs = 0): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

export function statusColor(subagent: SubagentSnapshot): string {
  if (subagent.progress?.retryState) return "var(--warning)";
  if (isSubagentActive(subagent)) return "var(--accent)";
  if (subagent.status === "failed") return "var(--danger)";
  if (subagent.status === "aborted") return "var(--warning)";
  return "var(--success)";
}

function subagentActivity(subagent: SubagentSnapshot, t: (key: string, params?: Record<string, string | number>) => string): string {
  const progress = subagent.progress;
  if (progress?.retryState) return t("subagents.retrying", { attempt: progress.retryState.attempt, max: progress.retryState.maxAttempts });
  if (isSubagentActive(subagent)) {
    if (progress?.currentTool) return t("subagents.usingTool", { tool: progress.currentTool });
    return progress?.lastIntent || t("subagents.running");
  }
  if (subagent.status === "failed") return t("subagents.failed");
  if (subagent.status === "aborted") return t("subagents.aborted");
  return t("subagents.finished");
}


/** #137: subagent execution detail — header, progress strip and the subagent's
 * own transcript (byte-incremental, 1s poll while active, follow-tail).
 * Extracted verbatim from the deleted SubagentPanel shell so the session
 * outline can reuse it as its drill-down surface. */
export function SubagentDetail({
  sessionId,
  cwd,
  subagent,
  onBack,
  onLocateInChat,
}: {
  sessionId: string;
  cwd?: string;
  subagent: SubagentSnapshot;
  onBack: () => void;
  /** #137: outline rows jump to their transcript anchor from here. */
  onLocateInChat?: () => void;
}) {
  const { t } = useI18n();
  const active = isSubagentActive(subagent);
  const [entries, setEntries] = useState<SubagentTranscriptEntry[]>([]);
  const [loadingTranscript, setLoadingTranscript] = useState(true);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let nextByte = 0;
    setEntries([]);
    setLoadingTranscript(true);
    setTranscriptError(null);
    followTailRef.current = true;

    const loadTranscript = async () => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const result = await sendAgentCommand<SubagentTranscriptResult>(sessionId, {
          type: "get_subagent_messages",
          subagentId: subagent.id,
          fromByte: nextByte,
        });
        if (disposed) return;
        const chunk = result.entries.flatMap((entry, index) =>
          entry.type === "message" && entry.message
            ? [{
                id: entry.id ?? `${result.fromByte}:${index}`,
                message: normalizeToolCalls(entry.message),
              }]
            : []);
        setEntries((current) => result.reset || result.fromByte === 0 ? chunk : [...current, ...chunk]);
        nextByte = result.nextByte;
        setTranscriptError(null);
      } catch (error) {
        if (!disposed) setTranscriptError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setLoadingTranscript(false);
        inFlight = false;
      }
    };

    void loadTranscript();
    const interval = active ? setInterval(() => void loadTranscript(), 1000) : undefined;
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [active, sessionId, subagent.id]);

  useEffect(() => {
    if (!followTailRef.current) return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [entries.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const toolResults = useMemo(() => {
    const resultMap = new Map<string, ToolResultMessage>();
    for (const entry of entries) {
      if (entry.message.role === "toolResult") resultMap.set(entry.message.toolCallId, entry.message);
    }
    return resultMap;
  }, [entries]);

  const color = statusColor(subagent);
  const progress = subagent.progress;

  return (
    <div role="dialog" aria-label={t("subagents.details")} style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "11px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <button
          type="button"
          onClick={onBack}
          title={t("subagents.back")}
          aria-label={t("subagents.back")}
          style={{ display: "grid", placeItems: "center", width: 25, height: 25, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.5 3 5.5 8l5 5" />
          </svg>
        </button>
        <span style={{ width: 8, height: 8, marginTop: 6, borderRadius: "50%", background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 12%, transparent)`, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{subagent.id}</span>
            <span style={{ padding: "1px 5px", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", fontSize: 9 }}>{subagent.agent}</span>
          </div>
        </div>
        {onLocateInChat && (
          <button
            type="button"
            data-testid="subagent-locate-in-chat"
            onClick={onLocateInChat}
            title={t("subagents.locateInChat")}
            aria-label={t("subagents.locateInChat")}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 9.5 }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
            </svg>
            <span>{t("subagents.locateInChat")}</span>
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 11px", padding: "7px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color }}>{active ? t("subagents.running") : subagentActivity(subagent, t)}</span>
        <span>{formatSubagentDuration(progress?.durationMs)}</span>
        <span>{t("subagents.tools", { count: progress?.toolCount ?? 0 })}</span>
        <span>{t("subagents.tokens", { count: progress?.tokens ?? 0 })}</span>
        {progress?.resolvedModel && <span>{progress.resolvedModel}</span>}
        {progress?.currentTool && <span style={{ color: "var(--text-muted)" }}>{t("subagents.usingTool", { tool: progress.currentTool })}</span>}
      </div>

      <div
        ref={transcriptRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 16px" }}
      >
        {entries.length > 0 ? entries.map((entry, index) => (
          <MessageView
            key={entry.id}
            message={entry.message}
            toolResults={toolResults}
            cwd={cwd}
            showTimestamp
            prevTimestamp={entries[index - 1]?.message.timestamp}
          />
        )) : (
          <div style={{ padding: "24px 8px", color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.6, textAlign: "center" }}>
            {loadingTranscript
              ? t("subagents.loadingTranscript")
              : progress?.recentOutput?.length
                ? <pre style={{ margin: 0, textAlign: "left", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{progress.recentOutput.join("\n")}</pre>
                : t("subagents.noTranscript")}
          </div>
        )}
        {transcriptError && (
          <div role="status" style={{ marginTop: 8, padding: "7px 9px", border: "1px solid color-mix(in srgb, var(--warning) 35%, var(--border))", borderRadius: 6, color: "var(--warning)", fontSize: 9.5, overflowWrap: "anywhere" }}>
            {t("subagents.transcriptUnavailable")}
          </div>
        )}
      </div>
    </div>
  );
}