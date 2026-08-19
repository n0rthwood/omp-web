"use client";

/**
 * The weekly conversation calendar for one project (issue #17 redesign of
 * the #15 calendar). Day membership is always keyed on `modified` (activity
 * diary); the Modified/Started switch toggles only the within-day sort and
 * the time the card displays. Wide (>=1280px): seven equal columns with
 * equal-height clamped cards and a styled hover popover carrying the full
 * title, both timestamps, message count and first-message preview.
 * Narrower: day sections stacked vertically, full unclamped titles.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import {
  daysOfWeek,
  stackedDayOrder,
  groupSessionsByDay,
  localDayKey,
  weekStartDate,
  weekStartsOnFromIntlFirstDay,
  type SessionOrderKey,
  type WeekStartsOn,
} from "@/lib/calendar-week";
import { parseTitleAnnotations } from "@/lib/title-annotations";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { useHomeWideCalendar } from "@/hooks/useIsMobile";
import { useNavigation } from "./NavigationProvider";

const navButtonStyle: React.CSSProperties = {
  background: "var(--bg-hover)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "pointer",
  height: 30,
  padding: "0 12px",
  borderRadius: 7,
  fontSize: 12.5,
  fontWeight: 500,
  flexShrink: 0,
};

const chipBase: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 999,
  fontSize: 11.5,
  verticalAlign: "middle",
  whiteSpace: "nowrap",
  textDecoration: "none",
};

function IssueChips({ name }: { name: string }) {
  const { t } = useI18n();
  const { text, annotations } = useMemo(() => parseTitleAnnotations(name), [name]);
  return (
    <>
      {text}
      {annotations?.main.map((n) => (
        <a
          key={`m${n}`}
          href={`https://github.com/n0rthwood/omp-web/issues/${n}`}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          title={t("home.mainIssues")}
          style={{
            ...chipBase,
            marginLeft: 8,
            fontWeight: 600,
            background: "color-mix(in srgb, var(--accent) 16%, transparent)",
            color: "var(--accent)",
            border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)",
          }}
        >
          #{n}
        </a>
      ))}
      {annotations?.related.map((n) => (
        <a
          key={`r${n}`}
          href={`https://github.com/n0rthwood/omp-web/issues/${n}`}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => event.stopPropagation()}
          title={t("home.relatedIssues")}
          style={{
            ...chipBase,
            marginLeft: 6,
            fontWeight: 500,
            background: "var(--bg-subtle)",
            color: "var(--text-dim)",
            border: "1px solid var(--border)",
          }}
        >
          rel #{n}
        </a>
      ))}
    </>
  );
}

const pad2 = (n: number) => `${n}`.padStart(2, "0");

/** `MM-DD HH:MM:SS`, local, deterministic across locales. */
function metaStamp(date: Date): string {
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** `YYYY-MM-DD HH:MM:SS` for the popover's labeled rows. */
function fullStamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

const POPOVER_WIDTH = 340;

interface PopoverState {
  session: SessionInfo;
  left: number;
  top: number;
  placeAbove: boolean;
}

export function HomeCalendar({ machineId, machineName, project, sessions }: {
  machineId: string;
  machineName?: string;
  project: string;
  sessions: SessionInfo[];
}) {
  const { locale, t } = useI18n();
  const { navigate } = useNavigation();
  const wide = useHomeWideCalendar();
  const [weekOffset, setWeekOffset] = useState(0);
  const [orderKey, setOrderKey] = useState<SessionOrderKey>("modified");
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const popoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    if (popoverTimerRef.current) clearTimeout(popoverTimerRef.current);
  }, []);

  const firstWeekday: WeekStartsOn = useMemo(() => {
    try {
      const info = new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay?: number } };
      return weekStartsOnFromIntlFirstDay(info.weekInfo?.firstDay);
    } catch {
      return 1;
    }
  }, [locale]);

  const start = useMemo(() => {
    const date = weekStartDate(new Date(), firstWeekday);
    date.setDate(date.getDate() + weekOffset * 7);
    return date;
  }, [firstWeekday, weekOffset]);

  const days = useMemo(() => daysOfWeek(start), [start]);
  const byDay = useMemo(() => groupSessionsByDay(sessions, orderKey), [sessions, orderKey]);
  // Narrow/stacked view orders days by recency (latest conversations on
  // top, empty placeholder days after) — see lib/calendar-week.ts #17.
  const stackedDays = useMemo(() => stackedDayOrder(days, byDay), [days, byDay]);
  const todayKey = localDayKey(new Date());

  const weekLabel = useMemo(() => {
    const end = days[days.length - 1];
    const startFmt = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
    const endFmt = start.getMonth() === end.getMonth()
      ? new Intl.DateTimeFormat(locale, { day: "numeric" })
      : startFmt;
    const yearSuffix = start.getFullYear() !== end.getFullYear() ? ` ${end.getFullYear()}` : "";
    return `${startFmt.format(start)} – ${endFmt.format(end)}${yearSuffix}`;
  }, [start, days, locale]);

  const emptyWeek = days.every((day) => (byDay.get(localDayKey(day)) ?? []).length === 0);

  const openPopover = (session: SessionInfo, element: HTMLElement) => {
    if (popoverTimerRef.current) clearTimeout(popoverTimerRef.current);
    const rect = element.getBoundingClientRect();
    popoverTimerRef.current = setTimeout(() => {
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      setPopover({
        session,
        left: Math.min(Math.max(8, rect.left), Math.max(8, vw - POPOVER_WIDTH - 8)),
        top: rect.bottom + 6,
        placeAbove: rect.bottom + 300 > vh,
      });
    }, 80);
  };

  const closePopover = () => {
    if (popoverTimerRef.current) clearTimeout(popoverTimerRef.current);
    setPopover(null);
  };

  useEffect(() => {
    if (!wide) closePopover();
  }, [wide]);

  useEffect(() => {
    if (popover === null) return;
    window.addEventListener("scroll", closePopover, { capture: true, passive: true });
    window.addEventListener("resize", closePopover, { passive: true });
    return () => {
      window.removeEventListener("scroll", closePopover, { capture: true });
      window.removeEventListener("resize", closePopover);
    };
  }, [popover]);

  useLayoutEffect(() => {
    if (!popover) return;
    const el = popoverRef.current;
    if (!el) return;
    const vh = window.innerHeight || 800;
    const rect = el.getBoundingClientRect();
    let clampedTop: number | null = null;
    if (rect.bottom > vh) {
      clampedTop = Math.max(8, vh - rect.height - 8);
    } else if (rect.top < 8) {
      clampedTop = 8;
    }
    if (clampedTop !== null && (popover.top !== clampedTop || popover.placeAbove)) {
      const nextTop = clampedTop;
      setPopover((prev) => (prev ? { ...prev, top: nextTop, placeAbove: false } : prev));
    }
  }, [popover]);

  const dayLabel = (day: Date) =>
    new Intl.DateTimeFormat(locale, wide
      ? { weekday: "short", day: "numeric" }
      : { weekday: "long", month: "short", day: "numeric" }).format(day);

  const renderCard = (session: SessionInfo) => {
    const name = session.name ?? session.firstMessage ?? session.id;
    const activeTime = orderKey === "created" ? session.created : session.modified;
    const activeDate = new Date(activeTime);
    const stamp = metaStamp(activeDate);
    const relative = formatRelativeTime(activeDate, locale);
    return (
      <button
        key={session.id}
        type="button"
        onClick={() => navigate({ machineId, project, session: session.id }, { history: "push" })}
        onMouseEnter={wide ? (event) => openPopover(session, event.currentTarget) : undefined}
        onMouseLeave={wide ? (event) => { if (event.currentTarget !== document.activeElement) closePopover(); } : undefined}
        onFocus={wide ? (event) => openPopover(session, event.currentTarget) : undefined}
        onBlur={wide ? (event) => { if (!event.currentTarget.matches(":hover")) closePopover(); } : undefined}
        aria-describedby={popover && popover.session.id === session.id ? "home-card-popover" : undefined}
        title={name}
        style={{
          width: "100%",
          textAlign: "left",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 13,
          padding: wide ? "6px 8px" : "8px 10px",
          ...(wide ? { height: 80, overflow: "hidden" } : { marginBottom: 6 }),
          display: wide ? "flex" : "block",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {wide ? (
          <>
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {stamp}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {relative}
            </span>
            <span style={{
              fontSize: 12.5,
              lineHeight: 1.3,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              wordBreak: "break-word",
            }}>
              <IssueChips name={name} />
            </span>
          </>
        ) : (
          <>
            <span style={{ display: "block", fontSize: 10.5, color: "var(--text-dim)", marginBottom: 3 }}>
              {stamp} · {relative}
            </span>
            <span style={{ display: "block", fontSize: 13, lineHeight: 1.4, wordBreak: "break-word" }}>
              <IssueChips name={name} />
            </span>
          </>
        )}
      </button>
    );
  };

  const popoverElement = popover ? (
    <div
      ref={popoverRef}
      id="home-card-popover"
      role="tooltip"
      style={{
        position: "fixed",
        left: popover.left,
        ...(popover.placeAbove
          ? { top: popover.top - 12, transform: "translateY(-100%)" }
          : { top: popover.top }),
        width: Math.min(POPOVER_WIDTH, (typeof window !== "undefined" ? window.innerWidth : 1280) * 0.9),
        maxWidth: "90vw",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,.25)",
        padding: "12px 14px",
        zIndex: 200,
        pointerEvents: "none",
        fontSize: 12.5,
        color: "var(--text)",
      }}
    >
      <div style={{ fontWeight: 600, lineHeight: 1.4, wordBreak: "break-word", marginBottom: 8 }}>
        <IssueChips name={popover.session.name ?? popover.session.firstMessage ?? popover.session.id} />
      </div>
      <div style={{ height: 1, background: "var(--border)", margin: "0 0 8px" }} />
      <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>
        {t("home.modifiedAt")}: {fullStamp(new Date(popover.session.modified))}
      </div>
      <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
        · {formatRelativeTime(new Date(popover.session.modified), locale)}
      </div>
      <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>
        {t("home.startedAt")}: {fullStamp(new Date(popover.session.created))}
      </div>
      <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
        · {formatRelativeTime(new Date(popover.session.created), locale)}
      </div>
      <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
        {t("home.messageCount", { count: String(popover.session.messageCount) })}
      </div>
      <div style={{
        color: "var(--text-dim)",
        fontSize: 12,
        lineHeight: 1.4,
        overflow: "hidden",
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: 3,
        wordBreak: "break-word",
      }}>
        {popover.session.firstMessage}
      </div>
    </div>
  ) : null;

  return (
    <section aria-label={project}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "0 0 14px" }}>
        <span style={{ color: "var(--text-dim)", fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>
          {machineName ?? machineId} · {project}
        </span>
        <div style={{ flex: 1 }} />
        <h2 style={{ margin: 0, color: "var(--text)", fontSize: 14, fontWeight: 600, flexShrink: 0 }}>{weekLabel}</h2>
        <button type="button" style={navButtonStyle} onClick={() => setWeekOffset((w) => w - 1)} title={t("home.previousWeek")}>‹</button>
        <button type="button" style={navButtonStyle} onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>{t("home.currentWeek")}</button>
        <button type="button" style={navButtonStyle} onClick={() => setWeekOffset((w) => w + 1)} title={t("home.nextWeek")}>›</button>
        <div
          role="group"
          aria-label={t("home.orderBy")}
          title={t("home.orderBy")}
          style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", flexShrink: 0 }}
        >
          {(["modified", "created"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setOrderKey(key)}
              aria-pressed={orderKey === key}
              style={{
                height: 28,
                padding: "0 10px",
                fontSize: 12,
                cursor: "pointer",
                border: "none",
                background: orderKey === key ? "var(--accent)" : "var(--bg-hover)",
                color: orderKey === key ? "#fff" : "var(--text-muted)",
                fontWeight: orderKey === key ? 600 : 500,
              }}
            >
              {t(key === "modified" ? "home.orderModified" : "home.orderStarted")}
            </button>
          ))}
        </div>
      </div>

      {wide ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, alignItems: "start" }}>
          {days.map((day) => {
            const key = localDayKey(day);
            const daySessions = byDay.get(key) ?? [];
            const isToday = key === todayKey;
            return (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 120 }}>
                <div style={{
                  color: isToday ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                  fontWeight: isToday ? 700 : 600,
                  borderBottom: "1px solid var(--border)",
                  paddingBottom: 4,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}>
                  {dayLabel(day)}
                </div>
                {daySessions.length === 0 ? (
                  <div style={{ color: "var(--text-dim)", fontSize: 11.5, textAlign: "center", padding: "14px 0" }}>—</div>
                ) : (
                  daySessions.map(renderCard)
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {stackedDays.map((day) => {
            const key = localDayKey(day);
            const daySessions = byDay.get(key) ?? [];
            const isToday = key === todayKey;
            return (
              <div key={key} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
                <div style={{ color: isToday ? "var(--accent)" : "var(--text-dim)", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  {dayLabel(day)}
                </div>
                {daySessions.length === 0 ? (
                  <div style={{ color: "var(--text-dim)", fontSize: 12.5, padding: "2px 0 4px" }}>{t("home.noConversationsDay")}</div>
                ) : (
                  daySessions.map(renderCard)
                )}
              </div>
            );
          })}
        </>
      )}

      {emptyWeek && (
        <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "16px 0" }}>{t("home.noConversationsThisWeek")}</div>
      )}
      {popoverElement}
    </section>
  );
}
