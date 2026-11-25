"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OutlineJobStatus, SessionOutlineEntry } from "@/lib/session-outline";
import { useI18n } from "@/hooks/useI18n";

// #104: journal outline panel. Rendered either as a persistent rail beside the
// transcript (wide containers) or as a modal drawer (narrow containers / side
// panels). The drawer traps focus, closes on backdrop click, restores focus to
// its trigger, and isolates Escape from the global agent-abort shortcut.

export interface SessionOutlineProps {
  entries: SessionOutlineEntry[];
  loading: boolean;
  error: string | null;
  onRetryLoad: () => void;
  readingEntryId: string | null;
  targetEntryId: string | null;
  navigating: boolean;
  onJump: (entryId: string) => void;
  variant: "rail" | "drawer";
  onClose: () => void;
  /** Drawer only: focus returns here on close. */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

type OutlineRow =
  | { kind: "entry"; entry: SessionOutlineEntry }
  | { kind: "toolGroup"; entries: SessionOutlineEntry[] };

/** #135: tool-category rows (wrench/pencil/hourglass) plus legacy tool-only
 * assistant rows from old remotes. */
function isToolCategoryEntry(entry: SessionOutlineEntry): boolean {
  return entry.role === "tool" || entry.role === "write" || entry.role === "wait"
    || (entry.role === "assistant" && entry.toolOnly === true);
}

/** Collapse adjacent tool-category entries; keep journal positions intact. */
export function groupOutlineEntries(entries: SessionOutlineEntry[]): OutlineRow[] {
  const rows: OutlineRow[] = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (!isToolCategoryEntry(entry)) {
      rows.push({ kind: "entry", entry });
      index++;
      continue;
    }
    let end = index + 1;
    while (end < entries.length && isToolCategoryEntry(entries[end])) {
      end++;
    }
    rows.push(end - index >= 2
      ? { kind: "toolGroup", entries: entries.slice(index, end) }
      : { kind: "entry", entry });
    index = end;
  }
  return rows;
}

function formatOutlineTime(timestamp: string): string | null {
  let ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    ms = numeric;
  }
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role: SessionOutlineEntry["role"], t: (key: string, params?: Record<string, string | number>) => string): string {
  if (role === "user") return t("outline.roleUser");
  if (role === "summary") return t("outline.roleSummary");
  if (role === "ask") return t("outline.roleAsk");
  if (role === "subagent") return t("outline.roleSubagent");
  if (role === "system") return t("outline.roleSystem");
  if (role === "tool") return t("outline.roleTool");
  if (role === "write") return t("outline.roleWrite");
  if (role === "wait") return t("outline.roleWait");
  if (role === "title") return t("outline.roleTitle");
  return t("outline.roleAssistant");
}

function jobStatusLabel(status: OutlineJobStatus, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (status === "pending") return t("outline.jobPending");
  if (status === "running") return t("outline.jobRunning");
  if (status === "failed") return t("outline.jobFailed");
  if (status === "aborted") return t("outline.jobAborted");
  return t("outline.jobCompleted");
}

/** #135: lifecycle badge — SubagentPanel conventions: in-flight spins with the
 * accent dashed circle, completed ✓ success, failed ✗ danger, aborted ⊘ warning. */
function JobStatusBadge({ status, label }: { status: OutlineJobStatus; label: string }) {
  if (status === "pending" || status === "running") {
    return (
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-label={label} role="img" style={{ color: "var(--accent)", flexShrink: 0 }}>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.8" strokeDasharray="22 13">
          <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
        </circle>
      </svg>
    );
  }
  const glyph = status === "completed" ? "✓" : status === "failed" ? "✗" : "⊘";
  const color = status === "completed" ? "var(--success)" : status === "failed" ? "var(--danger)" : "var(--warning)";
  return <span aria-label={label} role="img" style={{ color, fontSize: 10, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>{glyph}</span>;
}

function RoleGlyph({ role }: { role: SessionOutlineEntry["role"] | "tools" }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (role === "user") {
    return (
      <svg {...common}>
        <circle cx="6" cy="4" r="2.2" />
        <path d="M2 10.2c.6-1.8 2.2-2.7 4-2.7s3.4.9 4 2.7" />
      </svg>
    );
  }
  if (role === "summary") {
    return (
      <svg {...common}>
        <path d="M2.5 2.5h7M2.5 6h7M2.5 9.5h4.5" />
      </svg>
    );
  }
  if (role === "ask") {
    return <span aria-hidden="true" style={{ fontSize: 12, fontWeight: 700 }}>?</span>;
  }
  if (role === "tools" || role === "tool") {
    // Wrench: unified glyph for all generic tool rows and collapsed groups.
    return (
      <svg {...common}>
        <path d="M7 2a3 3 0 0 0-3.7 3.7L1.5 7.5a1.4 1.4 0 0 0 2 2l1.8-1.8A3 3 0 0 0 9 4L7.2 5 6 3.8 7 2Z" />
      </svg>
    );
  }
  if (role === "write") {
    // Pencil: diagonal body with tip at lower-left.
    return (
      <svg {...common}>
        <path d="M8.6 1.9l1.5 1.5-5.6 5.6-2 .5.5-2 5.6-5.6Z" />
        <path d="M7.4 3.1l1.5 1.5" />
      </svg>
    );
  }
  if (role === "wait") {
    // Hourglass: two bulbs between caps.
    return (
      <svg {...common}>
        <path d="M3 1.5h6M3 10.5h6M3.8 1.5c0 2 1.4 2.9 2.2 4.5-.8 1.6-2.2 2.5-2.2 4.5M8.2 1.5c0 2-1.4 2.9-2.2 4.5.8 1.6 2.2 2.5 2.2 4.5" />
      </svg>
    );
  }
  if (role === "title") {
    // Tag/label: pointed body with a punch hole.
    return (
      <svg {...common}>
        <path d="M1.8 5.4V2.6a.8.8 0 0 1 .8-.8h2.8L10 6.4a1 1 0 0 1 0 1.4L7.8 10a1 1 0 0 1-1.4 0L1.8 5.4Z" />
        <circle cx="4" cy="4" r="0.7" />
      </svg>
    );
  }
  if (role === "subagent") {
    return (
      <svg {...common}>
        <circle cx="3" cy="2" r="1" />
        <circle cx="3" cy="10" r="1" />
        <circle cx="9" cy="7" r="1" />
        <path d="M3 3v6M3 4h3a3 3 0 0 1 3 2" />
      </svg>
    );
  }
  if (role === "system") {
    // 6-tooth cog: outer tooth ring + inner hub circle.
    return (
      <svg {...common}>
        <path d="M5.1 1.2h1.8l.3 1.4a3.5 3.5 0 0 1 1.2.7l1.4-.5.9 1.6-1.1 1a3.5 3.5 0 0 1 0 1.4l1.1 1-.9 1.6-1.4-.5a3.5 3.5 0 0 1-1.2.7l-.3 1.4H5.1l-.3-1.4a3.5 3.5 0 0 1-1.2-.7l-1.4.5-.9-1.6 1.1-1a3.5 3.5 0 0 1 0-1.4l-1.1-1 .9-1.6 1.4.5a3.5 3.5 0 0 1 1.2-.7l.3-1.4Z" />
        <circle cx="6" cy="6" r="1.6" />
      </svg>
    );
  }
  // assistant: robot head with antenna + two eyes.
  return (
    <svg {...common}>
      <rect x="2.5" y="4" width="7" height="6" rx="1.6" />
      <path d="M6 4V2.2" />
      <circle cx="6" cy="1.6" r="0.6" />
      <path d="M4.5 7h.01M7.5 7h.01" strokeWidth="1.8" />
    </svg>
  );
}

function OutlineBody({ entries, loading, error, onRetryLoad, readingEntryId, targetEntryId, navigating, onJump }: Omit<SessionOutlineProps, "variant" | "onClose" | "triggerRef">) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  // #135: tool-group expansion is local component state, keyed by the group's
  // first member id; collapsed by default.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Keep the current-reading row visible inside the outline's OWN scroll area
  // (never touches the transcript scroll position).
  useEffect(() => {
    const list = listRef.current;
    const item = activeItemRef.current;
    if (!list || !item) return;
    // offsetTop is relative to the positioned drawer panel / chat row, not
    // this list — use rect deltas so the math is list-relative in both modes.
    const itemTop = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const itemBottom = itemTop + item.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (itemTop < viewTop || itemBottom > viewBottom) {
      list.scrollTop = Math.max(0, itemTop - Math.round(list.clientHeight / 3));
    }
  }, [readingEntryId, targetEntryId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loading && entries.length === 0 && (
        <div role="status" data-testid="outline-loading" className="flex items-center gap-2 px-3 py-3 text-xs text-text-muted">
          <span className="inline-block h-3 w-3 animate-[spin_1s_linear_infinite] rounded-full border-[1.5px] border-border border-t-[var(--accent)]" aria-hidden="true" />
          {t("outline.loading")}
        </div>
      )}
      {error && (
        <div role="alert" data-testid="outline-error" className="mx-3 my-2 rounded-lg border border-[color-mix(in_srgb,#ef4444_35%,var(--border))] bg-[color-mix(in_srgb,#ef4444_10%,var(--bg-panel))] px-3 py-2 text-xs text-[#ef4444]">
          <div className="mb-1 font-medium">{t("outline.loadFailed")}</div>
          <div className="mb-2 break-words text-[11px] opacity-80">{error}</div>
          <button
            type="button"
            data-testid="outline-retry"
            onClick={onRetryLoad}
            className="rounded-full border border-border bg-bg px-3 py-1 text-[11px] text-text-muted transition-colors hover:text-text"
          >
            {t("outline.retry")}
          </button>
        </div>
      )}
      {!loading && !error && entries.length === 0 && (
        <div data-testid="outline-empty" className="px-3 py-3 text-xs text-text-dim">
          {t("outline.empty")}
        </div>
      )}
      <div ref={listRef} role="list" aria-label={t("outline.title")} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {groupOutlineEntries(entries).flatMap((row) => {
          const isToolGroup = row.kind === "toolGroup";
          const entry = row.kind === "toolGroup" ? row.entries[0] : row.entry;
          const expanded = isToolGroup && expandedGroups[entry.entryId] === true;
          const renderEntryRow = (item: SessionOutlineEntry, inGroup: boolean) => {
            // Tools are de-emphasized: dim glyph, no accent, slightly faded row.
            const subdued = isToolCategoryEntry(item);
            const isReading = readingEntryId === item.entryId;
            const isTarget = targetEntryId === item.entryId;
            const time = formatOutlineTime(item.timestamp);
            // #135: title rows render no transcript block — jump to their anchor.
            const jumpId = item.role === "title" ? item.anchorEntryId ?? item.entryId : item.entryId;
            const jobsTooltip = item.jobs && item.jobs.length > 0
              ? item.jobs.map((job) => `${job.name}: ${jobStatusLabel(job.status, t)}`).join("\n")
              : undefined;
            return (
              <div key={item.entryId} role="listitem">
              <button
                ref={isReading ? activeItemRef : undefined}
                type="button"
                data-outline-entry={item.entryId}
                data-outline-subdued={subdued ? "true" : undefined}
                data-outline-group-member={inGroup ? "true" : undefined}
                aria-current={isReading ? "location" : undefined}
                aria-label={t("outline.jumpLabel", { index: item.ordinal + 1, preview: item.preview })}
                onClick={() => onJump(jumpId)}
                className="mb-1 block w-full min-w-0 rounded-lg border px-2 py-1.5 text-left transition-colors"
                style={{
                  borderColor: isTarget || isReading ? "var(--accent)" : "transparent",
                  background: isReading ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                  opacity: subdued ? 0.75 : undefined,
                }}
              >
                <span className="flex min-w-0 items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
                    style={{
                      color: subdued ? "var(--text-dim)" : item.role === "ask" || item.role === "user" ? "var(--accent)" : item.role === "assistant" ? "var(--success)" : item.role === "summary" ? "#d97706" : item.role === "subagent" ? "#8b5cf6" : item.role === "system" ? "#0d9488" : item.role === "title" ? "#d97706" : "var(--text-muted)",
                      background: "color-mix(in srgb, var(--text-dim) 12%, transparent)",
                    }}
                  >
                    <RoleGlyph role={item.role} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block overflow-hidden text-xs leading-snug text-text"
                      style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}
                    >
                      {item.preview}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-dim">
                      <span className="flex-shrink-0 tabular-nums">#{item.ordinal + 1}</span>
                      <span className="flex-shrink-0">{roleLabel(item.role, t)}</span>
                      {item.jobStatus && <JobStatusBadge status={item.jobStatus} label={jobStatusLabel(item.jobStatus, t)} />}
                      {item.jobs && item.jobs.length > 1 && (
                        <span className="flex flex-shrink-0 items-center gap-0.5" title={jobsTooltip}>
                          {item.jobs.slice(0, 8).map((job) => (
                            <JobStatusBadge key={job.id} status={job.status} label={`${job.name}: ${jobStatusLabel(job.status, t)}`} />
                          ))}
                          {item.jobs.length > 8 && <span className="tabular-nums">+{item.jobs.length - 8}</span>}
                        </span>
                      )}
                      {time && <span className="flex-shrink-0 tabular-nums">{time}</span>}
                      {isTarget && navigating && (
                        <span className="inline-block h-2.5 w-2.5 flex-shrink-0 animate-[spin_1s_linear_infinite] rounded-full border border-border border-t-[var(--accent)]" aria-hidden="true" />
                      )}
                    </span>
                  </span>
                </span>
              </button>
              </div>
            );
          };
          if (!isToolGroup) return [renderEntryRow(entry, false)];
          // #135: collapsed groups keep the first-member jump affordance;
          // expanding reveals individual rows with their per-category glyphs.
          const groupRows = expanded ? row.entries.map((member) => renderEntryRow(member, true)) : [];
          const isReading = row.entries.some((member) => member.entryId === readingEntryId);
          const isTarget = row.entries.some((member) => member.entryId === targetEntryId);
          const time = formatOutlineTime(entry.timestamp);
          const categoryGlyphs = [...new Set(row.entries.map((member) => member.role === "assistant" ? "tool" : member.role))];
          const header = (
            <div key={`${entry.entryId}-group`} role="listitem">
            <div className="mb-1 flex w-full min-w-0 items-stretch gap-1">
            <button
              ref={isReading || isTarget ? activeItemRef : undefined}
              type="button"
              data-outline-entry={entry.entryId}
              data-outline-subdued="true"
              aria-current={isReading ? "location" : undefined}
              aria-label={t("outline.jumpLabel", { index: entry.ordinal + 1, preview: entry.preview })}
              onClick={() => onJump(entry.entryId)}
              className="block min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-left transition-colors"
              style={{
                borderColor: isTarget || isReading ? "var(--accent)" : "transparent",
                background: isReading ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                opacity: 0.75,
              }}
            >
              <span className="flex min-w-0 items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
                  style={{ color: "var(--text-dim)", background: "color-mix(in srgb, var(--text-dim) 12%, transparent)" }}
                >
                  <RoleGlyph role="tools" />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block overflow-hidden text-xs leading-snug text-text"
                    style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}
                  >
                    {entry.preview}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-dim">
                    <span className="flex-shrink-0 tabular-nums">#{entry.ordinal + 1}</span>
                    <span className="flex-shrink-0">{t("outline.roleTools")}</span>
                    <span
                      className="flex-shrink-0 rounded-full px-1.5 py-0.5 tabular-nums"
                      style={{ color: "var(--text-dim)", background: "color-mix(in srgb, var(--text-dim) 15%, transparent)" }}
                    >
                      ×{row.entries.length}
                    </span>
                    {categoryGlyphs.length > 1 && (
                      <span className="flex flex-shrink-0 items-center gap-0.5" aria-hidden="true">
                        {categoryGlyphs.map((role) => <RoleGlyph key={role} role={role} />)}
                      </span>
                    )}
                    {time && <span className="flex-shrink-0 tabular-nums">{time}</span>}
                    {isTarget && navigating && (
                      <span className="inline-block h-2.5 w-2.5 flex-shrink-0 animate-[spin_1s_linear_infinite] rounded-full border border-border border-t-[var(--accent)]" aria-hidden="true" />
                    )}
                  </span>
                </span>
              </span>
            </button>
            <button
              type="button"
              data-outline-group-toggle={entry.entryId}
              aria-expanded={expanded}
              aria-label={expanded ? t("outline.collapseTools") : t("outline.expandTools")}
              onClick={() => setExpandedGroups((current) => ({ ...current, [entry.entryId]: !expanded }))}
              className="flex w-6 flex-shrink-0 items-center justify-center rounded-lg text-text-dim transition-colors hover:bg-bg-panel hover:text-text"
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: expanded ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}>
                <path d="M4 2.5l4 3.5-4 3.5" />
              </svg>
            </button>
            </div>
            </div>
          );
          return [header, ...groupRows];
        })}
      </div>
    </div>
  );
}

function OutlineHeader({ count, onClose, showClose }: { count: number; onClose: () => void; showClose: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text">{t("outline.title")}</span>
      <span className="flex-shrink-0 text-[10px] tabular-nums text-text-dim">{t("outline.count", { count })}</span>
      {showClose && (
        <button
          type="button"
          data-testid="outline-close"
          aria-label={t("outline.close")}
          onClick={onClose}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-panel hover:text-text"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function SessionOutline(props: SessionOutlineProps) {
  const { variant, onClose, triggerRef } = props;
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const isDrawer = variant === "drawer";

  // Drawer only: Escape from INSIDE the drawer must never reach the global
  // window keydown handler that aborts the running agent. A window CAPTURE
  // listener runs before React's root handlers and the global bubble-phase
  // abort listener — but only consumes Escape when the event originates in
  // the drawer panel (focused target guard), so higher overlays
  // (ExtensionDialog) and composer menus keep their own Escape handling.
  useEffect(() => {
    if (!isDrawer) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const panel = panelRef.current;
      if (!panel) return;
      const target = event.target as Node | null;
      const active = document.activeElement;
      const insidePanel = (target !== null && panel.contains(target)) || (active !== null && panel.contains(active));
      if (!insidePanel) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isDrawer, onClose]);

  // Drawer only: initial focus + focus restore to the trigger on close.
  useEffect(() => {
    if (!isDrawer) return;
    const previous = document.activeElement as HTMLElement | null;
    // Capture the trigger node now — reading triggerRef.current in cleanup
    // could see a detached/replaced node after re-renders.
    const triggerNode = triggerRef?.current ?? null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      const target = triggerNode ?? previous;
      target?.focus?.();
    };
  }, [isDrawer, triggerRef]);

  const trapTab = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("disabled"));
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const body = (
    <>
      <OutlineHeader count={props.entries.length} onClose={onClose} showClose={isDrawer} />
      <OutlineBody {...props} />
    </>
  );

  if (!isDrawer) {
    return (
      <aside
        id="session-outline-panel"
        data-testid="session-outline-rail"
        aria-label={t("outline.title")}
        className="flex h-full w-[260px] flex-shrink-0 flex-col border-l border-border bg-bg"
      >
        {body}
      </aside>
    );
  }

  return (
    <div className="absolute inset-0 z-[70]" data-testid="session-outline-drawer">
      <div
        data-testid="outline-backdrop"
        aria-hidden="true"
        onMouseDown={onClose}
        className="absolute inset-0 bg-[rgba(0,0,0,0.26)]"
      />
      <div
        ref={panelRef}
        id="session-outline-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("outline.title")}
        tabIndex={-1}
        onKeyDown={trapTab}
        className="absolute bottom-0 right-0 top-0 flex flex-col border-l border-border bg-bg shadow-[-12px_0_32px_rgba(0,0,0,0.18)]"
        style={{ width: "min(320px, calc(100% - 48px))" }}
      >
        {body}
      </div>
    </div>
  );
}
