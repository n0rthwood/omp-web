import assert from "node:assert/strict";
import { test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { SessionOutline, groupOutlineEntries } = await import("./SessionOutline.tsx");
const { I18nProvider } = await import("../hooks/useI18n.tsx");
const { enLocale } = await import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await import("../lib/i18n/messages/zh-CN.ts");

function entry(ordinal, overrides = {}) {
  return {
    entryId: `entry-${ordinal}`,
    role: "assistant",
    preview: `tool-${ordinal}`,
    timestamp: "2026-01-01T08:15:00Z",
    ordinal,
    toolOnly: true,
    ...overrides,
  };
}

function renderOutline(entries, props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SessionOutline, {
      entries, loading: false, error: null, onRetryLoad() {},
      readingEntryId: null, targetEntryId: null, navigating: false,
      onJump() {}, variant: "rail", onClose() {}, ...props,
    }),
  ));
}

function renderedEntryIds(html) {
  return [...html.matchAll(/data-outline-entry="([^"]+)"/g)].map((match) => match[1]);
}

test("empty outlines have no grouped rows", () => {
  assert.deepEqual(groupOutlineEntries([]), []);
});

for (const count of [2, 3]) {
  test(`a consecutive run of ${count} tool-only assistant entries collapses with its exact members`, () => {
    const entries = Array.from({ length: count }, (_, index) => entry(index));
    const rows = groupOutlineEntries(entries);
    assert.deepEqual(rows, [{ kind: "toolGroup", entries }]);
    rows[0].entries.forEach((member, index) => assert.strictEqual(member, entries[index]));
  });
}

test("a lone tool-only assistant entry remains a normal entry row", () => {
  const only = entry(6);
  assert.deepEqual(groupOutlineEntries([only]), [{ kind: "entry", entry: only }]);
});

test("system entries break tool runs like other visible roles", () => {
  const before = [entry(0), entry(1)];
  const breaker = entry(2, { role: "system", toolOnly: undefined, preview: "<system-reminder>" });
  const after = [entry(3), entry(4)];
  assert.deepEqual(groupOutlineEntries([...before, breaker, ...after]), [
    { kind: "toolGroup", entries: before },
    { kind: "entry", entry: breaker },
    { kind: "toolGroup", entries: after },
  ]);
});

for (const role of ["user", "assistant", "ask", "summary", "subagent"]) {
  test(`${role === "assistant" ? "text-assistant" : role} entries break tool runs`, () => {
    const before = [entry(0), entry(1)];
    const breaker = entry(2, { role, toolOnly: undefined, preview: "Visible message" });
    const after = [entry(3), entry(4), entry(5)];
    assert.deepEqual(groupOutlineEntries([...before, breaker, ...after]), [
      { kind: "toolGroup", entries: before },
      { kind: "entry", entry: breaker },
      { kind: "toolGroup", entries: after },
    ]);
    assert.deepEqual(groupOutlineEntries([before[0], breaker, after[0]]), [
      { kind: "entry", entry: before[0] },
      { kind: "entry", entry: breaker },
      { kind: "entry", entry: after[0] },
    ]);
  });
}

test("only assistants with toolOnly exactly true are grouped", () => {
  const entries = [
    entry(0), entry(1, { toolOnly: false }), entry(2, { toolOnly: undefined }),
    entry(3, { role: "subagent" }), entry(4, { role: "user" }), entry(5),
  ];
  assert.deepEqual(groupOutlineEntries(entries), entries.map((item) => ({ kind: "entry", entry: item })));
});

test("mixed sequences preserve source order and noncontiguous rendered-message ordinals", () => {
  const entries = [
    entry(0, { role: "user", toolOnly: undefined }),
    entry(3), entry(6),
    entry(9, { toolOnly: false, preview: "Narration" }),
    entry(14),
    entry(17, { role: "subagent", toolOnly: undefined }),
    entry(21), entry(25), entry(30),
    entry(33, { role: "summary", toolOnly: undefined }),
  ];
  const rows = groupOutlineEntries(entries);
  assert.deepEqual(rows.map((row) => row.kind), ["entry", "toolGroup", "entry", "entry", "entry", "toolGroup", "entry"]);
  const flattened = rows.flatMap((row) => row.kind === "toolGroup" ? row.entries : [row.entry]);
  assert.deepEqual(flattened, entries);
  assert.deepEqual(flattened.map((item) => item.ordinal), [0, 3, 6, 9, 14, 17, 21, 25, 30, 33]);
  flattened.forEach((item, index) => assert.strictEqual(item, entries[index]));
});

test("grouping never mutates the input array or its entries", () => {
  const entries = Object.freeze([
    Object.freeze(entry(1)), Object.freeze(entry(4)),
    Object.freeze(entry(7, { role: "ask", toolOnly: undefined })),
    Object.freeze(entry(10)),
  ]);
  const before = JSON.stringify(entries);
  const rows = groupOutlineEntries(entries);
  assert.equal(JSON.stringify(entries), before);
  assert.notStrictEqual(rows[0].entries, entries);
  assert.strictEqual(rows[0].entries[0], entries[0]);
  assert.strictEqual(rows[2].entry, entries[3]);
});

for (const variant of ["rail", "drawer"]) {
  test(`${variant} groups render a badge and first-member preview, ordinal, timestamp and jump anchor`, () => {
    const entries = [
      entry(4, { preview: "read first", timestamp: "2026-01-01T08:15:00Z" }),
      entry(8, { preview: "hidden second", timestamp: "2026-01-01T19:45:00Z" }),
      entry(12, { preview: "hidden third", timestamp: "2026-01-01T22:30:00Z" }),
    ];
    const html = renderOutline(entries, {
      variant, readingEntryId: entries[1].entryId, targetEntryId: entries[2].entryId, navigating: true,
    });
    assert.deepEqual(renderedEntryIds(html), ["entry-4"]);
    assert.equal((html.match(/role="listitem"/g) ?? []).length, 1);
    assert.match(html, /aria-label="Message 5: read first"/);
    assert.match(html, /read first/);
    assert.doesNotMatch(html, /hidden second|hidden third/);
    assert.match(html, />#5<\/span>/);
    assert.match(html, />Tools<\/span>/);
    assert.match(html, /class="[^"]*rounded-full[^"]*tabular-nums"[^>]*>×3<\/span>/);
    const firstTime = new Date(entries[0].timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    assert.ok(html.includes(firstTime), "group displays the first member's time");
    assert.match(html, /aria-current="location"/);
    assert.match(html, /border-color:var\(--accent\)/);
    assert.match(html, /border-t-\[var\(--accent\)\]/, "targeting any member keeps the navigation indicator");
    assert.match(html, /viewBox="0 0 12 12"/);
    assert.match(html, /M7 2a3 3 0 0 0/);
  });

  test(`${variant} subagent entries use a distinct label, violet glyph and normal jump target`, () => {
    const html = renderOutline([entry(8, { role: "subagent", toolOnly: undefined, preview: "Worker finished" })], { variant });
    assert.deepEqual(renderedEntryIds(html), ["entry-8"]);
    assert.match(html, />Subagent<\/span>/);
    assert.match(html, /color:#8b5cf6/);
    assert.match(html, /M3 3v6M3 4h3a3 3 0 0 1 3 2/);
    assert.match(html, /aria-label="Message 9: Worker finished"/);
    assert.doesNotMatch(html, /×\d/);
  });

  test(`${variant} tool rows are subdued: dim glyph, faded row, no accent color`, () => {
    const groupHtml = renderOutline([entry(0), entry(1)], { variant });
    const groupRow = groupHtml.match(/<button[^>]*data-outline-entry="entry-0"[^>]*>/)[0];
    assert.match(groupRow, /data-outline-subdued="true"/);
    assert.match(groupRow, /opacity:0\.75/);
    assert.doesNotMatch(groupHtml, /color:var\(--accent\)/, "no accent-colored glyph or badge in tool groups");
    assert.match(groupHtml, /color:var\(--text-dim\)/);
    assert.match(groupHtml, /M7 2a3 3 0 0 0/);

    const loneHtml = renderOutline([entry(2)], { variant });
    const loneRow = loneHtml.match(/<button[^>]*data-outline-entry="entry-2"[^>]*>/)[0];
    assert.match(loneRow, /data-outline-subdued="true"/);
    assert.match(loneRow, /opacity:0\.75/);
    assert.match(loneHtml, /color:var\(--text-dim\)/);
    assert.doesNotMatch(loneHtml, /color:var\(--accent\)/);
  });

  test(`${variant} reading rows get a solid accent frame and accent-tinted background`, () => {
    const item = entry(3, { role: "user", toolOnly: undefined, preview: "hello" });
    const html = renderOutline([item], { variant, readingEntryId: item.entryId });
    const row = html.match(/<button[^>]*data-outline-entry="entry-3"[^>]*>/)[0];
    assert.match(row, /aria-current="location"/);
    assert.match(row, /border-color:var\(--accent\)/);
    assert.match(row, /background:color-mix\(in srgb, var\(--accent\) 12%, transparent\)/);
    assert.doesNotMatch(row, /data-outline-subdued/);
    const idle = renderOutline([item], { variant });
    const idleRow = idle.match(/<button[^>]*data-outline-entry="entry-3"[^>]*>/)[0];
    assert.match(idleRow, /border-color:transparent/);
    assert.match(idleRow, /background:transparent/);
  });

  test(`${variant} assistant rows use the success-colored robot glyph`, () => {
    const html = renderOutline([entry(1, { toolOnly: undefined, preview: "Answer text" })], { variant });
    assert.match(html, />Assistant<\/span>/);
    assert.match(html, /color:var\(--success\)/);
    assert.match(html, /<rect x="2\.5" y="4" width="7" height="6" rx="1\.6"/);
    assert.match(html, /M6 4V2\.2/, "antenna");
    assert.match(html, /M4\.5 7h\.01M7\.5 7h\.01/, "two eyes");
    assert.doesNotMatch(html, /data-outline-subdued/);
  });

  test(`${variant} system rows use the teal gear glyph and System label`, () => {
    const html = renderOutline([entry(1, { role: "system", toolOnly: undefined, preview: "Injected context" })], { variant });
    assert.match(html, />System<\/span>/);
    assert.match(html, /color:#0d9488/);
    assert.match(html, /M5\.1 1\.2h1\.8/, "cog outline");
    assert.match(html, /<circle cx="6" cy="6" r="1\.6"/, "cog hub");
    assert.doesNotMatch(html, /color:var\(--warning\)/, "system teal stays distinct from summary amber");
    assert.doesNotMatch(html, /data-outline-subdued/);
  });

  test(`${variant} user rows keep the accent person glyph`, () => {
    const html = renderOutline([entry(1, { role: "user", toolOnly: undefined, preview: "hi" })], { variant });
    assert.match(html, /color:var\(--accent\)/);
    assert.match(html, /<circle cx="6" cy="4" r="2\.2"/);
  });
}

test("all built-in locales translate the new outline labels", () => {
  assert.equal(enLocale.messages["outline.roleSubagent"], "Subagent");
  assert.equal(enLocale.messages["outline.roleTools"], "Tools");
  assert.equal(enLocale.messages["outline.roleSystem"], "System");
  assert.equal(zhCNLocale.messages["outline.roleSubagent"], "子代理");
  assert.equal(zhCNLocale.messages["outline.roleTools"], "工具调用");
  assert.equal(zhCNLocale.messages["outline.roleSystem"], "系统");
});
