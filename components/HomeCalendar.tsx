"use client";

/**
 * The weekly conversation calendar for one project (issue #15). Seven day
 * sections for the selected week, conversations grouped by their `modified`
 * local day, full untruncated titles, GitHub-issue annotation chips parsed
 * from web-generated titles (`lib/title-annotations.ts`), and week
 * navigation (current week by default).
 */

import { useMemo, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { daysOfWeek, groupSessionsByDay, localDayKey, weekStartDate, weekStartsOnFromIntlFirstDay, type WeekStartsOn } from "@/lib/calendar-week";
import { parseTitleAnnotations } from "@/lib/title-annotations";
import { useI18n } from "@/hooks/useI18n";
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

export function HomeCalendar({ machineId, project, sessions }: {
  machineId: string;
  project: string;
  sessions: SessionInfo[];
}) {
  const { locale, t } = useI18n();
  const { navigate } = useNavigation();
  const [weekOffset, setWeekOffset] = useState(0);

  const firstWeekday: WeekStartsOn = useMemo(() => {
    try {
      // `weekInfo` is not in TS's Intl typings yet (stage-3).
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
    // "Today" rolling over mid-session doesn't merit a re-render loop; the
    // week re-anchors on the next offset/locale change.
  }, [firstWeekday, weekOffset]);

  const days = useMemo(() => daysOfWeek(start), [start]);
  const byDay = useMemo(() => groupSessionsByDay(sessions), [sessions]);
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

  return (
    <section aria-label={project}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "28px 0 12px" }}>
        <h2 style={{ margin: 0, color: "var(--text)", fontSize: 15, fontWeight: 600, flex: 1 }}>{weekLabel}</h2>
        <button type="button" style={navButtonStyle} onClick={() => setWeekOffset((w) => w - 1)} title={t("home.previousWeek")}>‹</button>
        <button type="button" style={navButtonStyle} onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>{t("home.currentWeek")}</button>
        <button type="button" style={navButtonStyle} onClick={() => setWeekOffset((w) => w + 1)} title={t("home.nextWeek")}>›</button>
      </div>
      {days.map((day) => {
        const key = localDayKey(day);
        const daySessions = byDay.get(key) ?? [];
        return (
          <div key={key} style={{ borderBottom: "1px solid var(--border)", padding: "10px 0" }}>
            <div style={{ color: key === todayKey ? "var(--accent)" : "var(--text-dim)", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              {new Intl.DateTimeFormat(locale, { weekday: "long", month: "short", day: "numeric" }).format(day)}
            </div>
            {daySessions.length === 0 ? (
              <div style={{ color: "var(--text-dim)", fontSize: 12.5, padding: "2px 0 4px" }}>—</div>
            ) : (
              daySessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => navigate({ machineId, project, session: session.id }, { history: "push" })}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    background: "transparent", border: "none", borderRadius: 8,
                    color: "var(--text)", cursor: "pointer", fontSize: 13.5,
                    padding: "7px 10px", marginBottom: 2, lineHeight: 1.45,
                    whiteSpace: "normal", wordBreak: "break-word",
                  }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
                >
                  <IssueChips name={session.name ?? session.firstMessage ?? session.id} />
                </button>
              ))
            )}
          </div>
        );
      })}
      {emptyWeek && (
        <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "16px 0" }}>{t("home.noConversationsThisWeek")}</div>
      )}
    </section>
  );
}
