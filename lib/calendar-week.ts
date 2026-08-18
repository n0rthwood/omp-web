/**
 * Weekly-calendar date helpers for the Home page (issue #15). Pure, no
 * React, native Date only — matching the repo's no-date-library convention.
 */

/** Monday-first (1) or Sunday-first (0) week convention. */
export type WeekStartsOn = 0 | 1;

export function weekStartsOnFromIntlFirstDay(firstDay: number | undefined): WeekStartsOn {
  // Intl.Locale#weekInfo uses ISO weekday numbers: Monday=1 ... Sunday=7.
  // Date#getDay() uses Sunday=0, so normalize only the convention Home uses.
  return firstDay === 0 || firstDay === 7 ? 0 : 1;
}

/** Midnight of the day `diff` days before `date` (local time). */
function shiftDays(date: Date, diff: number): Date {
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  shifted.setDate(shifted.getDate() + diff);
  return shifted;
}

/** The midnight that starts `date`'s week under the given convention. */
export function weekStartDate(reference: Date, firstWeekday: WeekStartsOn): Date {
  const diff = (reference.getDay() - firstWeekday + 7) % 7;
  return shiftDays(reference, -diff);
}

/** The seven day-starts of a week, oldest first. */
export function daysOfWeek(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => shiftDays(weekStart, i));
}

/** `YYYY-MM-DD` for a Date in local time (calendar-day identity). */
export function localDayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Groups sessions by their `modified` local day; within a day, most recent first. */
export function groupSessionsByDay<S extends { modified: string }>(sessions: S[]): Map<string, S[]> {
  const grouped = new Map<string, S[]>();
  for (const session of sessions) {
    const key = localDayKey(new Date(session.modified));
    const bucket = grouped.get(key);
    if (bucket) bucket.push(session);
    else grouped.set(key, [session]);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  }
  return grouped;
}
