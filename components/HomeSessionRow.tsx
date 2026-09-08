"use client";

import type * as React from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { sessionDisplayTitle } from "@/lib/session-display-title";
import type { SessionInfo } from "@/lib/types";

export interface HomeSessionRowEntry {
  session: SessionInfo;
  machineId: string;
  machineName: string;
  machineOffline: boolean;
  projectRoot: string;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1) || trimmed;
}

function Tag({ children, title, maxWidth }: {
  children: React.ReactNode;
  title?: string;
  maxWidth: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flex: "0 1 auto",
        minWidth: 0,
        maxWidth,
        overflow: "hidden",
        textOverflow: "ellipsis",
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 10.5,
        fontWeight: 500,
        lineHeight: 1.6,
        background: "var(--bg-hover)",
        border: "1px solid var(--border)",
        color: "var(--text-muted)",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {children}
      </span>
    </span>
  );
}

export function HomeSessionRow(props: {
  entry: HomeSessionRowEntry;
  /** Show the project-name tag. False inside a project-grouped list (redundant), true in cross-group lists. */
  showProjectTag: boolean;
  /** Show the machine-name tag. False in single-machine context, true in cross-machine lists. */
  showMachineTag: boolean;
  onSelect: (entry: HomeSessionRowEntry) => void;
}): React.ReactElement {
  const { entry, showProjectTag, showMachineTag, onSelect } = props;
  const { locale, t } = useI18n();
  const isMobile = useIsMobile();
  const title = sessionDisplayTitle(entry.session);
  const turns = Math.round(entry.session.messageCount / 2);

  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      title={`${entry.machineName} · ${entry.projectRoot}`}
      style={{
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        alignItems: isMobile ? "stretch" : "center",
        flexWrap: isMobile ? "nowrap" : "wrap",
        gap: isMobile ? 4 : 8,
        width: "100%",
        minHeight: isMobile ? 56 : undefined,
        textAlign: "left",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 7,
        color: "var(--text)",
        cursor: "pointer",
        padding: isMobile ? "10px 12px" : "6px 10px",
        fontSize: 12.5,
        opacity: entry.machineOffline ? 0.7 : 1,
      }}
    >
      <span
        style={{
          flex: isMobile ? "0 1 auto" : 1,
          flexBasis: isMobile ? "auto" : "60ch",
          maxWidth: isMobile ? undefined : "100ch",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
          wordBreak: "break-word",
          lineHeight: isMobile ? 1.4 : 1.35,
        }}
      >
        {title}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: isMobile ? "flex-start" : "flex-end",
          marginLeft: isMobile ? undefined : "auto",
          flexWrap: "wrap",
          gap: isMobile ? 6 : 8,
          minWidth: 0,
          ...(isMobile ? { width: "100%" } : { flex: "0 1 62ch", maxWidth: "62ch" }),
        }}
      >
        <time dateTime={entry.session.modified} style={{ fontSize: 10.5, color: "var(--text-dim)", flexShrink: 0 }}>
          {formatRelativeTime(new Date(entry.session.modified), locale)}
        </time>
        {showProjectTag && (
          <Tag title={entry.projectRoot} maxWidth="20ch">
            {basename(entry.projectRoot)}
          </Tag>
        )}
        {showMachineTag && (
          <Tag title={entry.machineOffline ? `${entry.machineName} (${t("home.machineOffline")})` : entry.machineName} maxWidth="16ch">
            {entry.machineName}
          </Tag>
        )}
        <Tag title={t("home.messageCount", { count: String(entry.session.messageCount) })} maxWidth="10ch">
          {t("home.turnCount", { count: String(turns) })}
        </Tag>
      </span>
    </button>
  );
}
