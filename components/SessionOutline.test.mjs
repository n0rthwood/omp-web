import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { SessionOutline, groupOutlineEntries, OutlineJobsView } = await import("./SessionOutline.tsx");
const {
  readStoredRailWidth,
  OUTLINE_RAIL_DEFAULT_WIDTH,
  OUTLINE_RAIL_MIN_WIDTH,
  OUTLINE_RAIL_MAX_WIDTH,
  OUTLINE_RAIL_STORAGE_KEY,
} = await import("./SessionOutline.tsx");
const { resolveOutlineDrillTarget } = await import("../lib/session-outline.ts");
const { I18nProvider } = await import("../hooks/useI18n.tsx");
const { enLocale } = await import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await import("../lib/i18n/messages/zh-CN.ts");

const outlineSource = readFileSync(new URL("./SessionOutline.tsx", import.meta.url), "utf8");
const shellSource = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

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

test("only tool-category rows are grouped; text assistants never join runs", () => {
  const entries = [
    entry(0), entry(1, { toolOnly: false }), entry(2, { toolOnly: undefined }),
    entry(3, { role: "subagent" }), entry(4, { role: "user" }), entry(5),
  ];
  assert.deepEqual(groupOutlineEntries(entries), entries.map((item) => ({ kind: "entry", entry: item })));
});

test("#135 tool/write/wait rows group together; async and title rows break runs", () => {
  const tool = entry(0, { role: "tool", toolOnly: undefined });
  const write = entry(1, { role: "write", toolOnly: undefined });
  const wait = entry(2, { role: "wait", toolOnly: undefined });
  const spawn = entry(3, { role: "subagent", toolOnly: true });
  const more = entry(4, { role: "tool", toolOnly: undefined });
  const title = entry(5, { role: "title", toolOnly: undefined });
  const rows = groupOutlineEntries([tool, write, wait, spawn, more, title]);
  assert.deepEqual(rows.map((row) => row.kind), ["toolGroup", "entry", "entry", "entry"]);
  assert.deepEqual(rows[0].entries, [tool, write, wait]);
  assert.strictEqual(rows[1].entry, spawn);
  assert.strictEqual(rows[2].entry, more);
  assert.strictEqual(rows[3].entry, title);
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

for (const variant of ["rail", "drawer"]) {
  test(`${variant} #135 tool-category rows use wrench/pencil/hourglass glyphs and labels`, () => {
    const cases = [
      { role: "tool", label: "Tool", path: /M7 2a3 3 0 0 0/ },
      { role: "write", label: "Edit", path: /M8\.6 1\.9l1\.5 1\.5/ },
      { role: "wait", label: "Wait", path: /M3 1\.5h6M3 10\.5h6/ },
    ];
    for (const { role, label, path } of cases) {
      const html = renderOutline([entry(1, { role, toolOnly: undefined, preview: `${role} row` })], { variant });
      assert.match(html, new RegExp(`>${label}</span>`));
      assert.match(html, path);
      assert.match(html, /data-outline-subdued="true"/);
    }
  });

  test(`${variant} #135 collapsed mixed groups show member-category glyphs and an expand toggle`, () => {
    const entries = [
      entry(0, { role: "tool", toolOnly: undefined, preview: "bash run" }),
      entry(1, { role: "write", toolOnly: undefined, preview: "edit file" }),
      entry(2, { role: "wait", toolOnly: undefined, preview: "wait jobs" }),
    ];
    const html = renderOutline(entries, { variant });
    assert.deepEqual(renderedEntryIds(html), ["entry-0"]);
    assert.match(html, /×3<\/span>/);
    assert.match(html, /M8\.6 1\.9l1\.5 1\.5/, "pencil in the mixed-glyph strip");
    assert.match(html, /M3 1\.5h6M3 10\.5h6/, "hourglass in the mixed-glyph strip");
    assert.match(html, /data-outline-group-toggle="entry-0"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /aria-label="Expand tool rows"/);
    assert.doesNotMatch(html, /edit file|wait jobs/, "collapsed members stay hidden");
  });

  test(`${variant} #135 async rows carry lifecycle badges with SubagentPanel colors`, () => {
    const cases = [
      { jobStatus: "running", marker: /stroke-dasharray="22 13"/, color: /color:var\(--accent\)/ },
      { jobStatus: "pending", marker: /stroke-dasharray="22 13"/, color: /color:var\(--accent\)/ },
      { jobStatus: "completed", marker: />✓</, color: /color:var\(--success\)/ },
      { jobStatus: "failed", marker: />✗</, color: /color:var\(--danger\)/ },
      { jobStatus: "aborted", marker: />⊘</, color: /color:var\(--warning\)/ },
    ];
    for (const { jobStatus, marker, color } of cases) {
      const html = renderOutline([entry(1, { role: "subagent", toolOnly: undefined, preview: "worker", jobStatus })], { variant });
      assert.match(html, marker, `${jobStatus} badge glyph`);
      assert.match(html, color, `${jobStatus} badge color`);
    }
  });

  test(`${variant} #135 multi-job spawn rows show the worst-status badge plus per-job mini badges`, () => {
    const html = renderOutline([entry(1, {
      role: "subagent", toolOnly: true, preview: "task, task",
      jobStatus: "failed",
      jobs: [
        { id: "w1", name: "scout", status: "completed" },
        { id: "w2", name: "task", status: "failed" },
      ],
    })], { variant });
    assert.match(html, />✗</, "aggregate failed badge");
    assert.match(html, />✓</, "per-job completed mini badge");
    assert.match(html, /title="scout: completed\ntask: failed"/, "per-job tooltip");
  });

  test(`${variant} #135 title rows use the tag glyph and Title label`, () => {
    const html = renderOutline([entry(1, { role: "title", toolOnly: undefined, preview: "New name", anchorEntryId: "entry-9" })], { variant });
    assert.match(html, />Title<\/span>/);
    assert.match(html, /M1\.8 5\.4V2\.6/, "tag body");
    assert.match(html, /<circle cx="4" cy="4" r="0\.7"/, "tag hole");
    assert.doesNotMatch(html, /data-outline-subdued/);
  });

  test(`${variant} #135 old payloads without new fields render unchanged`, () => {
    const html = renderOutline([
      entry(0, { preview: "legacy tools" }),
      entry(1, { preview: "legacy tools 2" }),
      entry(2, { role: "subagent", toolOnly: undefined, preview: "legacy delivery" }),
    ], { variant });
    assert.match(html, />Tools<\/span>/);
    assert.match(html, /×2<\/span>/);
    assert.doesNotMatch(html, /✓|✗|⊘|stroke-dasharray/, "no badges without jobStatus");
    assert.match(html, />Subagent<\/span>/);
  });
}

test("all built-in locales translate the new outline labels", () => {
  assert.equal(enLocale.messages["outline.roleSubagent"], "Subagent");
  assert.equal(enLocale.messages["outline.roleTools"], "Tools");
  assert.equal(enLocale.messages["outline.roleSystem"], "System");
  assert.equal(zhCNLocale.messages["outline.roleSubagent"], "子代理");
  assert.equal(zhCNLocale.messages["outline.roleTools"], "工具调用");
  assert.equal(zhCNLocale.messages["outline.roleSystem"], "系统");
  assert.equal(enLocale.messages["outline.roleTool"], "Tool");
  assert.equal(enLocale.messages["outline.roleWrite"], "Edit");
  assert.equal(enLocale.messages["outline.roleWait"], "Wait");
  assert.equal(enLocale.messages["outline.roleTitle"], "Title");
  assert.equal(zhCNLocale.messages["outline.roleTool"], "工具");
  assert.equal(zhCNLocale.messages["outline.roleWrite"], "编辑");
  assert.equal(zhCNLocale.messages["outline.roleWait"], "等待");
  assert.equal(zhCNLocale.messages["outline.roleTitle"], "标题");
  for (const key of ["outline.expandTools", "outline.collapseTools", "outline.jobPending", "outline.jobRunning", "outline.jobCompleted", "outline.jobFailed", "outline.jobAborted", "outline.jobs", "outline.jobCount", "outline.openJob", "outline.subagentUnavailable", "outline.resizeRail", "subagents.locateInChat"]) {
    assert.ok(enLocale.messages[key], `en ${key}`);
    assert.ok(zhCNLocale.messages[key], `zh-CN ${key}`);
  }
});

// --- #137: outline as the subagent home -----------------------------------

function withStoredWidth(width, render) {
  const previous = globalThis.window;
  try {
    globalThis.window = { localStorage: { getItem: (key) => (key === OUTLINE_RAIL_STORAGE_KEY ? width : null) } };
    return render();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("#137 drill targets: async rows branch on their job count, everything else jumps", () => {
  const spawn = (jobs) => entry(1, { role: "subagent", toolOnly: true, preview: "task", jobs });
  assert.deepEqual(resolveOutlineDrillTarget(entry(0, { role: "user", toolOnly: undefined })), { kind: "jump" });
  assert.deepEqual(resolveOutlineDrillTarget(spawn(undefined)), { kind: "jump" });
  assert.deepEqual(resolveOutlineDrillTarget(spawn([])), { kind: "jump" });
  assert.deepEqual(
    resolveOutlineDrillTarget(spawn([{ id: "agent-1", name: "scout", status: "running" }])),
    { kind: "detail", jobId: "agent-1" },
  );
  assert.deepEqual(
    resolveOutlineDrillTarget(spawn([
      { id: "agent-1", name: "scout", status: "completed" },
      { id: "agent-2", name: "task", status: "failed" },
    ])),
    { kind: "jobs" },
  );
  // bash/eval deliveries carry a job id that never resolves to a snapshot.
  assert.deepEqual(
    resolveOutlineDrillTarget(entry(2, { role: "subagent", toolOnly: undefined, preview: "bg_3", jobs: [{ id: "bg_3", name: "bg_3", status: "completed" }] })),
    { kind: "detail", jobId: "bg_3" },
  );
});

for (const variant of ["rail", "drawer"]) {
  test(`${variant} #137 renders the drill-down surface with a resizable rail only in rail mode`, () => {
    const html = renderOutline([entry(4, { preview: "spawn" })], { variant });
    assert.match(html, /data-outline-entry="entry-4"/);
    if (variant === "rail") {
      assert.match(html, /data-testid="session-outline-rail"/);
      assert.match(html, /data-resize-handle="outline-rail"/);
      assert.match(html, /role="separator"/);
      assert.match(html, /aria-valuemin="240"/);
      assert.match(html, /aria-valuemax="560"/);
      assert.match(html, /aria-valuenow="320"/);
      assert.match(html, /--outline-rail-width:320px/);
    } else {
      assert.match(html, /data-testid="session-outline-drawer"/);
      assert.doesNotMatch(html, /data-resize-handle="outline-rail"/);
      assert.doesNotMatch(html, /--outline-rail-width/);
    }
  });
}

test("#137 rail width is a per-browser preference read before the first paint", () => {
  assert.equal(OUTLINE_RAIL_STORAGE_KEY, "omp-outline-rail-width");
  assert.equal(OUTLINE_RAIL_DEFAULT_WIDTH, 320);
  assert.equal(OUTLINE_RAIL_MIN_WIDTH, 240);
  assert.equal(OUTLINE_RAIL_MAX_WIDTH, 560);
  assert.equal(withStoredWidth("420", () => readStoredRailWidth()), 420);
  assert.equal(withStoredWidth("garbage", () => readStoredRailWidth()), null);
  assert.equal(withStoredWidth(null, () => readStoredRailWidth()), null);
  const html = withStoredWidth("420", () => renderOutline([entry(0)], { variant: "rail" }));
  assert.match(html, /--outline-rail-width:420px/);
  assert.doesNotMatch(html, /--outline-rail-width:320px/);
});

test("#137 async rows drill down instead of jumping; the jump moved to the detail header", () => {
  assert.match(outlineSource, /onClick=\{\(\) => onActivate\(item, jumpId\)\}/);
  assert.match(outlineSource, /data-testid="outline-jobs-view"/);
  assert.match(outlineSource, /data-testid="outline-back"/);
  assert.match(outlineSource, /onLocateInChat=\{onLocateInChat \? \(\) => onLocateInChat\(view\.entry\.entryId\) : undefined\}/);
  assert.match(outlineSource, /<SubagentDetail/);
});

test("#137 dead sessions resolve the snapshot once, then read the history transcript", () => {
  assert.match(outlineSource, /type: "get_subagents"/);
  assert.match(outlineSource, /fetchingRef\.current === sessionId/);
  assert.match(outlineSource, /setFetched\(\{ sessionId, byId \}\)/);
});

test("#137 the standalone subagent column is gone without dead imports", () => {
  assert.doesNotMatch(shellSource, /SubagentPanel/);
  assert.doesNotMatch(shellSource, /subagent-column/);
  assert.doesNotMatch(shellSource, /showSubagentPanel/);
  assert.doesNotMatch(stylesSource, /\.subagent-column/);
  assert.throws(() => readFileSync(new URL("./SubagentPanel.tsx", import.meta.url)));
});

test("#137 the rail keeps the list mounted so back restores the scroll position", () => {
  assert.match(outlineSource, /savedScrollRef\.current = listScrollRef\.current\?\.scrollTop \?\? 0/);
  assert.match(outlineSource, /list\.scrollTop = savedScrollRef\.current/);
  assert.match(outlineSource, /style=\{\{ display: view\.kind === "list" \? undefined : "none" \}\}/);
});

test("#137 multi-job spawn rows expand to a per-job list with live status and duration", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(OutlineJobsView, {
      entry: entry(1, {
        role: "subagent", toolOnly: true, preview: "task, task",
        jobs: [
          { id: "agent-1", name: "scout", status: "completed" },
          { id: "agent-2", name: "task", status: "failed" },
        ],
      }),
      liveById: new Map([["agent-1", { id: "agent-1", status: "running", progress: { durationMs: 5000 } }]]),
      busyJobId: null,
      onBack() {},
      onOpenJob() {},
    })));
  assert.match(html, /data-testid="outline-jobs-view"/);
  assert.match(html, /data-outline-job="agent-1"/);
  assert.match(html, /data-outline-job="agent-2"/);
  assert.match(html, /aria-label="Open scout"/);
  assert.match(html, /aria-label="Open task"/);
  assert.match(html, />scout</);
  assert.match(html, />5s</, "live snapshot supplies the duration");
  assert.match(html, /stroke-dasharray="22 13"/, "live running status upgrades the parsed badge");
  assert.match(html, />✗</, "a job without a live snapshot keeps its parsed status");
  assert.match(html, /data-testid="outline-back"/);
});

// #146: a tool-only row that reaches the panel without its `toolNames` list
// (journal rebuild, older host payload) still localizes its bare id preview.
const { outlinePreviewText } = await import("./SessionOutline.tsx");
const { translateMessage } = await import("../lib/i18n/format.ts");
const messages = { en: enLocale.messages, "zh-CN": zhCNLocale.messages };
const zhT = (key, params) => translateMessage("zh-CN", key, messages, params);
const enT = (key, params) => translateMessage("en", key, messages, params);

test("#146 localizes tool-only row titles without toolNames", () => {
  assert.equal(outlinePreviewText({ role: "subagent", preview: "task" }, zhT), "任务");
  assert.equal(outlinePreviewText({ role: "subagent", preview: "todo, task" }, zhT), "待办列表, 任务");
  assert.equal(outlinePreviewText({ role: "tool", preview: "read, +3 more" }, zhT), "读取, 另有 3 个");
  assert.equal(outlinePreviewText({ role: "tool", preview: "write, bash", toolNames: ["write", "bash"] }, zhT), "写入, 命令行");
  assert.equal(outlinePreviewText({ role: "tool", preview: "write", toolNames: ["write"] }, enT), "write");
});

test("#146 prose previews are never treated as tool ids", () => {
  assert.equal(outlinePreviewText({ role: "assistant", preview: "我先看看代码" }, zhT), "我先看看代码");
  assert.equal(outlinePreviewText({ role: "assistant", preview: "read the file" }, zhT), "read the file");
});
