"use client";

/**
 * Amber warning icon on the provider status strip (#147).
 *
 * The `enabledModels` allow-list hides models without saying which ones, and a
 * scope pattern that matches nothing is easy to miss. Both used to occupy a
 * banner row above the composer; they now collapse into this one icon, which
 * is the collapsed state (there is no "never show again" switch).
 *
 * Hover or keyboard focus opens a popover with the per-provider split and the
 * hidden model ids; activating the icon (or the popover action) opens
 * Settings → Models → the allow-list tab for this session's cwd.
 *
 * The scoped `/api/models` response carries counts only, so the ids are fetched
 * lazily from the unscoped listing on first open and kept in memory for the
 * session (ChatWindow is re-keyed per session, so a ref is that cache).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiPath } from "@/lib/api-path";
import type { ModelCatalogEntry } from "@/lib/models-cache";
import { providerLabel } from "@/lib/provider-label";

/**
 * Ids listed per provider before the rest is stated in words.
 *
 * Measured in the browser with the gateway-shaped fixture (629/37/22/8 hidden):
 * the popover's fixed content (title, total, four provider rows, action) is
 * ~211px and every id line is 16.5px, so the 30-id default came to 1714px and
 * scrolled inside a 560px box at 1280×800. Eight ids per provider put the
 * default popover at 778px, inside the 784px an 800px viewport allows and far
 * inside 1080px, with no scrollbar; `max-height` below is the fallback for
 * viewports shorter than that.
 */
export const HIDDEN_IDS_CAP = 8;

/** How long the pointer may take to travel from the icon into the popover. */
const CLOSE_DELAY_MS = 180;

export interface HiddenProviderSummary {
  provider: string;
  hidden: number;
  visible: number;
}

export interface HiddenProviderGroup extends HiddenProviderSummary {
  ids: string[];
}

/** The icon exists when anything is hidden or a scope pattern matched nothing. */
export function hiddenNoticeVisible(hiddenModelCount?: number, warnings?: string[]): boolean {
  return (hiddenModelCount ?? 0) > 0 || (warnings?.length ?? 0) > 0;
}

/**
 * Groups the unscoped listing's hidden entries under the summary's provider
 * order (hidden descending, then provider name). A provider whose ids are not
 * loaded yet — or a remote that omits the `hidden` flag — keeps its counts and
 * an empty list, so the popover degrades to counts only.
 */
export function groupHiddenModels(
  entries: Pick<ModelCatalogEntry, "id" | "provider" | "hidden">[],
  summary: HiddenProviderSummary[],
): HiddenProviderGroup[] {
  const byProvider = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.hidden !== true) continue;
    const ids = byProvider.get(entry.provider);
    if (ids) ids.push(entry.id);
    else byProvider.set(entry.provider, [entry.id]);
  }
  const groups: HiddenProviderGroup[] = summary.map((row) => ({
    ...row,
    ids: byProvider.get(row.provider) ?? [],
  }));
  const listed = new Set(summary.map((row) => row.provider));
  for (const [provider, ids] of byProvider) {
    if (listed.has(provider)) continue;
    groups.push({ provider, hidden: ids.length, visible: 0, ids });
  }
  return groups;
}

/** Ids to render for one group, plus how many are stated in words instead. */
export function capHiddenIds(ids: string[], cap = HIDDEN_IDS_CAP): { shown: string[]; overflow: number } {
  return { shown: ids.slice(0, cap), overflow: Math.max(0, ids.length - cap) };
}

export interface PopoverAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Anchors the popover under the icon, clamped inside the viewport, flipped
 * above the icon when it would overflow the bottom edge, and — when it fits
 * neither above nor below — stood beside the icon.
 *
 * The last case matters: a popover tall enough to be clamped to the viewport
 * would cover the icon it belongs to, and a covered icon cannot be clicked.
 */
export function placePopover(
  anchor: PopoverAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
): { top: number; left: number } {
  const margin = 8;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const clampLeft = (value: number) => Math.min(Math.max(value, margin), maxLeft);
  const below = anchor.bottom + gap;
  if (below + size.height <= viewport.height - margin) return { top: below, left: clampLeft(anchor.left) };
  const above = anchor.top - gap - size.height;
  if (above >= margin) return { top: above, left: clampLeft(anchor.left) };
  const besideLeft = anchor.left - size.width - gap;
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  return {
    top: Math.min(Math.max(anchor.top - size.height / 2, margin), maxTop),
    left: clampLeft(besideLeft >= margin ? besideLeft : anchor.right + gap),
  };
}

interface PopoverProps {
  hiddenModelCount?: number;
  groups: HiddenProviderGroup[];
  warnings: string[];
  /** Ids are still being fetched, or the remote omitted the flags. */
  countsOnly: boolean;
  /** Display names by provider id; an unknown id falls back to the id. */
  names?: Record<string, string>;
  onOpenAllowList: () => void;
}

/**
 * Popover body, kept free of positioning and hover state so the content —
 * provider order, counts, the id cap and the scope-warning section — is
 * renderable on its own.
 */
export function HiddenModelsPopover({ hiddenModelCount, groups, warnings, countsOnly, names, onOpenAllowList }: PopoverProps) {
  const { t } = useI18n();
  const overflowTotal = groups.reduce((sum, group) => sum + capHiddenIds(group.ids).overflow, 0);
  return (
    <>
      <div style={{ fontWeight: 600, color: "var(--warning)" }}>{t("providerStatus.hiddenTitle")}</div>
      {hiddenModelCount !== undefined && hiddenModelCount > 0 && (
        <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>
          {t("providerStatus.hiddenTotal", { count: hiddenModelCount })}
        </div>
      )}
      {groups.map((group) => {
        // Counts only while the ids load, and for a remote that omits the flags.
        const { shown, overflow } = countsOnly ? { shown: [], overflow: 0 } : capHiddenIds(group.ids);
        return (
          <div key={group.provider} style={{ marginTop: 6 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontWeight: 600 }}>{providerLabel(group.provider, names)}</span>
              <span style={{ color: "var(--text-muted)" }}>
                {t("providerStatus.hiddenProviderCounts", { hidden: group.hidden, visible: group.visible })}
              </span>
            </div>
            {shown.length > 0 && (
              <ul style={{ margin: "2px 0 0", paddingLeft: 16, color: "var(--text-muted)" }}>
                {shown.map((id) => (
                  <li key={id} style={{ overflowWrap: "anywhere" }}>{id}</li>
                ))}
              </ul>
            )}
            {overflow > 0 && <div style={{ color: "var(--text-dim)" }}>{t("providerStatus.hiddenMore", { count: overflow })}</div>}
          </div>
        );
      })}
      {warnings.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>{t("providerStatus.hiddenWarningsTitle")}</div>
          {warnings.map((warning) => (
            <div key={warning} style={{ color: "var(--text-muted)", overflowWrap: "anywhere" }}>{warning}</div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpenAllowList();
        }}
        style={{
          marginTop: 8,
          padding: "3px 8px",
          border: "1px solid rgba(234,179,8,0.45)",
          borderRadius: 4,
          background: "rgba(234,179,8,0.1)",
          color: "var(--warning)",
          fontFamily: "inherit",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        {t("providerStatus.hiddenAction")}
        {overflowTotal > 0 && (
          <span style={{ marginLeft: 6, color: "var(--text-dim)" }}>
            {t("providerStatus.hiddenMore", { count: overflowTotal })}
          </span>
        )}
      </button>
    </>
  );
}

interface Props {
  /** Models that exist but the `enabledModels` allow-list hides. */
  hiddenModelCount?: number;
  /** Per-provider split of `hiddenModelCount`, most hidden first. */
  hiddenByProvider?: HiddenProviderSummary[];
  /** `enabledModels` patterns that matched nothing. */
  warnings?: string[];
  /** Session cwd; the lazy id fetch is scoped to it. */
  cwd?: string | null;
  /** Display names by provider id, from the provider-status snapshot. */
  names?: Record<string, string>;
  /** Opens Settings on Models → allow-list. */
  onOpenAllowList: () => void;
}

export function HiddenModelsNotice({ hiddenModelCount, hiddenByProvider, warnings = [], cwd, names, onOpenAllowList }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ModelCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const cacheRef = useRef<{ key: string; entries: ModelCatalogEntry[] } | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const visible = hiddenNoticeVisible(hiddenModelCount, warnings);
  const cacheKey = `${cwd ?? ""}|${hiddenModelCount ?? 0}`;

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, []);

  // Lazy id fetch: first open, and again when the hidden count changes.
  useEffect(() => {
    if (!open) return;
    const cached = cacheRef.current;
    if (cached && cached.key === cacheKey) {
      setEntries(cached.entries);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const query = cwd ? `/api/models?all=1&cwd=${encodeURIComponent(cwd)}` : "/api/models?all=1";
    fetch(apiPath(query))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { modelList?: ModelCatalogEntry[] } | null) => {
        if (cancelled) return;
        const list = data?.modelList ?? [];
        cacheRef.current = { key: cacheKey, entries: list };
        setEntries(list);
      })
      .catch(() => {
        if (!cancelled) setEntries(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cacheKey, cwd]);

  // Anchor to the icon, clamped to the viewport, flipped above when needed.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const popover = popoverRef.current?.getBoundingClientRect();
      if (!anchor || !popover) return;
      const next = placePopover(anchor, { width: popover.width, height: popover.height }, { width: window.innerWidth, height: window.innerHeight });
      setPosition((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, entries, loading, hiddenModelCount, warnings.length]);

  if (!visible) return null;

  const groups = groupHiddenModels(entries ?? [], hiddenByProvider ?? []);
  const activate = () => {
    cancelClose();
    setOpen(false);
    onOpenAllowList();
  };

  return (
    <span
      style={{ position: "relative", flexShrink: 0, display: "inline-flex", alignItems: "center" }}
      onPointerEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={scheduleClose}
    >
      <button
        ref={anchorRef}
        type="button"
        aria-label={t("providerStatus.hiddenIcon")}
        aria-expanded={open}
        onFocus={() => {
          cancelClose();
          setOpen(true);
        }}
        onBlur={(event) => {
          if (popoverRef.current?.contains(event.relatedTarget as Node | null)) return;
          scheduleClose();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          activate();
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          padding: 0,
          border: "none",
          borderRadius: 3,
          background: "transparent",
          color: "var(--warning)",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t("providerStatus.hiddenTitle")}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          style={{
            position: "fixed",
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position === null ? "hidden" : "visible",
            zIndex: 400,
            minWidth: 260,
            maxWidth: 360,
            maxHeight: "calc(100vh - 16px)",
            overflowY: "auto",
            scrollbarWidth: "thin",
            scrollbarColor: "var(--border) transparent",
            padding: "8px 10px",
            border: "1px solid rgba(234,179,8,0.35)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: "normal",
          }}
        >
          <HiddenModelsPopover
            hiddenModelCount={hiddenModelCount}
            groups={groups}
            warnings={warnings}
            countsOnly={loading || entries === null}
            names={names}
            onOpenAllowList={activate}
          />
        </div>
      )}
    </span>
  );
}