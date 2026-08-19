# Home Redesign (#17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the #15 Home screen as one screen — sticky machine/project chip header over a weekly conversation calendar — with timestamped compact cards, a ≥1280px 7-column layout, styled hover popover, and a Modified↔Started within-day order switch (day membership always keyed on `modified`).

**Architecture:** Pure client-side change over the existing data flow (`useMachines` + `fetchSessionsFor` → `GET /api/sessions`, already #14-filtered). `lib/calendar-week.ts` gains a sort-key parameter (bucketing unchanged); `HomeCalendar.tsx` and `HomePage.tsx` are rewritten in place; a new 1280px media hook joins `hooks/useIsMobile.ts`; i18n keys land in en + zh-CN lockstep. No API, SDK, or navigation changes — Home still calls `navigate()` only on conversation click.

**Tech Stack:** Next.js 16 client components, inline `React.CSSProperties` + CSS vars from `app/globals.css` (repo has NO component library / Tailwind), `node:test` files run by `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-19-home-redesign-design.md` (commits `2e59929`, `c99a818`). Issue: n0rthwood/omp-web#17.

**Repo rules that bind every task**
- NEVER run `bun run build` or `bun run dev` in the repo root (`.next/` belongs to the live service).
- Tests: `bun test <file>` (never `node --test`). Typecheck: `bun run typecheck`.
- `components/HomePage.tsx` MUST keep the exact line `const { fetchSessionsFor } = useSessionList();` and `components/AppShell.tsx` keeps `if (home) return <HomePage />;` — both pinned by regex assertions in `components/AppShell.navigation.test.mjs:110-177`. This plan does not touch AppShell at all.
- All colors via CSS vars (`--bg-panel`, `--border`, `--text`, `--text-muted`, `--text-dim`, `--accent`, `--bg-hover`, `--bg-subtle`, `--danger`) so light + titanium dark both work.
- Branch: `feature/omp17-home-redesign` off `main`. Commit messages reference #17.

---

### Task 1: `groupSessionsByDay` order-key parameter (pure logic, TDD)

**Files:**
- Modify: `lib/calendar-week.ts:40-53`
- Test: `lib/calendar-week.test.mjs`

- [ ] **Step 1: Write the failing tests** — append to `lib/calendar-week.test.mjs`:

```js
test("groupSessionsByDay: orderKey=created sorts within-day by created desc, buckets stay keyed on modified", () => {
  const noon = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  const list = [
    { id: "a", created: noon(2026, 7, 12, 8), modified: noon(2026, 7, 12, 18) },
    { id: "b", created: noon(2026, 7, 12, 10), modified: noon(2026, 7, 12, 16) },
  ];
  const grouped = groupSessionsByDay(list, "created");
  const day12 = grouped.get("2026-08-12");
  assert.ok(day12);
  // created 10:00 (b) before created 08:00 (a), even though modified order is the reverse
  assert.deepEqual(day12.map((s) => s.id), ["b", "a"]);
});

test("groupSessionsByDay: default orderKey is modified", () => {
  const noon = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  const list = [
    { id: "a", created: noon(2026, 7, 12, 8), modified: noon(2026, 7, 12, 18) },
    { id: "b", created: noon(2026, 7, 12, 10), modified: noon(2026, 7, 12, 16) },
  ];
  const grouped = groupSessionsByDay(list);
  assert.deepEqual(grouped.get("2026-08-12").map((s) => s.id), ["a", "b"]);
});

test("groupSessionsByDay: cross-midnight session stays in its modified bucket under both keys", () => {
  const at = (y, m, d, h, min) => new Date(y, m, d, h, min).toISOString();
  const list = [{ id: "x", created: at(2026, 7, 11, 23, 50), modified: at(2026, 7, 12, 0, 10) }];
  assert.ok(groupSessionsByDay(list).has("2026-08-12"));
  const byCreated = groupSessionsByDay(list, "created");
  assert.ok(byCreated.has("2026-08-12"));
  assert.equal(byCreated.get("2026-08-12").length, 1);
  assert.ok(!byCreated.has("2026-08-11"));
});

test("groupSessionsByDay: created fallback to modified when created is missing", () => {
  const noon = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  const list = [
    { id: "a", modified: noon(2026, 7, 12, 9) },
    { id: "b", modified: noon(2026, 7, 12, 14) },
  ];
  const grouped = groupSessionsByDay(list, "created");
  assert.deepEqual(grouped.get("2026-08-12").map((s) => s.id), ["b", "a"]);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun test lib/calendar-week.test.mjs`
Expected: FAIL — `groupSessionsByDay(list, "created")` compiles (extra arg ignored at runtime by the old JS) but the created-order assertions mismatch, OR typecheck-level arg-count error at runtime none — the first test's `["b","a"]` deepEqual fails against old modified-sort output `["a","b"]`.

- [ ] **Step 3: Implement** — replace `lib/calendar-week.ts:40-53` with:

```ts
/** Within-day sort key: last activity (`modified`) or session start (`created`). */
export type SessionOrderKey = "modified" | "created";

/**
 * Groups sessions by their `modified` local day (the calendar is an activity
 * diary — day membership never changes with the order switch); within a day,
 * most recent first by the chosen key. Sessions lacking `created` fall back
 * to `modified` for sorting.
 */
export function groupSessionsByDay<S extends { modified: string; created?: string }>(
  sessions: S[],
  orderKey: SessionOrderKey = "modified",
): Map<string, S[]> {
  const sortValue = (session: S): string =>
    orderKey === "created" ? session.created ?? session.modified : session.modified;
  const grouped = new Map<string, S[]>();
  for (const session of sessions) {
    const key = localDayKey(new Date(session.modified));
    const bucket = grouped.get(key);
    if (bucket) bucket.push(session);
    else grouped.set(key, [session]);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
  }
  return grouped;
}
```

- [ ] **Step 4: Run tests** — `bun test lib/calendar-week.test.mjs` → all PASS (11 old + 4 new).

- [ ] **Step 5: Commit**

```bash
git add lib/calendar-week.ts lib/calendar-week.test.mjs
git commit -m "feat: groupSessionsByDay order-key param, buckets stay modified-keyed (refs #17)"
```

---

### Task 2: wide-calendar media hook

**Files:**
- Modify: `hooks/useIsMobile.ts` (append; keep existing `useIsMobile` untouched)

- [ ] **Step 1: Append to `hooks/useIsMobile.ts`:**

```ts
// Home calendar wide breakpoint (issue #17): 7-column week view at >=1280px.
const HOME_WIDE_QUERY = "(min-width: 1280px)";

function subscribeWide(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(HOME_WIDE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getWideSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia(HOME_WIDE_QUERY).matches;
}

function getWideServerSnapshot(): boolean {
  return true;
}

/**
 * Returns true when the viewport is at or above the Home wide-calendar
 * breakpoint (1280px). SSR/desktop-first like useIsMobile's inverse: renders
 * as wide (true) on the server and first client paint, then syncs.
 */
export function useHomeWideCalendar(): boolean {
  return useSyncExternalStore(subscribeWide, getWideSnapshot, getWideServerSnapshot);
}
```

- [ ] **Step 2: Typecheck** — `bun run typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add hooks/useIsMobile.ts
git commit -m "feat: useHomeWideCalendar 1280px media hook (refs #17)"
```

---

### Task 3: i18n keys (en + zh-CN lockstep)

**Files:**
- Modify: `lib/i18n/messages/en.ts:554` (insert after `"home.openProject"` line, before closing `},`)
- Modify: `lib/i18n/messages/zh-CN.ts:554` (same position)

- [ ] **Step 1: en.ts** — after the `"home.openProject": "Open project calendar",` line insert:

```ts
    "home.orderBy": "Order by",
    "home.orderModified": "Modified",
    "home.orderStarted": "Started",
    "home.noConversationsDay": "No conversations",
    "home.messageCount": "{count} messages",
    "home.modifiedAt": "Modified",
    "home.startedAt": "Started",
```

- [ ] **Step 2: zh-CN.ts** — after the `"home.openProject": "打开项目日历",` line insert:

```ts
    "home.orderBy": "排序方式",
    "home.orderModified": "修改时间",
    "home.orderStarted": "开始时间",
    "home.noConversationsDay": "暂无会话",
    "home.messageCount": "{count} 条消息",
    "home.modifiedAt": "修改",
    "home.startedAt": "开始",
```

- [ ] **Step 3: Verify key parity** — run:

```bash
bun test lib/i18n
```

Expected: PASS (registry validates key-set parity between locales).

- [ ] **Step 4: Commit**

```bash
git add lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts
git commit -m "feat: home order-switch and popover i18n keys (refs #17)"
```

---

### Task 4: `HomeCalendar.tsx` rewrite (cards, columns/stack, popover, order switch)

**Files:**
- Modify: `components/HomeCalendar.tsx` (full rewrite of the component body; `IssueChips` and style constants carry over)

Props grow a `machineName` (for the `project @ machine` label) — HomePage passes it.

- [ ] **Step 1: Replace the whole file with:**

```tsx
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

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import {
  daysOfWeek,
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
        onMouseLeave={wide ? closePopover : undefined}
        onFocus={wide ? (event) => openPopover(session, event.currentTarget) : undefined}
        onBlur={wide ? closePopover : undefined}
        title={name}
        style={{
          display: "block",
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
          {days.map((day) => {
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
```

Note: the `style` object in `renderCard` intentionally sets `display` twice (`display: "block"` then overridden by the wide branch's `display: "flex"`) — write it as ONE `display` value computed from `wide` to avoid the duplicate key. In the final code use:

```ts
display: wide ? "flex" : "block",
```

and drop the earlier `display: "block"` line.

- [ ] **Step 2: Typecheck** — `bun run typecheck` → clean (the old file no longer imports `useState` only; new imports `useEffect`, `useRef` are used).

- [ ] **Step 3: Commit**

```bash
git add components/HomeCalendar.tsx
git commit -m "feat: HomeCalendar columns/stack cards with order switch and hover popover (refs #17)"
```

---

### Task 5: `HomePage.tsx` rewrite (sticky chip header, auto-select, no flip)

**Files:**
- Modify: `components/HomePage.tsx` (full rewrite; keep `MachineProjects` interface, `basename`, and the `load` callback unchanged; keep the exact `const { fetchSessionsFor } = useSessionList();` line)

- [ ] **Step 1: Replace the component function and JSX (keep header imports, `MachineProjects`, `basename`, `load`) with:**

```tsx
export function HomePage() {
  const { locale, t } = useI18n();
  const { machines, loading: machinesLoading } = useMachines();
  const { fetchSessionsFor } = useSessionList();
  const [groups, setGroups] = useState<MachineProjects[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadGenerationRef = useRef(0);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    // — unchanged body from the current file, lines 45-84 —
  }, [machines, machinesLoading, fetchSessionsFor]);

  useEffect(() => {
    void load(reloadKey > 0);
  }, [load, reloadKey]);

  // Auto-select the machine (first online one with projects) once groups load.
  useEffect(() => {
    if (!groups || groups.length === 0) return;
    if (groups.some((g) => g.machineId === selectedMachineId)) return;
    const best =
      groups.find((g) => !g.offline && g.projects.size > 0)
      ?? groups.find((g) => g.projects.size > 0)
      ?? groups[0];
    setSelectedMachineId(best.machineId);
  }, [groups, selectedMachineId]);

  const selectedGroup = useMemo(
    () => groups?.find((g) => g.machineId === selectedMachineId) ?? null,
    [groups, selectedMachineId],
  );
  const projectRoots = useMemo(
    () => (selectedGroup ? [...selectedGroup.projects.keys()] : []),
    [selectedGroup],
  );

  // Auto-select the machine's most-recent project (Map preserves recency order).
  useEffect(() => {
    if (!selectedGroup) return;
    if (projectRoots.length === 0) {
      if (selectedProject !== null) setSelectedProject(null);
      return;
    }
    if (!selectedProject || !selectedGroup.projects.has(selectedProject)) {
      setSelectedProject(projectRoots[0]);
    }
  }, [selectedGroup, projectRoots, selectedProject]);

  const selectedSessions = useMemo(
    () => (selectedGroup && selectedProject ? selectedGroup.projects.get(selectedProject) ?? [] : []),
    [selectedGroup, selectedProject],
  );

  const chipRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 6,
    overflowX: "auto",
    paddingBottom: 2,
    scrollbarWidth: "thin",
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
  flexShrink: 0,
  height: 26,
  padding: "0 11px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  cursor: "pointer",
  background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "var(--bg-hover)",
  color: active ? "var(--accent)" : "var(--text-muted)",
  border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "var(--border)"}`,
  whiteSpace: "nowrap",
  });

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)",
      display: "flex", flexDirection: "column",
    }}>
      <header style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        padding: "14px 20px 10px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {t("home.title")}
          </h1>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            title={t("home.refresh")}
            style={{
              background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text-muted)",
              cursor: "pointer", height: 28, padding: "0 12px", borderRadius: 7, fontSize: 12.5, flexShrink: 0,
            }}
          >
            {t("home.refresh")}
          </button>
        </div>
        <div style={chipRowStyle}>
          {groups?.map((group) => (
            <button
              key={group.machineId}
              type="button"
              onClick={() => { setSelectedMachineId(group.machineId); setSelectedProject(null); }}
              style={{ ...chipStyle(group.machineId === selectedMachineId), ...(group.offline ? { opacity: 0.55 } : {}) }}
              title={group.machineName}
            >
              {group.machineName}
              {group.offline && <span style={{ color: "var(--danger)", marginLeft: 6 }}>·</span>}
            </button>
          ))}
          {groups === null && <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>…</span>}
        </div>
        <div style={{ ...chipRowStyle, marginTop: 6 }}>
          {selectedGroup && projectRoots.length > 0 && projectRoots.map((root) => {
            const count = selectedGroup.projects.get(root)?.length ?? 0;
            const last = selectedGroup.lastActivityByProject.get(root);
            return (
              <button
                key={root}
                type="button"
                onClick={() => setSelectedProject(root)}
                title={`${selectedGroup.machineName} · ${root}`}
                style={chipStyle(root === selectedProject)}
              >
                {basename(root)} {count}
                {last && <span style={{ color: "var(--text-dim)", marginLeft: 6, fontWeight: 400 }}>
                  {formatRelativeTime(new Date(last), locale)}
                </span>}
              </button>
            );
          })}
          {selectedGroup?.offline && (
            <span style={{ fontSize: 11.5, color: "var(--danger)", alignSelf: "center" }}>
              {t("home.machineOffline")}
            </span>
          )}
          {selectedGroup && !selectedGroup.offline && projectRoots.length === 0 && (
            <span style={{ fontSize: 12.5, color: "var(--text-dim)", alignSelf: "center" }}>
              {t("home.noProjects")}
            </span>
          )}
        </div>
      </header>
      <main style={{ flex: 1, overflowY: "auto", width: "100%", maxWidth: 1440, margin: "0 auto", padding: "16px 20px 60px" }}>
        {selectedGroup && selectedProject ? (
          <HomeCalendar
            machineId={selectedGroup.machineId}
            machineName={selectedGroup.machineName}
            project={selectedProject}
            sessions={selectedSessions}
          />
        ) : (
          <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "24px 0" }}>
            {groups === null ? "…" : t("home.noProjects")}
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Guard-test check** — run:

```bash
bun test components/AppShell.navigation.test.mjs
```

Expected: PASS (the pinned `const { fetchSessionsFor } = useSessionList();` line survives verbatim; AppShell untouched).

- [ ] **Step 3: Typecheck** — `bun run typecheck` → clean.

- [ ] **Step 4: Commit**

```bash
git add components/HomePage.tsx
git commit -m "feat: Home single-screen header chips + auto-select, no grid flip (refs #17)"
```

---

### Task 6: Verification

- [ ] **Step 1: Scoped tests**

```bash
bun test lib/calendar-week.test.mjs lib/i18n components/AppShell.navigation.test.mjs
```

Expected: all PASS.

- [ ] **Step 2: Full typecheck + lint of touched files**

```bash
bun run typecheck
bunx eslint components/HomePage.tsx components/HomeCalendar.tsx hooks/useIsMobile.ts lib/calendar-week.ts lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts
```

Expected: no NEW errors (main has a pre-existing React-compiler baseline in ChatInput/useAgentSession — those files are untouched here).

- [ ] **Step 3: Production-build worktree browser verification** (never build in repo root):

```bash
git worktree add .worktrees/omp17-verify feature/omp17-home-redesign 2>/dev/null || true
cd .worktrees/omp17-verify
ln -sfn ../../node_modules node_modules 2>/dev/null || true   # symlink node_modules if not present
PATH="$HOME/.bun/bin:$PATH" bun run build
OMP_WEB_PORT=5031 PATH="$HOME/.bun/bin:$PATH" bun run start -- -p 5031 &
```

Then browser-drive (http://localhost:5031, dev instance is unauthenticated; if the gateway 5010 build is used instead, Basic-auth per `~/omp/ops/env/5010.env`):
- ≥1280px viewport: 7 columns; equal-height cards; meta on top; hover → popover with full title + labeled Modified/Started + message count + preview; title clamped 2 lines.
- 375px viewport: stacked days; unclamped titles; single meta line; no popover.
- Empty day: column keeps space with `—` (PC) / "No conversations" (mobile).
- Order switch: toggle Started → within-day order changes; card time switches to started; day membership unchanged.
- zh-CN + light theme spot check.

- [ ] **Step 4: Cleanup + issue comment**

```bash
git worktree remove --force .worktrees/omp17-verify
```

Post a `**[Stage] Coding / QA**` progress comment on #17 per AGENTS.md, then code-review before merge.

---

## Self-Review (done at plan time)

1. **Spec coverage** — header chips + auto-select (Task 5), week-nav row + order switch (Task 4), ≥1280 columns + equal-height clamped cards + popover (Task 4), stacked mobile (Task 4), empty-day space (Task 4), meta-on-top timestamps incl. 2-digit seconds (Task 4 `metaStamp`), stable modified-keyed bucketing (Task 1 + tests), i18n lockstep (Task 3), guard-test survival (Tasks 4/5 step checks). Gap check: spec's `home.orderBy` key — used as the switch's `aria-label`/`title` (Task 4). Covered.
2. **Placeholders** — Task 5's `load` body says "unchanged from current file lines 45-84" with the line range; that is a verbatim carry-over of existing reviewed code, not unspecified new code. Everything else is full code.
3. **Type consistency** — `SessionOrderKey` defined Task 1, imported Task 4. `useHomeWideCalendar` defined Task 2, imported Task 4. `machineName?: string` prop defined Task 4, passed Task 5. i18n keys defined Task 3, consumed in Task 4 (`home.orderBy/orderModified/orderStarted/noConversationsDay/messageCount/modifiedAt/startedAt`).
