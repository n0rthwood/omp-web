"use client";
import { useCallback, useEffect, useRef } from "react";
import type { SessionOutlineEntry } from "@/lib/session-outline";
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
  return t("outline.roleAssistant");
}

function RoleGlyph({ role }: { role: SessionOutlineEntry["role"] }) {
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
  return (
    <svg {...common}>
      <rect x="2" y="3" width="8" height="6.5" rx="1.6" />
      <path d="M4.4 6h.01M7.6 6h.01" strokeWidth="1.8" />
    </svg>
  );
}

function OutlineBody({ entries, loading, error, onRetryLoad, readingEntryId, targetEntryId, navigating, onJump }: Omit<SessionOutlineProps, "variant" | "onClose" | "triggerRef">) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

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
  }, [readingEntryId]);

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
        {entries.map((entry) => {
          const isReading = readingEntryId === entry.entryId;
          const isTarget = targetEntryId === entry.entryId;
          const time = formatOutlineTime(entry.timestamp);
          return (
            <div key={entry.entryId} role="listitem">
            <button
              ref={isReading ? activeItemRef : undefined}
              type="button"
              data-outline-entry={entry.entryId}
              aria-current={isReading ? "location" : undefined}
              aria-label={t("outline.jumpLabel", { index: entry.ordinal + 1, preview: entry.preview })}
              onClick={() => onJump(entry.entryId)}
              className="mb-1 block w-full min-w-0 rounded-lg border px-2 py-1.5 text-left transition-colors"
              style={{
                borderColor: isTarget ? "var(--accent)" : isReading ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "transparent",
                background: isReading ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
              }}
            >
              <span className="flex min-w-0 items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
                  style={{
                    color: entry.role === "user" ? "var(--accent)" : entry.role === "summary" ? "#d97706" : "var(--text-muted)",
                    background: "color-mix(in srgb, var(--text-dim) 12%, transparent)",
                  }}
                >
                  <RoleGlyph role={entry.role} />
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
                    <span className="flex-shrink-0">{roleLabel(entry.role, t)}</span>
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
