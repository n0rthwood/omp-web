import assert from "node:assert/strict";
import test from "node:test";
import { weekStartDate, daysOfWeek, stackedDayOrder, localDayKey, groupSessionsByDay, weekStartsOnFromIntlFirstDay } from "./calendar-week.ts";

// Wednesday 2026-08-12T15:30 local, arbitrary time-of-day preserved
const WEDNESDAY = new Date(2026, 7, 12, 15, 30);

test("weekStartDate: Monday-first week containing a Wednesday starts that Monday", () => {
  const start = weekStartDate(WEDNESDAY, 1);
  assert.equal(start.getDay(), 1);
  assert.equal(start.getDate(), 10);
  assert.equal(start.getMonth(), 7);
  assert.equal(start.getFullYear(), 2026);
});

test("weekStartDate: Sunday-first week containing a Wednesday starts the previous Sunday", () => {
  const start = weekStartDate(WEDNESDAY, 0);
  assert.equal(start.getDay(), 0);
  assert.equal(start.getDate(), 9);
});

test("weekStartDate: a Sunday in a Monday-first convention belongs to the week that started the previous Monday", () => {
  const sunday = new Date(2026, 7, 9); // Aug 9 2026 is a Sunday
  const start = weekStartDate(sunday, 1); // week runs Mon Aug 3 .. Sun Aug 9
  assert.equal(start.getDay(), 1);
  assert.equal(start.getDate(), 3);
});

test("weekStartDate: handles month and year boundaries", () => {
  const newYearsEve = new Date(2026, 11, 31); // Thursday Dec 31 2026
  const start = weekStartDate(newYearsEve, 1); // Monday Dec 28 2026
  assert.equal(start.getMonth(), 11);
  assert.equal(start.getDate(), 28);
  assert.equal(start.getFullYear(), 2026);

  const janFirst = new Date(2027, 0, 1); // Friday
  const start2 = weekStartDate(janFirst, 1); // Monday Dec 28 2026
  assert.equal(start2.getFullYear(), 2026);
  assert.equal(start2.getMonth(), 11);
  assert.equal(start2.getDate(), 28);
});

test("weekStartDate: midnight-normalizes the result", () => {
  const start = weekStartDate(WEDNESDAY, 1);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);
  assert.equal(start.getMilliseconds(), 0);
});

test("weekStartsOnFromIntlFirstDay: maps Intl Sunday value 7 onto Date#getDay Sunday value 0", () => {
  assert.equal(weekStartsOnFromIntlFirstDay(7), 0);
  assert.equal(weekStartsOnFromIntlFirstDay(0), 0);
  assert.equal(weekStartsOnFromIntlFirstDay(1), 1);
  assert.equal(weekStartsOnFromIntlFirstDay(undefined), 1);
});

test("daysOfWeek: seven consecutive days from the start", () => {
  const days = daysOfWeek(weekStartDate(WEDNESDAY, 1));
  assert.equal(days.length, 7);
  for (let i = 1; i < days.length; i++) {
    assert.equal(days[i].getDate(), days[i - 1].getDate() + 1);
  }
});

test("localDayKey: YYYY-MM-DD in local time", () => {
  assert.equal(localDayKey(new Date(2026, 7, 3, 23, 59)), "2026-08-03");
  assert.equal(localDayKey(new Date(2026, 0, 13, 0, 0)), "2026-01-13");
});

test("groupSessionsByDay: groups by modified local day, sessions sorted desc within a day", () => {
  // Use local-noon dates so the test is TZ-stable.
  const noon = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  const list = [
    { id: "old", modified: noon(2026, 7, 12, 9) },
    { id: "new", modified: noon(2026, 7, 12, 14) },
    { id: "prev", modified: noon(2026, 7, 10, 10) },
    { id: "other", modified: noon(2026, 7, 9, 10) },
  ];
  const grouped = groupSessionsByDay(list);
  const day12 = grouped.get("2026-08-12");
  assert.ok(day12);
  assert.deepEqual(day12.map((s) => s.id), ["new", "old"]);
  assert.ok(grouped.get("2026-08-10"));
  assert.ok(grouped.get("2026-08-09"));
  assert.equal(grouped.size, 3);
});

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

test("stackedDayOrder: days with sessions newest first, empty days after in calendar order (issue #17)", () => {
  const noon = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();
  const days = daysOfWeek(weekStartDate(WEDNESDAY, 1)); // Mon Aug 10 .. Sun Aug 16
  const byDay = groupSessionsByDay([
    { id: "a", modified: noon(2026, 7, 10, 9) },  // Monday
    { id: "b", modified: noon(2026, 7, 12, 14) }, // Wednesday
  ]);
  const ordered = stackedDayOrder(days, byDay);
  assert.deepEqual(ordered.map((d) => d.getDate()), [12, 10, 11, 13, 14, 15, 16]);
});

test("stackedDayOrder: fully empty week keeps calendar order", () => {
  const days = daysOfWeek(weekStartDate(WEDNESDAY, 1));
  const ordered = stackedDayOrder(days, new Map());
  assert.deepEqual(ordered.map((d) => d.getDate()), days.map((d) => d.getDate()));
});
