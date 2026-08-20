"use client";

/**
 * Auto-collapse sidebar strip (issue #22, desktop-only): a ~5-CJK-character
 * rail of colored chips, one per conversation across every project, most
 * recently modified first. Each chip's label is the session's GitHub issue
 * number when present, else the first characters of its title; its
 * background is the age-bucket color for `modified` (lib/sidebar-colors.ts)
 * — recent conversations render deepest, sessions 100h+ old render with the
 * default (uncolored) chip style. Clicking a chip opens that conversation;
 * the header button returns to table mode.
 */

import { useMemo } from "react";
import type { SessionInfo } from "@/lib/types";
import { parseTitleAnnotations } from "@/lib/title-annotations";
import { colorFor } from "@/lib/sidebar-colors";
import { sessionDisplayTitle } from "@/lib/session-display-title";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";

/** Chip label: the session's first referenced GitHub issue number, else the
 *  first 5 characters of its (annotation-stripped) display title. */
function chipLabel(title: string): string {
  const { text, annotations } = parseTitleAnnotations(title);
  const issueNumber = annotations?.main[0];
  return issueNumber !== undefined ? `#${issueNumber}` : Array.from(text).slice(0, 5).join("");
}

interface Props {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
  onExpand: () => void;
}

export function SessionStrip({ sessions, selectedSessionId, onSelectSession, onExpand }: Props) {
  const { t, locale } = useI18n();
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.modified.localeCompare(a.modified)),
    [sessions],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <button
        type="button"
        onClick={onExpand}
        title={t("sidebar.expandStrip")}
        aria-label={t("sidebar.expandStrip")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: 34,
          flexShrink: 0,
          background: "var(--bg-hover)",
          border: "none",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-muted)",
          cursor: "pointer",
          transition: "color 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      <nav
        aria-label={t("sidebar.stripLabel")}
        style={{ flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", padding: "6px 4px" }}
      >
        {ordered.map((session) => {
          const isSelected = session.id === selectedSessionId;
          const color = colorFor(session.modified);
          const title = sessionDisplayTitle(session);
          const relative = formatRelativeTime(new Date(session.modified), locale);
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelectSession(session)}
              title={`${title} — ${relative}`}
              aria-label={t("sidebar.openConversation", { title })}
              aria-current={isSelected ? "true" : undefined}
              style={{
                display: "block",
                width: "100%",
                minHeight: 36,
                marginBottom: 4,
                padding: "4px 2px",
                boxSizing: "border-box",
                border: isSelected ? "2px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: 6,
                background: color?.bg ?? "var(--bg-hover)",
                color: color?.fg ?? "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: isSelected ? 700 : 500,
                letterSpacing: "-0.02em",
                textAlign: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {chipLabel(title)}
            </button>
          );
        })}
        {ordered.length === 0 && (
          <div style={{ color: "var(--text-dim)", fontSize: 10.5, textAlign: "center", padding: "10px 2px" }}>
            {t("sidebar.noSessions")}
          </div>
        )}
      </nav>
    </div>
  );
}
