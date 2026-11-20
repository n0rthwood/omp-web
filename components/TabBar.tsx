"use client";

import { useState } from "react";
import { getFileIcon, TerminalIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";

export interface Tab {
  id: string;
  label: string;
  filePath?: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff";
  kind?: "file" | "terminal" | "ask" | "plan"; // default "file" when absent
  terminalId?: string; // present when kind === "terminal"; the server-side terminal id
  /** Extension request id for kind "ask"/"plan" side-dialog tabs. */
  askRequestId?: string;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.kind === "ask" || tab.kind === "plan" ? (
                tab.kind === "plan" ? (
                  <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 13, height: 13, borderRadius: 3, background: "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))", color: "var(--accent)" }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  </span>
                ) : (
                  <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 13, height: 13, borderRadius: 3, background: "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))", color: "var(--accent)", fontSize: 10, fontWeight: 750 }}>?</span>
                )
              ) : tab.kind === "terminal" ? <TerminalIcon size={13} /> : getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
               title={t("i18n.close")}
               aria-label={`${t("i18n.close")} ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
