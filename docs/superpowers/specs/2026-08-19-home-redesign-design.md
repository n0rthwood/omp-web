# Home Screen Redesign — Design Spec (issue #17, ref #15)

Date: 2026-08-19 · Status: awaiting user review · Repo: n0rthwood/omp-web

## Problem

The deployed #15 Home (v0.2.9, `af2a5d8`) is a 760px column that flips between a
project grid and a per-project list view. It wastes screen space, has no mobile
layout, and conversation entries show no timestamps — so even though the
within-day order is newest-first (verified: `lib/calendar-week.ts:50` sorts
descending; SDK `session-listing.ts:466` sets `modified` = session-file mtime =
last activity), the order is unverifiable by eye.

## Goals

1. One screen: sticky header (machine chips + project chips) over a weekly
   calendar main area. No view flipping, no back row.
2. Compact conversation cards: small metadata (date + `HH:MM:SS` + smart
   relative time) **on top**, title below.
3. Responsive: 7-column grid ≥1280px; vertically stacked days <1280px.
4. Full content on hover (styled popover) on PC; full unclamped titles on mobile.
5. Order switch: Last modified (default) ↔ Started.

## Non-goals

#14 filtering, week-boundary logic, new endpoints, chat surfaces.

## Layout

### Header (sticky, both layouts)

```
Home                                            [Refresh]
Machine  (gateway) (joysort202) (joysort110) …
Project  [ompweb 12] [wsc_dev 3] [agent-canvas 7] …   ← horizontal scroll
```

- Machine row: one chip per machine from `useMachines()`; selected = accent
  border; offline machines dimmed with danger badge.
- Project row: chips for the selected machine's projects
  (`mostRecentProjectRoots` order), `basename` + session count.
- Auto-select: most-recent project of the first (or last-selected) machine on
  load; switching machine re-selects that machine's most-recent project.
  Selection is component state only — no URL change, no navigation.

### Week-nav row (below header, above calendar)

```
ompweb @ gateway     Aug 18 – 24   [ ‹ ][This week][ › ]   Order: [Modified][Started]
```

Left: project@machine label (dim, one line, ellipsized). Center: existing week
nav (`weekOffset` client state). Right: order switch — two small segmented
buttons, active one accented.

### Calendar — PC ≥1280px

- 7 equal columns (`grid-template-columns: repeat(7, 1fr)`), day header
  (weekday + date) atop each; today's header in accent.
- Conversation cards stacked top→bottom, newest first (by the active order key).
- Empty day: column stays, centered compact marker (dim `—`).

### Calendar — <1280px (incl. mobile)

- Day sections stacked vertically (Mon→Sun, oldest first, same as today).
- Cards full-width, unclamped titles, height grows with content.
- Empty day: day header + slim marker row.
- No hover popover.

## Card anatomy

**PC** (equal height per card, content clamped, never overflows):

```
┌────────────────┐
│ 08-18 16:40:12 │  meta line 1: MM-DD HH:MM:SS — 10.5px, --text-dim
│ 18 hours ago   │  meta line 2: relative time — 10.5px, --text-dim
│ Fix layout bug │  title: 13px, --text, line-clamp 2 + ellipsis,
│ on Home hea…#7 │  issue chips inline after text
└────────────────┘
```

- Equal height: fixed card height (e.g. 76px), title area clamped.
- `title` attribute also set (belt-and-braces for keyboard focus).

**Mobile**: one compact meta line (`08-19 09:03:41 · 2h ago`, wraps to two if
narrow), then full title, unclamped.

**Timestamps**: `MM-DD HH:MM:SS` from `Intl.DateTimeFormat` (2-digit everything).
Relative time via existing `formatRelativeTime` (`lib/i18n/format.ts:47`):
seconds <60s, minutes <60m, hours <24h, days ≥24h — locale-aware (en / zh-CN).

**Displayed timestamp = active sort key.** The meta line shows the time the
list is currently sorted by — `modified` by default, `created` while the order
switch is on Started — because a correctly sorted column must read as ordered
by the time it displays. See "Order switch".

## Styled hover popover (PC only)

Anchored floating panel, `OmpUpdateIndicator` pattern (`getBoundingClientRect`,
`position:fixed`, clamped to viewport), rendered on card `mouseenter`, removed on
`mouseleave`. **Non-interactive: `pointer-events: none`** — hover belongs to the
card, so the popover can't flicker or trap the cursor. ~80ms show delay, no
animation (or 120ms fade with `prefers-reduced-motion` guard, matching
`.session-info-popover`).

```
┌──────────────────────────────────────┐   width: max 340px, ≤90vw
│ Add weekly calendar view to Home #12 │   full title, wraps, no clamp
│ ──────────────────────────────────── │   1px --border divider
│ Modified: 2026-08-19 09:03:41        │   full precision, both keys
│ · 2 hours ago                        │   labeled (Modified/Started),
│ Started: 2026-08-19 08:41:02         │   so a Started sort that shows a
│ First: "regarding n0rthwood/omp-web  │   cross-midnight session is
│ #15 i have checked the deployed…"    │   self-explanatory
│ 14 messages                          │   messageCount
└──────────────────────────────────────┘   surface --bg-panel, 1px --border,
                                            radius 10, shadow, z-index 200
```

The popover drops the un-labeled single-timestamp form: both keys are always
labeled, covering every ordering mode.

## Order switch

- State in `HomeCalendar`: `orderKey: "modified" | "created"`, default
  `"modified"`.
- **Day membership is stable and always keyed on `modified`** — the calendar is
  an activity diary; a conversation appears on the day it was last worked on,
  regardless of the switch. The toggle changes ONLY the within-day sort:
  `groupSessionsByDay(sessions)` buckets by `modified` day unconditionally and
  sorts each bucket descending by the chosen key.
- Consequently, while sorting by Started, a session started Monday 23:50 and
  last active Tuesday 00:10 sits in Tuesday's column showing Monday's card
  time — the popover's labeled `Started:`/`Modified:` fields resolve it.
- `SessionInfo.created` (ISO, session header timestamp) = start;
  `SessionInfo.modified` (file mtime) = last activity. Both already in the
  payload.

## Data flow (unchanged)

`useMachines()` + `useSessionList().fetchSessionsFor(machineId)` →
`GET /api/sessions` (gateway-filtered per #14) → group by
`projectRoot ?? cwd` client-side. One fetch per machine; week slicing and
ordering are client-side.

## Files

| File | Change |
|---|---|
| `components/HomePage.tsx` | sticky header chips, auto-select, remove grid flip |
| `components/HomeCalendar.tsx` | columns/stack by breakpoint, card anatomy, popover, order switch |
| `lib/calendar-week.ts` | sort-key parameter on within-day sort (bucketing unchanged) |
| `hooks/useIsMobile.ts` | add `useMinWidth(1280)`-style hook (or `useIsWideCalendar`) |
| `lib/i18n/messages/en.ts`, `zh-CN.ts` | new keys, lockstep |
| `app/globals.css` | only if a shared 1280 breakpoint constant is needed |

New i18n keys: `home.orderBy`, `home.orderModified`, `home.orderStarted`,
`home.noConversationsDay`, `home.messageCount`, `home.startedAt`,
`home.modifiedAt`.

## Constraints honored

- Native history only — Home performs no navigation at all (`navigate()` stays
  on conversation click only).
- No component library exists; popover hand-rolled per repo patterns.
- `AppShell.navigation.test.mjs` pins the `if (home) return <HomePage />;` fork
  and the `fetchSessionsFor` line in HomePage — both must survive verbatim
  (neither is touched by this redesign).
- Themes: all colors from CSS vars; both light and titanium verified.
- No `next dev`/`build` in repo root; verification via `bun run typecheck`,
  targeted tests, production-build worktree browser check.

## Testing

- Unit: `lib/calendar-week.test.mjs` — bucketing always by `modified` day;
  within-day sort descending by each key; cross-midnight fixture (created day ≠
  modified day) stays in the `modified` bucket under both keys.
- Unit: card-order regression — within a day, newest first under both keys.
- Existing guard test must pass unmodified.
- Manual (production-build worktree): PC ≥1280 columns + popover + clamping;
  narrow viewport stacked + unclamped; empty-day markers; order switch; en/zh;
  light/titanium.
