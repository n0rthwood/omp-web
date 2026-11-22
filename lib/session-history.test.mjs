import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  readSessionHistory,
  readSessionOutline,
  HistoryTargetUnavailableError,
  readJournalAnchor,
  readJournalTitle,
  invalidateJournalIndex,
  parseJournalAnchor,
  clampHistoryLimit,
  DEFAULT_HISTORY_LIMIT,
  HISTORY_PAGE_LIMIT,
  MAX_HISTORY_LIMIT,
} = await jiti.import("./session-history.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { resolveSessionLeafId } = await jiti.import("@oh-my-pi/pi-coding-agent/session/session-entries");

const TS = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();

function header() {
  return { type: "session", version: 3, id: "sess-test", timestamp: TS(0), cwd: "/tmp/project" };
}

function user(id, parentId, text, i = 1) {
  return { type: "message", id, parentId, timestamp: TS(i), message: { role: "user", content: text } };
}

function assistant(id, parentId, text, i = 2, extra = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TS(i),
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
      timestamp: Date.UTC(2026, 0, 1, 0, 0, i),
      ...extra,
    },
  };
}

function journal(entries, { title, version = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omp99-history-"));
  const file = join(dir, "session.jsonl");
  const lines = [];
  if (title !== undefined) {
    const slot = JSON.stringify({ type: "title", v: 1, title, updatedAt: TS(0), pad: "" });
    lines.push(slot + " ".repeat(Math.max(0, 255 - slot.length)));
  }
  lines.push(JSON.stringify({ ...header(), version }));
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(file, lines.join("\n") + "\n");
  return { dir, file };
}

function cleanup(ctx) {
  invalidateJournalIndex(ctx.file);
  rmSync(ctx.dir, { recursive: true, force: true });
}

function linearTurns(count, start = 0) {
  const entries = [];
  let parent = null;
  for (let i = 0; i < count; i++) {
    const n = start + i;
    const u = user(`u${n}`, parent, `request ${n}`, n * 2 + 1);
    const a = assistant(`a${n}`, u.id, `answer ${n}`, n * 2 + 2);
    entries.push(u, a);
    parent = a.id;
  }
  return entries;
}

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// ---------------------------------------------------------------------------
// Frozen interface helpers
// ---------------------------------------------------------------------------

test("anchor parsing rejects malformed input and accepts valid anchors", () => {
  const valid = { lastEntryId: "a1", leafId: "a1", entryCount: 2, sizeBytes: 100, mtimeMs: 123.5 };
  assert.deepEqual(parseJournalAnchor(valid), valid);
  assert.deepEqual(parseJournalAnchor({ ...valid, lastEntryId: null, leafId: null, entryCount: 0 }), {
    ...valid, lastEntryId: null, leafId: null, entryCount: 0,
  });
  for (const bad of [null, undefined, 42, "x", [], { ...valid, entryCount: -1 }, { ...valid, sizeBytes: 1.5 }, { ...valid, mtimeMs: Number.NaN }, { ...valid, lastEntryId: 7 }]) {
    assert.equal(parseJournalAnchor(bad), null);
  }
  assert.equal(clampHistoryLimit(undefined), DEFAULT_HISTORY_LIMIT);
  assert.equal(clampHistoryLimit(20), HISTORY_PAGE_LIMIT);
  assert.equal(clampHistoryLimit(5000), MAX_HISTORY_LIMIT);
  assert.equal(clampHistoryLimit(0), 1);
});

// ---------------------------------------------------------------------------
// Initial window + backward pagination
// ---------------------------------------------------------------------------

test("initial window is the latest 5 messages with a Load-earlier affordance", async () => {
  const ctx = journal(linearTurns(12));
  try {
    const result = await readSessionHistory(ctx.file);
    assert.equal(result.context.messages.length, 5);
    assert.deepEqual(result.context.entryIds, ["a9", "u10", "a10", "u11", "a11"]);
    assert.equal(result.page.hasEarlier, true);
    assert.equal(result.page.headEntryId, "a9");
    assert.equal(result.context.messages.length, result.context.entryIds.length);
    assert.equal(textOf(result.context.messages[4]), "answer 11");
  } finally {
    cleanup(ctx);
  }
});

test("short transcripts render fully without Load earlier", async () => {
  const ctx = journal(linearTurns(2));
  try {
    const result = await readSessionHistory(ctx.file);
    assert.deepEqual(result.context.entryIds, ["u0", "a0", "u1", "a1"]);
    assert.equal(result.page.hasEarlier, false);
    assert.equal(result.page.headEntryId, "u0");
  } finally {
    cleanup(ctx);
  }
});

test("before pages of 20 walk back to the transcript start and stop", async () => {
  const ctx = journal(linearTurns(30)); // 60 messages
  try {
    const first = await readSessionHistory(ctx.file);
    assert.equal(first.context.messages.length, 5);
    let head = first.page.headEntryId;
    const seen = [...first.context.entryIds];
    let pages = 0;
    while (true) {
      const page = await readSessionHistory(ctx.file, { before: head, limit: 20 });
      pages++;
      assert.ok(page.context.messages.length > 0 && page.context.messages.length <= 20);
      // Strictly earlier: no overlap with anything already loaded.
      for (const id of page.context.entryIds) assert.ok(!seen.includes(id), `duplicate ${id}`);
      seen.unshift(...page.context.entryIds);
      if (!page.page.hasEarlier) {
        assert.equal(page.page.headEntryId, "u0");
        break;
      }
      head = page.page.headEntryId;
      assert.ok(pages < 10, "pagination must terminate");
    }
    assert.equal(seen.length, 60);
    assert.deepEqual(seen, linearTurns(30).map((e) => e.id));
  } finally {
    cleanup(ctx);
  }
});

test("limit is capped at 100 and defaults to 5", async () => {
  const ctx = journal(linearTurns(80)); // 160 messages
  try {
    const capped = await readSessionHistory(ctx.file, { limit: 1000 });
    assert.equal(capped.context.messages.length, MAX_HISTORY_LIMIT);
    const dflt = await readSessionHistory(ctx.file, {});
    assert.equal(dflt.context.messages.length, DEFAULT_HISTORY_LIMIT);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Export parity: windowed union == full buildSessionContext transcript
// ---------------------------------------------------------------------------

test("paginated union matches the export transcript exactly (compaction + branches)", async () => {
  const entries = [
    user("u1", null, "old request", 1),
    assistant("a1", "u1", "old answer", 2),
    user("u2", "a1", "kept request", 3),
    assistant("a2", "u2", "kept answer", 4),
    { type: "compaction", id: "cmp1", parentId: "a2", timestamp: TS(5), summary: "first summary", firstKeptEntryId: "u2", tokensBefore: 100 },
    user("u3", "cmp1", "post compaction", 6),
    assistant("a3", "u3", "post answer", 7),
    { type: "compaction", id: "cmp2", parentId: "a3", timestamp: TS(8), summary: "second summary", firstKeptEntryId: "u3", tokensBefore: 200 },
    user("u4", "cmp2", "newest request", 9),
    assistant("a4", "u4", "newest answer", 10),
    { type: "branch_summary", id: "bs1", parentId: "a4", timestamp: TS(11), fromId: "a1", summary: "explored a branch" },
    { type: "custom_message", id: "cm1", parentId: "bs1", timestamp: TS(12), customType: "note", content: "hidden note", display: false },
    { type: "custom_message", id: "cm2", parentId: "cm1", timestamp: TS(13), customType: "bad", content: { not: "renderable" }, display: true },
    user("u5", "cm2", "final request", 14),
    assistant("a5", "u5", "final answer", 15),
  ];
  const ctx = journal(entries);
  try {
    const full = buildSessionContext(entries);
    const collected = [];
    let head = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = head === null
        ? await readSessionHistory(ctx.file, { limit: 3 })
        : await readSessionHistory(ctx.file, { before: head, limit: 3 });
      collected.unshift(...page.context.entryIds);
      if (!page.page.hasEarlier) break;
      head = page.page.headEntryId;
    }
    assert.deepEqual(collected, full.entryIds);
    // Compacted-away history never resurrects; summaries sit chronologically.
    assert.ok(!collected.includes("u1"));
    assert.ok(!collected.includes("a1"));
    assert.ok(!collected.includes("cmp1"));
    assert.ok(collected.includes("cm2")); // web conversion renders all custom_messages
    const cmpIdx = collected.indexOf("cmp2");
    assert.equal(collected[cmpIdx - 1], "a3");
    assert.equal(collected[cmpIdx + 1], "u4");
    // Message content parity for the shared entries.
    const tail = await readSessionHistory(ctx.file, { limit: 100 });
    for (let i = 0; i < tail.context.entryIds.length; i++) {
      const fullIdx = full.entryIds.indexOf(tail.context.entryIds[i]);
      assert.deepEqual(tail.context.messages[i], full.messages[fullIdx]);
    }
    assert.equal(tail.context.thinkingLevel, full.thinkingLevel);
    assert.deepEqual(tail.context.model, full.model);
  } finally {
    cleanup(ctx);
  }
});

test("compaction summary renders at its chronological point with kept tail", async () => {
  const entries = [
    user("u1", null, "elided", 1),
    assistant("a1", "u1", "elided too", 2),
    user("u2", "a1", "kept", 3),
    { type: "compaction", id: "cmp", parentId: "u2", timestamp: TS(4), summary: "the summary", firstKeptEntryId: "u2", tokensBefore: 42 },
    user("u3", "cmp", "after", 5),
  ];
  const ctx = journal(entries);
  try {
    const result = await readSessionHistory(ctx.file, { limit: 100 });
    assert.deepEqual(result.context.entryIds, ["u2", "cmp", "u3"]);
    const summary = result.context.messages[1];
    assert.equal(summary.role, "custom");
    assert.equal(summary.customType, "compaction");
    assert.equal(summary.content, "the summary");
    assert.equal(summary.details.tokensBefore, 42);
    assert.equal(result.page.hasEarlier, false);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Branch leaf selection
// ---------------------------------------------------------------------------

test("branch leaf selects its own parent chain, not the physically last entry", async () => {
  const entries = [
    user("u1", null, "shared root", 1),
    assistant("a1", "u1", "branch A answer", 2),
    user("u2", "u1", "branch B request", 3),
    assistant("a2", "u2", "branch B answer", 4),
  ];
  const ctx = journal(entries);
  try {
    const latest = await readSessionHistory(ctx.file, { limit: 100 });
    assert.deepEqual(latest.context.entryIds, ["u1", "u2", "a2"]);
    const branchA = await readSessionHistory(ctx.file, { leafId: "a1", limit: 100 });
    assert.deepEqual(branchA.context.entryIds, ["u1", "a1"]);
    assert.equal(branchA.page.hasEarlier, false);
    const cleared = await readSessionHistory(ctx.file, { leafId: null });
    assert.deepEqual(cleared.context.entryIds, []);
    assert.equal(cleared.page.hasEarlier, false);
    // Unknown leaf falls back to the replayed leaf, never errors.
    const unknown = await readSessionHistory(ctx.file, { leafId: "nope", limit: 100 });
    assert.deepEqual(unknown.context.entryIds, ["u1", "u2", "a2"]);
  } finally {
    cleanup(ctx);
  }
});

for (const { name, capturedLeaf, expectedLeaf, expectedIds } of [
  { name: "absent", capturedLeaf: {}, expectedLeaf: "usage-tail", expectedIds: ["u1", "a1"] },
  { name: "explicit null", capturedLeaf: { activeLeafId: null }, expectedLeaf: null, expectedIds: [] },
  { name: "captured string", capturedLeaf: { activeLeafId: "a1" }, expectedLeaf: "a1", expectedIds: ["u1", "a1"] },
  { name: "dangling captured string", capturedLeaf: { activeLeafId: "removed" }, expectedLeaf: "usage-self", expectedIds: ["u1", "a1"] },
]) {
  test(`model_usage tail with ${name} activeLeafId matches SDK branch replay`, async () => {
    const usage = {
      type: "model_usage",
      purpose: "retry",
      provider: "test",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
    };
    const entries = [
      { type: "model_change", id: "model", parentId: null, timestamp: TS(0), model: "test/test-model" },
      user("u1", "model", "request", 1),
      assistant("a1", "u1", "answer", 2),
      // A dangling capture must fall back to this self-selecting marker,
      // not skip it in favor of the preceding assistant message.
      { ...usage, id: "usage-self", parentId: "a1", timestamp: TS(3) },
      { ...usage, id: "usage-tail", parentId: "usage-self", timestamp: TS(4), ...capturedLeaf },
    ];
    const ctx = journal(entries);
    try {
      const sdkLeaf = resolveSessionLeafId(entries);
      assert.equal(sdkLeaf, expectedLeaf);
      const full = buildSessionContext(entries, sdkLeaf);
      assert.equal(full.messages.length, expectedIds.length);
      assert.deepEqual(full.entryIds, expectedIds);

      // Live hosts supply their SDK-resolved leaf independently of this
      // reader; a correct anchor must not mask a broken branch replay.
      const stat = statSync(ctx.file);
      const hostAnchor = {
        lastEntryId: "usage-tail",
        leafId: sdkLeaf,
        entryCount: entries.length,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      const hostBounded = await readSessionHistory(ctx.file, { anchor: hostAnchor });
      assert.equal(hostBounded.context.messages.length, expectedIds.length);
      assert.deepEqual(hostBounded.context.entryIds, expectedIds);
      assert.deepEqual(hostBounded.page.anchor, hostAnchor);

      const result = await readSessionHistory(ctx.file);
      assert.equal(result.context.messages.length, expectedIds.length);
      assert.deepEqual(result.context.entryIds, expectedIds);
      assert.deepEqual(result.context.messages, full.messages);
      assert.equal(result.page.anchor.leafId, expectedLeaf);

      const anchor = await readJournalAnchor(ctx.file);
      assert.equal(anchor.leafId, expectedLeaf);
      assert.equal(anchor.lastEntryId, "usage-tail");
      const bounded = await readSessionHistory(ctx.file, { anchor });
      assert.deepEqual(bounded.context.entryIds, expectedIds);
      assert.equal(bounded.page.anchor.leafId, expectedLeaf);
    } finally {
      cleanup(ctx);
    }
  });
}

test("metadata tree exposes both branches with labels and previews", async () => {
  const entries = [
    user("u1", null, "shared root", 1),
    assistant("a1", "u1", "branch A answer", 2),
    user("u2", "u1", "branch B request", 3),
    assistant("a2", "u2", "branch B answer", 4),
    { type: "label", id: "lbl", parentId: "a2", timestamp: TS(5), targetId: "a1", label: "plan A" },
  ];
  const ctx = journal(entries);
  try {
    const result = await readSessionHistory(ctx.file);
    assert.ok(result.tree);
    assert.equal(result.tree.length, 1);
    const root = result.tree[0];
    assert.equal(root.entry.id, "u1");
    assert.equal(root.children.length, 2);
    const ids = root.children.map((n) => n.entry.id).sort();
    assert.deepEqual(ids, ["a1", "u2"]);
    const a1 = root.children.find((n) => n.entry.id === "a1");
    assert.equal(a1.label, "plan A");
    assert.equal(a1.entry.message.role, "assistant");
    assert.ok(a1.entry.message.content.includes("branch A"));
    // Spine entries are metadata stubs: no giant bodies leak into the tree.
    assert.ok(!JSON.stringify(result.tree).includes("parentId\":null,\"timestamp\"".repeat(50)));
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Anchor bounds: later appends excluded, after-delta bounded
// ---------------------------------------------------------------------------

test("anchor excludes entries appended after capture", async () => {
  const ctx = journal(linearTurns(6)); // 12 messages, ends a5
  try {
    const anchor = await readJournalAnchor(ctx.file);
    assert.equal(anchor.lastEntryId, "a5");
    assert.equal(anchor.entryCount, 12);
    assert.equal(anchor.sizeBytes, statSync(ctx.file).size);

    appendFileSync(ctx.file, JSON.stringify(user("u6", "a5", "later request", 20)) + "\n");
    appendFileSync(ctx.file, JSON.stringify(assistant("a6", "u6", "later answer", 21)) + "\n");

    const bounded = await readSessionHistory(ctx.file, { anchor, limit: 100 });
    assert.deepEqual(bounded.context.entryIds, linearTurns(6).map((e) => e.id));
    assert.ok(!bounded.context.entryIds.includes("u6"));
    assert.ok(!bounded.context.entryIds.includes("a6"));
    assert.deepEqual(bounded.page.anchor, anchor);
    assert.equal(bounded.page.hasEarlier, false); // limit 100 covers all 12

    const unbounded = await readSessionHistory(ctx.file, { limit: 100 });
    assert.ok(unbounded.context.entryIds.includes("a6"));
    assert.notDeepEqual(unbounded.page.anchor, anchor);
    assert.equal(unbounded.page.anchor.entryCount, 14);
  } finally {
    cleanup(ctx);
  }
});

test("after delta returns strictly later entries up to the anchor", async () => {
  const ctx = journal(linearTurns(5)); // ends a4
  try {
    const cached = await readSessionHistory(ctx.file, { limit: 5 });
    const cachedLast = cached.context.entryIds[cached.context.entryIds.length - 1];
    assert.equal(cachedLast, "a4");
    // Capture the anchor AFTER u5/a5 land but BEFORE u6: the delta must
    // include the new turn yet exclude the post-anchor append.
    appendFileSync(ctx.file, JSON.stringify(user("u5", "a4", "new request", 30)) + "\n");
    appendFileSync(ctx.file, JSON.stringify(assistant("a5", "u5", "new answer", 31)) + "\n");
    const anchor = await readJournalAnchor(ctx.file);
    appendFileSync(ctx.file, JSON.stringify(user("u6", "a5", "beyond anchor", 32)) + "\n");

    const delta = await readSessionHistory(ctx.file, { after: cachedLast, anchor });
    assert.deepEqual(delta.context.entryIds, ["u5", "a5"]);
    assert.equal(delta.page.hasEarlier, true);
    assert.deepEqual(delta.page.anchor, anchor);

    // Latest anchor now includes u6: delta after a5 yields exactly it.
    const latestAnchor = await readJournalAnchor(ctx.file);
    const caught = await readSessionHistory(ctx.file, { after: "a5", anchor: latestAnchor });
    assert.deepEqual(caught.context.entryIds, ["u6"]);
    // No new durable entries past the cached head: empty delta.
    const same = await readSessionHistory(ctx.file, { after: "u6", anchor: latestAnchor });
    assert.deepEqual(same.context.entryIds, []);
    assert.equal(same.page.hasEarlier, true);

    // Unknown after id (rewritten away): re-sync via tail window, not silence.
    const resync = await readSessionHistory(ctx.file, { after: "gone" });
    assert.equal(resync.context.messages.length, 5);
  } finally {
    cleanup(ctx);
  }
});

test("stale anchor from a rewritten file is rejected and replaced", async () => {
  const ctx = journal(linearTurns(4));
  try {
    const anchor = await readJournalAnchor(ctx.file);
    // Rewrite with fewer entries (discard-style): same path, smaller file.
    writeFileSync(ctx.file, [JSON.stringify(header()), ...linearTurns(2).map((e) => JSON.stringify(e))].join("\n") + "\n");
    const result = await readSessionHistory(ctx.file, { anchor, limit: 100 });
    assert.deepEqual(result.context.entryIds, ["u0", "a0", "u1", "a1"]);
    assert.notDeepEqual(result.page.anchor, anchor);
    assert.equal(result.page.anchor.entryCount, 4);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Invalidation: appends, rewrites, partial trailing lines
// ---------------------------------------------------------------------------

test("partial trailing line is ignored until its newline lands", async () => {
  const ctx = journal(linearTurns(3));
  try {
    const before = await readSessionHistory(ctx.file, { limit: 100 });
    assert.equal(before.context.entryIds.length, 6);
    const complete = JSON.stringify(user("u3", "a2", "streaming in", 40));
    appendFileSync(ctx.file, complete.slice(0, 40)); // no newline yet
    const mid = await readSessionHistory(ctx.file, { limit: 100 });
    assert.deepEqual(mid.context.entryIds, before.context.entryIds);
    assert.equal(mid.page.anchor.entryCount, 6);
    appendFileSync(ctx.file, complete.slice(40) + "\n");
    const after = await readSessionHistory(ctx.file, { limit: 100 });
    assert.equal(after.context.entryIds.length, 7);
    assert.equal(after.context.entryIds[6], "u3");
  } finally {
    cleanup(ctx);
  }
});

test("title-slot rename invalidates cached bodies without losing history", async () => {
  const ctx = journal(linearTurns(3), { title: "old name" });
  try {
    const first = await readSessionHistory(ctx.file, { limit: 100 });
    assert.equal(first.context.entryIds.length, 6);
    // Rewrite the fixed-width title slot in place (same byte length).
    const raw = readFileSync(ctx.file, "utf8");
    const firstNewline = raw.indexOf("\n");
    const slot = JSON.stringify({ type: "title", v: 1, title: "new name", updatedAt: TS(0), pad: "" });
    const padded = slot + " ".repeat(Math.max(0, 255 - slot.length));
    assert.equal(padded.length, firstNewline);
    writeFileSync(ctx.file, padded + raw.slice(firstNewline));
    const second = await readSessionHistory(ctx.file, { limit: 100 });
    assert.deepEqual(second.context.entryIds, first.context.entryIds);
    assert.deepEqual(second.context.messages, first.context.messages);
  } finally {
    cleanup(ctx);
  }
});

test("in-place body rewrite is detected and re-read", async () => {
  const entries = linearTurns(3);
  const ctx = journal(entries);
  try {
    const first = await readSessionHistory(ctx.file, { limit: 100 });
    assert.equal(textOf(first.context.messages[1]), "answer 0");
    // Rewrite the whole file with a changed answer (same ids, same shape).
    const changed = entries.map((e) => e.id === "a0" ? assistant("a0", "u0", "rewritten answer", 2) : e);
    writeFileSync(ctx.file, [JSON.stringify(header()), ...changed.map((e) => JSON.stringify(e))].join("\n") + "\n");
    const second = await readSessionHistory(ctx.file, { limit: 100 });
    assert.equal(textOf(second.context.messages[1]), "rewritten answer");
  } finally {
    cleanup(ctx);
  }
});

test("malformed records are skipped like the SDK loader", async () => {
  const ctx = journal(linearTurns(2));
  try {
    appendFileSync(ctx.file, "{not json at all\n");
    appendFileSync(ctx.file, JSON.stringify(user("u2", "a1", "after junk", 9)) + "\n");
    const result = await readSessionHistory(ctx.file, { limit: 100 });
    assert.deepEqual(result.context.entryIds, ["u0", "a0", "u1", "a1", "u2"]);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Huge lines + deferred payloads
// ---------------------------------------------------------------------------

test("huge text and base64 image entries paginate without full-body rescans", async () => {
  const hugeText = "x".repeat(2 * 1024 * 1024);
  const hugeImage = "A".repeat(3 * 1024 * 1024);
  const entries = [
    user("u0", null, "before the giants", 1),
    {
      type: "message", id: "big1", parentId: "u0", timestamp: TS(2),
      message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: hugeText }] },
    },
    {
      type: "message", id: "img1", parentId: "big1", timestamp: TS(3),
      message: { role: "toolResult", toolCallId: "t1", toolName: "screenshot", content: [{ type: "image", data: hugeImage, mimeType: "image/png" }], isError: false },
    },
    user("u1", "img1", "after the giants", 4),
    assistant("a1", "u1", "final", 5),
  ];
  const ctx = journal(entries);
  try {
    assert.ok(statSync(ctx.file).size > 5 * 1024 * 1024);
    const tail = await readSessionHistory(ctx.file, { limit: 2, deferToolResultImages: true });
    assert.deepEqual(tail.context.entryIds, ["u1", "a1"]);
    assert.equal(tail.page.hasEarlier, true);
    assert.equal(tail.page.headEntryId, "u1");

    const page = await readSessionHistory(ctx.file, { before: "u1", limit: 2, deferToolResultImages: true });
    assert.deepEqual(page.context.entryIds, ["big1", "img1"]);
    assert.equal(textOf(page.context.messages[0]).length, hugeText.length);
    const toolResult = page.context.messages[1];
    assert.ok(!JSON.stringify(toolResult).includes(hugeImage));
    assert.ok(textOf(toolResult).includes("omitted"));

    // Without deferral the image survives intact (export parity).
    const full = await readSessionHistory(ctx.file, { before: "u1", limit: 2 });
    const imageBlock = full.context.messages[1].content.find((b) => b.type === "image");
    assert.equal(imageBlock.data, hugeImage);
  } finally {
    cleanup(ctx);
  }
});

test("deferred thinking blanks non-empty thinking blocks only", async () => {
  const entries = [
    user("u0", null, "q", 1),
    {
      type: "message", id: "a0", parentId: "u0", timestamp: TS(2),
      message: {
        role: "assistant", provider: "test", model: "test-model",
        content: [{ type: "thinking", thinking: "deep thoughts" }, { type: "thinking", thinking: "  " }, { type: "text", text: "a" }],
      },
    },
  ];
  const ctx = journal(entries);
  try {
    const deferred = await readSessionHistory(ctx.file, { deferThinking: true });
    const blocks = deferred.context.messages[1].content;
    assert.equal(blocks[0].thinking, "");
    assert.equal(blocks[0].deferred, true);
    assert.equal(blocks[1].deferred, undefined);
    const intact = await readSessionHistory(ctx.file, {});
    assert.equal(intact.context.messages[1].content[0].thinking, "deep thoughts");
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Missing file / empty journal
// ---------------------------------------------------------------------------

test("missing file and empty journal return empty windows, not errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp99-empty-"));
  try {
    const missing = await readSessionHistory(join(dir, "nope.jsonl"));
    assert.deepEqual(missing.context.entryIds, []);
    assert.equal(missing.page.hasEarlier, false);
    assert.equal(missing.page.anchor.entryCount, 0);
    const emptyFile = join(dir, "empty.jsonl");
    writeFileSync(emptyFile, JSON.stringify(header()) + "\n");
    const empty = await readSessionHistory(emptyFile);
    assert.deepEqual(empty.context.entryIds, []);
    const anchor = await readJournalAnchor(emptyFile);
    assert.equal(anchor.lastEntryId, null);
    assert.equal(anchor.entryCount, 0);
    const missingAnchor = await readJournalAnchor(join(dir, "nope.jsonl"));
    assert.equal(missingAnchor.entryCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Performance proof: ≥1000 entries, cold + warm < 1s, O(window) warm reads
// ---------------------------------------------------------------------------

test("1200-message journal: cold and warm windows render under 1s", async () => {
  const turns = 600; // 1200 durable messages
  const entries = linearTurns(turns);
  // Sprinkle a few multi-MB entries so body size, not count, dominates.
  entries[100].message.content = [{ type: "text", text: "y".repeat(1024 * 1024) }];
  entries[700].message.content = [{ type: "text", text: "z".repeat(1024 * 1024) }];
  const ctx = journal(entries);
  try {
    assert.equal(entries.length, 1200);
    invalidateJournalIndex(ctx.file); // force cold
    let start = performance.now();
    const cold = await readSessionHistory(ctx.file, { limit: 5 });
    const coldMs = performance.now() - start;
    assert.equal(cold.context.messages.length, 5);
    assert.equal(cold.page.hasEarlier, true);
    assert.ok(coldMs < 1000, `cold window took ${coldMs.toFixed(1)}ms`);

    start = performance.now();
    const warm = await readSessionHistory(ctx.file, { limit: 5 });
    const warmMs = performance.now() - start;
    assert.deepEqual(warm.context.entryIds, cold.context.entryIds);
    assert.ok(warmMs < 1000, `warm window took ${warmMs.toFixed(1)}ms`);

    start = performance.now();
    const warmPage = await readSessionHistory(ctx.file, { before: warm.page.headEntryId, limit: 20 });
    const pageMs = performance.now() - start;
    assert.equal(warmPage.context.messages.length, 20);
    assert.ok(pageMs < 1000, `warm earlier page took ${pageMs.toFixed(1)}ms`);

    // Warm delta after one append stays small and fast.
    appendFileSync(ctx.file, JSON.stringify(user("u-extra", `a${turns - 1}`, "delta", 5000)) + "\n");
    start = performance.now();
    const delta = await readSessionHistory(ctx.file, { after: `a${turns - 1}` });
    const deltaMs = performance.now() - start;
    assert.deepEqual(delta.context.entryIds, ["u-extra"]);
    assert.ok(deltaMs < 1000, `warm delta took ${deltaMs.toFixed(1)}ms`);

    console.log(`[perf] 1200 entries: cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms page20=${pageMs.toFixed(1)}ms delta=${deltaMs.toFixed(1)}ms`);
  } finally {
    cleanup(ctx);
  }
});

test("warm refresh does not re-parse unchanged entry bodies", async () => {
  const ctx = journal(linearTurns(50));
  try {
    const first = await readSessionHistory(ctx.file, { limit: 5 });
    const cache = globalThis.__ompJournalIndexCache;
    const index = cache.get(ctx.file);
    assert.ok(index, "journal index must be cached");
    const bodiesBefore = index.bodies.size;
    assert.ok(bodiesBefore > 0 && bodiesBefore <= 5, `window-only bodies cached, got ${bodiesBefore}`);
    await readSessionHistory(ctx.file, { limit: 5 });
    assert.equal(index.bodies.size, bodiesBefore, "warm read must not parse more bodies");
    // A 20-entry earlier page parses only its own window (cache may evict).
    await readSessionHistory(ctx.file, { before: first.page.headEntryId, limit: 20 });
    assert.ok(index.bodies.size <= 25, `page parses only its window, got ${index.bodies.size}`);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Bounded header/title metadata (dead-session detail without fleet scans)
// ---------------------------------------------------------------------------

test("readJournalTitle prefers the fixed title slot over header.title", async () => {
  const withSlot = journal(linearTurns(2), { title: "slot name" });
  const headerOnly = journal(linearTurns(2));
  const untitled = journal(linearTurns(2));
  try {
    assert.equal(await readJournalTitle(withSlot.file), "slot name");
    // Header-inline title (legacy naming path).
    const raw = readFileSync(headerOnly.file, "utf8");
    const firstNewline = raw.indexOf("\n");
    const titledHeader = { ...header(), title: "header name" };
    writeFileSync(headerOnly.file, JSON.stringify(titledHeader) + raw.slice(firstNewline));
    assert.equal(await readJournalTitle(headerOnly.file), "header name");
    assert.equal(await readJournalTitle(untitled.file), undefined);
    assert.equal(await readJournalTitle(join(untitled.dir, "missing.jsonl")), undefined);
    // Slot rename is visible without any entry-body read.
    const slotRaw = readFileSync(withSlot.file, "utf8");
    const slotEnd = slotRaw.indexOf("\n");
    const slot = JSON.stringify({ type: "title", v: 1, title: "renamed", updatedAt: TS(0), pad: "" });
    writeFileSync(withSlot.file, slot + " ".repeat(Math.max(0, 255 - slot.length)) + slotRaw.slice(slotEnd));
    assert.equal(await readJournalTitle(withSlot.file), "renamed");
  } finally {
    cleanup(withSlot);
    cleanup(headerOnly);
    cleanup(untitled);
  }
});

test("history result carries bounded header metadata with slot title folded", async () => {
  const ctx = journal(linearTurns(3), { title: "my session" });
  try {
    const result = await readSessionHistory(ctx.file, { limit: 5 });
    assert.ok(result.header);
    assert.equal(result.header.id, "sess-test");
    assert.equal(result.header.cwd, "/tmp/project");
    assert.equal(result.header.title, "my session");
    assert.equal(result.header.type, "session");
    assert.equal(typeof result.header.timestamp, "string");
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// Legacy v1 journals: migration runs once, ids stable across pages, tree present
// ---------------------------------------------------------------------------

test("legacy v1 journal paginates with stable migrated ids and a spine tree", async () => {
  // v1 records carry no ids/parents; the SDK migration assigns them. Build a
  // deterministic 30-message v1 file (no compaction, linear chain).
  const dir = mkdtempSync(join(tmpdir(), "omp99-legacy-"));
  const file = join(dir, "session.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 1, id: "legacy-sess", timestamp: TS(0), cwd: "/tmp/project" })];
  for (let i = 0; i < 15; i++) {
    lines.push(JSON.stringify({ type: "message", timestamp: TS(i * 2 + 1), message: { role: "user", content: `request ${i}` } }));
    lines.push(JSON.stringify({
      type: "message", timestamp: TS(i * 2 + 2),
      message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: `answer ${i}` }] },
    }));
  }
  writeFileSync(file, lines.join("\n") + "\n");
  try {
    const first = await readSessionHistory(file, { limit: 5 });
    assert.equal(first.context.messages.length, 5);
    assert.equal(first.page.hasEarlier, true);
    assert.ok(first.tree && first.tree.length === 1, "legacy read must expose the spine tree");
    // Migrated ids are non-empty and the chain is linear root-first.
    const firstIds = first.context.entryIds;
    assert.ok(firstIds.every((id) => typeof id === "string" && id.length > 0));

    // Walk backward twice: the SAME page must return identical ids (migration
    // cached, not re-run with fresh random ids per request).
    const pageA = await readSessionHistory(file, { before: first.page.headEntryId, limit: 20 });
    const pageB = await readSessionHistory(file, { before: first.page.headEntryId, limit: 20 });
    assert.deepEqual(pageA.context.entryIds, pageB.context.entryIds);
    assert.equal(pageA.context.messages.length, 20);
    for (const id of pageA.context.entryIds) assert.ok(!firstIds.includes(id));

    // Continue to the start: union is exactly the 30 migrated messages.
    const collected = [...pageA.context.entryIds, ...firstIds];
    let head = pageA.page.headEntryId;
    let guard = 0;
    while (pageA.page.hasEarlier && guard++ < 5) {
      const earlier = await readSessionHistory(file, { before: head, limit: 20 });
      for (const id of earlier.context.entryIds) assert.ok(!collected.includes(id));
      collected.unshift(...earlier.context.entryIds);
      if (!earlier.page.hasEarlier) break;
      head = earlier.page.headEntryId;
    }
    assert.equal(collected.length, 30);
    // Content order matches the file: request 0 first, answer 14 last.
    const all = await readSessionHistory(file, { limit: 100 });
    assert.deepEqual(all.context.entryIds, collected);
    assert.equal(textOf(all.context.messages[0]), "request 0");
    assert.equal(textOf(all.context.messages[29]), "answer 14");
    assert.equal(all.page.hasEarlier, false);
    // Tree ids align with the migrated transcript ids.
    const treeIds = [];
    const stack = [...all.tree];
    while (stack.length) {
      const node = stack.pop();
      treeIds.push(node.entry.id);
      stack.push(...node.children);
    }
    for (const id of collected) assert.ok(treeIds.includes(id));
    // Explicit null leaf clears the legacy transcript too.
    const cleared = await readSessionHistory(file, { leafId: null });
    assert.deepEqual(cleared.context.entryIds, []);
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #104 outline: metadata-only entries, ordinals, tool-only previews
// ---------------------------------------------------------------------------

function toolOnlyAssistant(id, parentId, i, blocks) {
  return assistant(id, parentId, "", i, { content: blocks });
}

async function assertTargetUnavailable(promise, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HistoryTargetUnavailableError, `expected HistoryTargetUnavailableError, got ${error}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("outline lists every user/assistant/summary with rendered-message ordinals and skips non-chat entries", async () => {
  const entries = [
    { type: "model_change", id: "model", parentId: null, timestamp: TS(0), model: "test/test-model" },
    user("u1", "model", "first   request\nwith whitespace", 1),
    toolOnlyAssistant("a1", "u1", 2, [
      { type: "thinking", thinking: "hmm" },
      { type: "toolCall", toolCallId: "c1", toolName: "bash", input: {} },
      { type: "toolCall", id: "c2", name: "read", arguments: {} },
    ]),
    {
      type: "message", id: "tr1", parentId: "a1", timestamp: TS(3),
      message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
    },
    assistant("a2", "tr1", "final answer", 4),
    { type: "compaction", id: "cmp", parentId: "a2", timestamp: TS(5), summary: "the  summary", firstKeptEntryId: "u1", tokensBefore: 10 },
    { type: "branch_summary", id: "bs", parentId: "cmp", timestamp: TS(6), fromId: "a1", summary: "branch note" },
    { type: "custom_message", id: "cm", parentId: "bs", timestamp: TS(7), customType: "note", content: "custom note", display: true },
    user("u2", "cm", "last request", 8),
  ];
  const ctx = journal(entries);
  try {
    const outline = await readSessionOutline(ctx.file);
    assert.equal(outline.leafId, "u2");
    assert.deepEqual(outline.entries.map((e) => [e.entryId, e.role, e.ordinal]), [
      ["u1", "user", 0],
      ["a1", "assistant", 1],
      ["a2", "assistant", 3],
      ["cmp", "summary", 4],
      ["bs", "summary", 5],
      ["u2", "user", 7],
    ]);
    const byId = new Map(outline.entries.map((e) => [e.entryId, e]));
    assert.equal(byId.get("u1").preview, "first request with whitespace");
    assert.equal(byId.get("a1").preview, "bash, read"); // tool-only: normalized toolName/name labels
    assert.equal(byId.get("cmp").preview, "the summary");
    assert.equal(byId.get("bs").preview, "branch note");
    assert.equal(byId.get("u1").timestamp, TS(1));
    // Ordinals match the window reader's rendered positions exactly (the
    // toolResult at 2 and custom_message at 6 render but are not listed).
    const full = await readSessionHistory(ctx.file, { limit: 100 });
    for (const entry of outline.entries) {
      assert.equal(full.context.entryIds[entry.ordinal], entry.entryId);
    }
    // Outline anchor equals the window reader's anchor (same snapshot).
    assert.deepEqual(outline.anchor, full.page.anchor);
  } finally {
    cleanup(ctx);
  }
});

for (const version of [2, 3]) {
  test(`v${version} outline marks only assistants whose previews come from tool calls`, async () => {
    const call = { type: "toolCall", toolCallId: "call", toolName: "read", input: {} };
    const ctx = journal([
      user("request", null, "Inspect this", 1),
      toolOnlyAssistant("tools", "request", 2, [call, { ...call, toolName: "bash" }]),
      assistant("text-and-tools", "tools", "", 3, { content: [
        call, { type: "text", text: "Narration\n wins" }, { ...call, toolName: "bash" },
      ] }),
      toolOnlyAssistant("empty-text", "text-and-tools", 4, [{ type: "text", text: " \n " }, call]),
      assistant("image", "empty-text", "", 5, { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }),
      { ...user("user-tools", "image", "", 6), message: { role: "user", content: [call] } },
      {
        type: "message", id: "ask-result", parentId: "user-tools", timestamp: TS(7),
        message: { role: "toolResult", toolName: "ask", toolCallId: "call", content: [call] },
      },
    ], { version });
    try {
      const outline = await readSessionOutline(ctx.file);
      const byId = new Map(outline.entries.map((entry) => [entry.entryId, entry]));
      assert.equal(byId.get("tools").preview, "read, bash");
      assert.equal(byId.get("tools").toolOnly, true);
      assert.equal(byId.get("text-and-tools").preview, "Narration wins");
      assert.equal(byId.get("empty-text").toolOnly, true, "whitespace does not contribute a text preview");
      assert.equal(byId.get("image").preview, "[image]");
      for (const id of ["request", "text-and-tools", "image", "user-tools", "ask-result"]) {
        assert.equal(Object.hasOwn(byId.get(id), "toolOnly"), false, `${id} is not a tool-only assistant`);
      }
    } finally {
      cleanup(ctx);
    }
  });

  test(`v${version} outline lists cleaned async-result deliveries with rendered-position ordinals`, async () => {
    const cases = [
      {
        content: `<system-notice>${"background notice ".repeat(30)}<task-result duration="6m16s" agent="task" status="completed" id="worker-1">Result</task-result></system-notice>`,
        expected: "worker-1 · completed · 6m16s",
      },
      {
        content: [
          { type: "text", text: "<task-result status='completed' id='first' duration='1s'>One</task-result>" },
          { type: "text", text: '<task-result id="second" status="failed">Two</task-result>' },
        ],
        expected: "first · completed · 1s +1",
      },
      { content: '<task-result id="id-only">Result</task-result>', expected: "id-only" },
      { content: '<task-result duration="2s" status="failed">Result</task-result>', expected: "failed · 2s" },
      { content: '<task-result duration="3s">Result</task-result>', expected: "3s" },
      { content: '<task-result>Unknown worker</task-result>', expected: "<task-result>Unknown worker</task-result>" },
      { content: '<task-result id="broken" status="completed"', expected: '<task-result id="broken" status="completed"' },
      { content: '<task-result-extra id="not-a-worker">Other tag</task-result-extra>', expected: '<task-result-extra id="not-a-worker">Other tag</task-result-extra>' },
      { content: "Background job completed\n without a tag", expected: "Background job completed without a tag" },
      { content: `<task-result id="${"x".repeat(250)}" status="completed">Result</task-result>`, expected: "x".repeat(200) },
    ];
    for (const { content, expected } of cases) {
      const ctx = journal([
        user("before", null, "Start a worker", 1),
        { type: "custom_message", id: "delivery", parentId: "before", timestamp: TS(2), customType: "async-result", content, display: true },
        { type: "custom_message", id: "plan", parentId: "delivery", timestamp: TS(3), customType: "prewalk-plan", content: '<task-result id="not-a-delivery" status="completed">Plan</task-result>', display: true },
        assistant("after", "plan", "All done", 4),
      ], { version });
      try {
        const outline = await readSessionOutline(ctx.file);
        assert.deepEqual(outline.entries.map((entry) => [entry.entryId, entry.role, entry.ordinal]), [
          ["before", "user", 0], ["delivery", "subagent", 1], ["after", "assistant", 3],
        ]);
        assert.equal(outline.entries[1].preview, expected);
        assert.equal(Object.hasOwn(outline.entries[1], "toolOnly"), false);
        const full = await readSessionHistory(ctx.file, { limit: 100 });
        assert.deepEqual(full.context.entryIds, ["before", "delivery", "plan", "after"]);
        for (const entry of outline.entries) {
          assert.equal(full.context.entryIds[entry.ordinal], entry.entryId);
        }
      } finally {
        cleanup(ctx);
      }
    }
  });
}

test("outline includes ask answers without changing tool-result ordinals", async () => {
  const askCall = toolOnlyAssistant("ask-call", "request", 2, [
    { type: "toolCall", toolCallId: "ask-1", toolName: "ask", input: { questions: [{ id: "db", question: "Storage?", options: [{ label: "Postgres" }] }] } },
  ]);
  const ctx = journal([
    user("request", null, "Choose storage", 1),
    askCall,
    {
      type: "message", id: "ask-answer", parentId: "ask-call", timestamp: TS(3),
      message: { role: "toolResult", toolCallId: "ask-1", toolName: "ask", content: [{ type: "text", text: "User answers: fallback" }], details: { results: [
        { id: "db", selectedOptions: ["Postgres", "SQLite"], customInput: "shared\ninstance" },
        { id: "region", selectedOptions: ["Europe"] },
      ] }, isError: false },
    },
    {
      type: "message", id: "other-result", parentId: "ask-answer", timestamp: TS(4),
      message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "not an answer" }] },
    },
    assistant("final", "other-result", "Proceed", 5),
  ]);
  try {
    const outline = await readSessionOutline(ctx.file);
    assert.deepEqual(outline.entries.map((entry) => [entry.entryId, entry.role, entry.ordinal]), [
      ["request", "user", 0], ["ask-call", "assistant", 1], ["ask-answer", "ask", 2], ["final", "assistant", 4],
    ]);
    assert.equal(outline.entries[2].preview, "Postgres, SQLite (custom: shared instance); Europe");
    const full = await readSessionHistory(ctx.file, { limit: 100 });
    assert.equal(full.context.entryIds[outline.entries[2].ordinal], "ask-answer");
    const around = await readSessionHistory(ctx.file, { around: "ask-answer", limit: 1 });
    assert.deepEqual(around.context.entryIds, ["ask-answer"]);
  } finally {
    cleanup(ctx);
  }
});

test("ask outline previews cover single details, chat redirects, fallback and errors", async () => {
  const cases = [
    { details: { selectedOptions: ["SQLite"], customInput: "local only" }, expected: "SQLite (custom: local only)" },
    { details: { selectedOptions: [], customInput: "Use files" }, expected: "(custom: Use files)" },
    { details: { chatRedirect: true, questions: ["Storage?"] }, expected: "Chat about this" },
    {
      details: { chatRedirect: true, discussion: [
        { id: "db", question: "Storage?", text: "  不同意推荐\n  请先讨论  " },
        { id: "region", text: "\t第二个问题\r\n  也要讨论 " },
      ], selectedOptions: ["Never include this selection"], customInput: "Never include custom answer" },
      expected: "Chat about this: 不同意推荐 请先讨论; 第二个问题 也要讨论",
    },
    {
      details: { chatRedirect: true, discussion: [
        null, 42, "bad entry", [], {}, { text: "Missing id" }, { id: 42, text: "Invalid id" },
        { id: "db", text: null }, { id: "db", text: 42 }, { id: "db", text: " \n\t" },
        { id: "region", text: "  Valid\n discussion " },
      ] },
      expected: "Chat about this: Valid discussion",
    },
    ...[undefined, null, "not an array", {}, [null, {}, { id: "db", text: " \n " }, { id: 7, text: "Invalid id" }]]
      .map((discussion) => ({ details: { chatRedirect: true, discussion }, expected: "Chat about this" })),
    {
      details: { chatRedirect: true, discussion: [{ id: "db", text: "  " + "界".repeat(500) + "\nignored tail" }] },
      expected: "Chat about this: " + "界".repeat(200 - "Chat about this: ".length),
    },
    {
      details: { chatRedirect: true, discussion: [{ id: "db", text: "Never show successful discussion" }] },
      isError: true,
      text: "Ask input was cancelled",
      expected: "Ask input was cancelled",
    },
    { details: undefined, expected: "User answers: legacy response" },
    { details: { results: [null] }, expected: "User answers: legacy response" },
    { details: { selectedOptions: [42] }, expected: "User answers: legacy response" },
    { details: { selectedOptions: ["ignore erroneous details"] }, isError: true, text: "Ask input was cancelled", expected: "Ask input was cancelled" },
    { details: { results: [{ selectedOptions: ["x".repeat(500)], customInput: "y".repeat(500) }] }, expected: "x".repeat(200) },
  ];
  for (const { details, isError = false, text = "User answers:\nlegacy response", expected } of cases) {
    const ctx = journal([{
      type: "message", id: "answer", parentId: null, timestamp: TS(1),
      message: { role: "toolResult", toolCallId: "ask-1", toolName: "ask", content: [{ type: "text", text }], details, isError },
    }]);
    try {
      const outline = await readSessionOutline(ctx.file);
      assert.equal(outline.entries.length, 1);
      assert.equal(outline.entries[0].role, "ask");
      assert.equal(outline.entries[0].ordinal, 0);
      assert.equal(outline.entries[0].preview, expected);
    } finally {
      cleanup(ctx);
    }
  }
});

test("persisted chat discussion retains exact details across journal history and outline reload", async () => {
  const details = {
    chatRedirect: true,
    questions: ["Storage?", "Region?"],
    discussion: [
      { id: "region", question: "Region?", text: "  区域限制\n请先解释 & <确认>  " },
      { id: "db", question: "Storage?", text: "不接受推荐方案。\n  先讨论替代方案。" },
    ],
  };
  const ctx = journal([
    user("request", null, "Discuss these choices", 1),
    toolOnlyAssistant("ask-call", "request", 2, [{
      type: "toolCall", toolCallId: "ask-1", toolName: "ask",
      input: { questions: [
        { id: "db", question: "Storage?", options: [{ label: "Postgres" }] },
        { id: "region", question: "Region?", options: [{ label: "Europe" }] },
      ] },
    }]),
    {
      type: "message", id: "ask-answer", parentId: "ask-call", timestamp: TS(3),
      message: {
        role: "toolResult", toolCallId: "ask-1", toolName: "ask", isError: false,
        content: [{ type: "text", text: "Chat about this" }], details,
      },
    },
  ]);
  try {
    for (let load = 0; load < 2; load++) {
      if (load > 0) invalidateJournalIndex(ctx.file);
      const history = await readSessionHistory(ctx.file, { limit: 100 });
      const answerIndex = history.context.entryIds.indexOf("ask-answer");
      assert.equal(answerIndex, 2);
      const result = history.context.messages[answerIndex];
      assert.equal(result.role, "toolResult");
      assert.deepEqual(result.details, details);
      assert.deepEqual(result.details.discussion, details.discussion);
      const outline = await readSessionOutline(ctx.file);
      const answer = outline.entries.find((entry) => entry.entryId === "ask-answer");
      assert.equal(answer.role, "ask");
      assert.equal(answer.ordinal, answerIndex);
      assert.equal(answer.preview, "Chat about this: 区域限制 请先解释 & <确认>; 不接受推荐方案。 先讨论替代方案。");
    }
  } finally {
    cleanup(ctx);
  }
});

test("outline previews stay bounded for huge text and many tool calls, image-only turns labeled", async () => {
  const blocks = [];
  for (let i = 0; i < 80; i++) blocks.push({ type: "toolCall", toolCallId: `c${i}`, toolName: `tool${i}`, input: {} });
  // Exactly at the scan cap the omitted count is still known: 64 - 8 = 56.
  const atCap = [];
  for (let i = 0; i < 64; i++) atCap.push({ type: "toolCall", toolCallId: `k${i}`, toolName: `tool${i}`, input: {} });
  const entries = [
    user("u1", null, "x".repeat(5000), 1),
    toolOnlyAssistant("a1", "u1", 2, blocks),
    assistant("a2", "a1", "", 3, { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }),
    toolOnlyAssistant("a3", "a2", 4, atCap),
  ];
  const ctx = journal(entries);
  try {
    const outline = await readSessionOutline(ctx.file);
    const byId = new Map(outline.entries.map((e) => [e.entryId, e]));
    assert.equal(byId.get("u1").preview.length, 200);
    const toolPreview = byId.get("a1").preview;
    assert.ok(toolPreview.startsWith("tool0, tool1, "), "tool labels in block order");
    assert.ok(toolPreview.includes("… more"), "unknown-total marker once the scan cap is reached");
    assert.ok(!toolPreview.includes("+72"), "no exact count claimed beyond the scan cap");
    assert.ok(toolPreview.length <= 200);
    assert.equal(byId.get("a2").preview, "[image]");
    const capPreview = byId.get("a3").preview;
    assert.ok(capPreview.includes("+56 more"), "exact omitted count at the scan cap boundary");
    assert.ok(!capPreview.includes("…"), "no unknown-total marker when the count is exact");
  } finally {
    cleanup(ctx);
  }
});

test("outline covers compaction elision, branch leaves and #105 model_usage tails", async () => {
  const entries = [
    user("u1", null, "elided request", 1),
    assistant("a1", "u1", "elided answer", 2),
    user("u2", "a1", "kept request", 3),
    { type: "compaction", id: "cmp", parentId: "u2", timestamp: TS(4), summary: "kept summary", firstKeptEntryId: "u2", tokensBefore: 5 },
    assistant("a2", "cmp", "kept answer", 5),
    user("u3", "a2", "side branch request", 6),
    assistant("a3", "u3", "side branch answer", 7),
  ];
  const ctx = journal(entries);
  try {
    const outline = await readSessionOutline(ctx.file);
    assert.deepEqual(outline.entries.map((e) => e.entryId), ["u2", "cmp", "a2", "u3", "a3"]);
    assert.deepEqual(outline.entries.map((e) => e.ordinal), [0, 1, 2, 3, 4]);
    // Compacted-away history never appears; its ids are not navigable.
    await assertTargetUnavailable(readSessionHistory(ctx.file, { around: "u1", limit: 20 }), "not_visible");

    const mainLeaf = await readSessionOutline(ctx.file, { leafId: "a2" });
    assert.equal(mainLeaf.leafId, "a2");
    assert.deepEqual(mainLeaf.entries.map((e) => e.entryId), ["u2", "cmp", "a2"]);
    await assertTargetUnavailable(readSessionHistory(ctx.file, { around: "a3", limit: 20, leafId: "a2" }), "not_visible");

    const cleared = await readSessionOutline(ctx.file, { leafId: null });
    assert.equal(cleared.leafId, null);
    assert.deepEqual(cleared.entries, []);
    await assertTargetUnavailable(readSessionHistory(ctx.file, { around: "u2", limit: 20, leafId: null }), "not_visible");
  } finally {
    cleanup(ctx);
  }

  // #105 tail semantics survive on the outline path: absent field selects the
  // marker itself (renders), explicit null clears the branch entirely.
  const usage = { type: "model_usage", purpose: "retry", provider: "test", model: "test-model", stopReason: "error" };
  for (const { capturedLeaf, expectedIds, expectedLeaf } of [
    { capturedLeaf: {}, expectedIds: ["u1", "a1"], expectedLeaf: "usage-tail" },
    { capturedLeaf: { activeLeafId: null }, expectedIds: [], expectedLeaf: null },
    { capturedLeaf: { activeLeafId: "a1" }, expectedIds: ["u1", "a1"], expectedLeaf: "a1" },
  ]) {
    const usageCtx = journal([
      user("u1", null, "request", 1),
      assistant("a1", "u1", "answer", 2),
      { ...usage, id: "usage-tail", parentId: "a1", timestamp: TS(3), ...capturedLeaf },
    ]);
    try {
      const outline = await readSessionOutline(usageCtx.file);
      assert.equal(outline.leafId, expectedLeaf);
      assert.deepEqual(outline.entries.map((e) => e.entryId), expectedIds);
    } finally {
      cleanup(usageCtx);
    }
  }
});

// ---------------------------------------------------------------------------
// #104 around windows: inclusive, centered/edge-clamped, structured failures
// ---------------------------------------------------------------------------

test("around includes the target at first/middle/last positions with edge clamping and page metadata", async () => {
  const ctx = journal(linearTurns(15)); // 30 rendered messages u0..a14
  try {
    const ids = (await readSessionHistory(ctx.file, { limit: 100 })).context.entryIds;
    assert.equal(ids.length, 30);

    const first = await readSessionHistory(ctx.file, { around: "u0", limit: 20 });
    assert.deepEqual(first.context.entryIds, ids.slice(0, 20));
    assert.equal(first.page.hasEarlier, false);
    assert.equal(first.page.hasLater, true);
    assert.equal(first.page.headEntryId, "u0");
    assert.equal(first.page.tailEntryId, "a14");

    const middle = await readSessionHistory(ctx.file, { around: ids[15], limit: 20 });
    assert.deepEqual(middle.context.entryIds, ids.slice(6, 26));
    assert.ok(middle.context.entryIds.includes(ids[15]), "target included");
    assert.equal(middle.page.hasEarlier, true);
    assert.equal(middle.page.hasLater, true);

    const last = await readSessionHistory(ctx.file, { around: "a14", limit: 20 });
    assert.deepEqual(last.context.entryIds, ids.slice(10, 30));
    assert.equal(last.page.hasEarlier, true);
    assert.equal(last.page.hasLater, false);
    assert.equal(last.page.tailEntryId, "a14");

    // limit larger than the transcript: everything, target included.
    const whole = await readSessionHistory(ctx.file, { around: ids[15], limit: 100 });
    assert.deepEqual(whole.context.entryIds, ids);
    assert.equal(whole.page.hasEarlier, false);
    assert.equal(whole.page.hasLater, false);

    // Even limit keeps the target included (center biased toward earlier).
    const even = await readSessionHistory(ctx.file, { around: ids[15], limit: 4 });
    assert.deepEqual(even.context.entryIds, ids.slice(14, 18));

    // Window content parity with the export conversion for the same slice.
    const full = buildSessionContext(linearTurns(15));
    for (let i = 0; i < middle.context.entryIds.length; i++) {
      const fullIdx = full.entryIds.indexOf(middle.context.entryIds[i]);
      assert.deepEqual(middle.context.messages[i], full.messages[fullIdx]);
    }
  } finally {
    cleanup(ctx);
  }
});

test("around honors anchors, defers payloads and fails structured on missing targets — never tail fallback", async () => {
  const ctx = journal(linearTurns(10)); // 20 messages
  try {
    const anchor = await readJournalAnchor(ctx.file);
    appendFileSync(ctx.file, JSON.stringify(user("u10", "a9", "beyond the anchor", 99)) + "\n");

    const bounded = await readSessionHistory(ctx.file, { around: "a5", limit: 6, anchor });
    assert.deepEqual(bounded.context.entryIds, ["a4", "u5", "a5", "u6", "a6", "u7"]);
    assert.deepEqual(bounded.page.anchor, anchor);
    assert.equal(bounded.page.tailEntryId, "a9", "tailEntryId bounded by the anchor, not the grown file");
    assert.equal(bounded.page.hasLater, true);
    await assertTargetUnavailable(
      readSessionHistory(ctx.file, { around: "u10", limit: 6, anchor }),
      "not_found",
    );
    // Without the anchor the appended entry is reachable.
    const fresh = await readSessionHistory(ctx.file, { around: "u10", limit: 6 });
    assert.ok(fresh.context.entryIds.includes("u10"));
    assert.equal(fresh.page.hasLater, false);

    await assertTargetUnavailable(readSessionHistory(ctx.file, { around: "nope", limit: 6 }), "not_found");
    await assertTargetUnavailable(readSessionHistory(ctx.file, { around: "a5", limit: 6, leafId: null }), "not_visible");
  } finally {
    cleanup(ctx);
  }

  // Deferred payloads apply to around windows exactly like tail windows.
  const deferredCtx = journal([
    user("u1", null, "go", 1),
    assistant("a1", "u1", "", 2, {
      content: [{ type: "thinking", thinking: "deep thoughts" }, { type: "text", text: "answer" }],
    }),
    user("u2", "a1", "next", 3),
  ]);
  try {
    const deferred = await readSessionHistory(deferredCtx.file, { around: "a1", limit: 3, deferThinking: true });
    const thinking = deferred.context.messages[1].content.find((b) => b.type === "thinking");
    assert.equal(thinking.thinking, "");
    assert.equal(thinking.deferred, true);
    // around responses stay slice-bounded: no context-usage tail parsing.
    assert.equal(deferred.contextUsage, undefined);
    const tail = await readSessionHistory(deferredCtx.file, { limit: 3 });
    assert.deepEqual(tail.context.entryIds, deferred.context.entryIds, "same slice as the equivalent tail window");
  } finally {
    cleanup(deferredCtx);
  }
});

test("rewritten journal: stale anchors are 409-class for around/outline, tail keeps re-deriving", async () => {
  const entries = linearTurns(4);
  const ctx = journal(entries);
  try {
    const anchor = await readJournalAnchor(ctx.file);
    const outlineBefore = await readSessionOutline(ctx.file, { anchor });
    assert.equal(outlineBefore.entries.length, 8);

    // Rewrite a middle body in place with different byte length: the old
    // anchor no longer describes the file.
    const changed = entries.map((e) => e.id === "a1" ? assistant("a1", "u1", "rewritten much longer answer text", 4) : e);
    writeFileSync(ctx.file, [JSON.stringify(header()), ...changed.map((e) => JSON.stringify(e))].join("\n") + "\n");

    await assertTargetUnavailable(readSessionHistory(ctx.file, { around: "a1", limit: 6, anchor }), "stale_anchor");
    await assertTargetUnavailable(readSessionOutline(ctx.file, { anchor }), "stale_anchor");

    // Existing tail/before/after contract unchanged: stale anchor re-derives.
    const tail = await readSessionHistory(ctx.file, { limit: 100, anchor });
    assert.equal(tail.context.messages.length, 8);
    assert.equal(textOf(tail.context.messages[3]), "rewritten much longer answer text");
    assert.notDeepEqual(tail.page.anchor, anchor);

    // A fresh outline reflects the rewrite (spine rebuilt, previews updated).
    const fresh = await readSessionOutline(ctx.file);
    assert.equal(fresh.entries.find((e) => e.entryId === "a1").preview, "rewritten much longer answer text");

    // Removing the target entirely: structured not_found, never a tail page.
    const shorter = entries.filter((e) => e.id !== "u3" && e.id !== "a3");
    writeFileSync(ctx.file, [JSON.stringify(header()), ...shorter.map((e) => JSON.stringify(e))].join("\n") + "\n");
    await assertTargetUnavailable(readSessionHistory(ctx.file, { around: "a3", limit: 6 }), "not_found");
    const freshOutline = await readSessionOutline(ctx.file);
    assert.ok(!freshOutline.entries.some((e) => e.entryId === "a3"));
  } finally {
    cleanup(ctx);
  }
});

test("missing file: outline empty without anchor, structured failures with anchor or around", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp104-missing-"));
  const file = join(dir, "absent.jsonl");
  try {
    const outline = await readSessionOutline(file);
    assert.deepEqual(outline.entries, []);
    assert.equal(outline.leafId, null);
    assert.equal(outline.anchor.entryCount, 0);
    // A fresh all-zero boundary (transient live session, nothing flushed) is
    // a valid EMPTY snapshot: empty outline echoing the anchor, not stale.
    const zeroAnchor = { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 };
    const empty = await readSessionOutline(file, { anchor: zeroAnchor });
    assert.deepEqual(empty, { anchor: zeroAnchor, leafId: null, entries: [] });
    const anchor = { lastEntryId: "x", leafId: "x", entryCount: 1, sizeBytes: 10, mtimeMs: 1 };
    await assertTargetUnavailable(readSessionOutline(file, { anchor }), "stale_anchor");
    await assertTargetUnavailable(readSessionHistory(file, { around: "x", limit: 6 }), "not_found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("around compaction summary and tool-only assistant targets are included with parity content", async () => {
  const entries = [
    user("u1", null, "old", 1),
    assistant("a1", "u1", "old answer", 2),
    user("u2", "a1", "kept", 3),
    { type: "compaction", id: "cmp", parentId: "u2", timestamp: TS(4), summary: "summary text", firstKeptEntryId: "u2", tokensBefore: 7 },
    toolOnlyAssistant("a2", "cmp", 5, [{ type: "toolCall", toolCallId: "c1", toolName: "bash", input: {} }]),
    user("u3", "a2", "after tools", 6),
    assistant("a3", "u3", "done", 7),
  ];
  const ctx = journal(entries);
  try {
    // Display: u2, cmp, a2, u3, a3 (u1/a1 compacted away).
    const aroundSummary = await readSessionHistory(ctx.file, { around: "cmp", limit: 3 });
    assert.deepEqual(aroundSummary.context.entryIds, ["u2", "cmp", "a2"]);
    assert.equal(aroundSummary.context.messages[1].customType, "compaction");
    assert.equal(aroundSummary.context.messages[1].content, "summary text");

    const aroundToolOnly = await readSessionHistory(ctx.file, { around: "a2", limit: 3 });
    assert.deepEqual(aroundToolOnly.context.entryIds, ["cmp", "a2", "u3"]);
    const outline = await readSessionOutline(ctx.file);
    assert.deepEqual(outline.entries.map((e) => e.entryId), ["u2", "cmp", "a2", "u3", "a3"]);
    assert.equal(outline.entries[2].preview, "bash");
    assert.equal(outline.entries[2].ordinal, 2);
  } finally {
    cleanup(ctx);
  }
});

// ---------------------------------------------------------------------------
// #104 legacy journals: outline + around over migrated ids
// ---------------------------------------------------------------------------

test("legacy v1 journal: outline ordinals match migrated ids; around includes targets with structured failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp104-legacy-"));
  const file = join(dir, "session.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 1, id: "legacy-104", timestamp: TS(0), cwd: "/tmp/project" })];
  for (let i = 0; i < 12; i++) {
    lines.push(JSON.stringify({ type: "message", timestamp: TS(i * 2 + 1), message: { role: "user", content: `request ${i}` } }));
    lines.push(JSON.stringify({
      type: "message", timestamp: TS(i * 2 + 2),
      message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: `answer ${i}` }] },
    }));
  }
  writeFileSync(file, lines.join("\n") + "\n");
  try {
    const all = await readSessionHistory(file, { limit: 100 });
    const ids = all.context.entryIds;
    assert.equal(ids.length, 24);

    const outline = await readSessionOutline(file);
    assert.equal(outline.entries.length, 24);
    assert.deepEqual(outline.entries.map((e) => e.entryId), ids);
    assert.deepEqual(outline.entries.map((e) => e.ordinal), ids.map((_, i) => i));
    assert.equal(outline.entries[0].preview, "request 0");
    assert.equal(outline.entries[23].preview, "answer 11");
    assert.deepEqual(outline.anchor, all.page.anchor);

    const middle = await readSessionHistory(file, { around: ids[12], limit: 20 });
    assert.deepEqual(middle.context.entryIds, ids.slice(3, 23));
    assert.ok(middle.context.entryIds.includes(ids[12]));
    assert.equal(middle.page.hasEarlier, true);
    assert.equal(middle.page.hasLater, true);
    assert.equal(middle.page.tailEntryId, ids[23]);

    const first = await readSessionHistory(file, { around: ids[0], limit: 20 });
    assert.deepEqual(first.context.entryIds, ids.slice(0, 20));
    assert.equal(first.page.hasEarlier, false);
    const last = await readSessionHistory(file, { around: ids[23], limit: 20 });
    assert.deepEqual(last.context.entryIds, ids.slice(4, 24));
    assert.equal(last.page.hasLater, false);

    await assertTargetUnavailable(readSessionHistory(file, { around: "not-a-migrated-id", limit: 20 }), "not_found");
    await assertTargetUnavailable(readSessionHistory(file, { around: ids[5], limit: 20, leafId: null }), "not_visible");

    const staleAnchor = { lastEntryId: ids[23], leafId: ids[23], entryCount: 999, sizeBytes: all.page.anchor.sizeBytes, mtimeMs: all.page.anchor.mtimeMs };
    await assertTargetUnavailable(readSessionHistory(file, { around: ids[5], limit: 20, anchor: staleAnchor }), "stale_anchor");
    await assertTargetUnavailable(readSessionOutline(file, { anchor: staleAnchor }), "stale_anchor");

    // Existing legacy tail/before contracts keep working alongside.
    const tail = await readSessionHistory(file, { limit: 5 });
    assert.deepEqual(tail.context.entryIds, ids.slice(19));
    assert.equal(tail.page.hasLater, false);
    assert.equal(tail.page.tailEntryId, ids[23]);
    const earlier = await readSessionHistory(file, { before: tail.page.headEntryId, limit: 20 });
    assert.deepEqual(earlier.context.entryIds, ids.slice(0, 19));
    assert.equal(earlier.page.hasLater, true);
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #104 review fixes: malformed targets, idless-v1 snapshots, empty anchors
// ---------------------------------------------------------------------------

test("malformed around targets fail structured, not 500; valid conversion stays includable", async () => {
  const ctx = journal([
    user("u1", null, "go", 1),
    // assistant with string content + deferThinking: entryToUiMessage calls
    // content.map on a string and throws — as an around TARGET this must be
    // structured unavailable, never a 500.
    assistant("bad", "u1", "", 2, { content: "not an array" }),
    user("u2", "bad", "next", 3),
  ]);
  try {
    await assertTargetUnavailable(
      readSessionHistory(ctx.file, { around: "bad", limit: 5, deferThinking: true }),
      "not_found",
    );
    // Without deferThinking the same entry converts fine and is includable.
    const plain = await readSessionHistory(ctx.file, { around: "bad", limit: 5 });
    assert.deepEqual(plain.context.entryIds, ["u1", "bad", "u2"]);
  } finally {
    cleanup(ctx);
  }

  // Legacy path: the TARGET's own conversion failure is structured not_found
  // (target-only pre-check; unrelated entries keep prior behavior).
  const dir = mkdtempSync(join(tmpdir(), "omp104-legacy-bad-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 1, id: "legacy-bad", timestamp: TS(0), cwd: "/tmp/project" }),
    JSON.stringify({ type: "message", timestamp: TS(1), message: { role: "user", content: "go" } }),
    JSON.stringify({
      type: "message", timestamp: TS(2),
      message: { role: "assistant", provider: "test", model: "test-model", content: "not an array" },
    }),
  ].join("\n") + "\n");
  try {
    const all = await readSessionHistory(file, { limit: 100 });
    const targetId = all.context.entryIds[1];
    assert.ok(targetId, "legacy migration assigns an id to the malformed assistant");
    await assertTargetUnavailable(
      readSessionHistory(file, { around: targetId, limit: 5, deferThinking: true }),
      "not_found",
    );
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idless v1 snapshot: anchored outline/around keep migrated ids across appends and exclude later entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp104-idless-"));
  const file = join(dir, "session.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 1, id: "idless-sess", timestamp: TS(0), cwd: "/tmp/project" })];
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({ type: "message", timestamp: TS(i * 2 + 1), message: { role: "user", content: `request ${i}` } }));
    lines.push(JSON.stringify({
      type: "message", timestamp: TS(i * 2 + 2),
      message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: `answer ${i}` }] },
    }));
  }
  writeFileSync(file, lines.join("\n") + "\n");
  try {
    const outline = await readSessionOutline(file);
    assert.equal(outline.entries.length, 12);
    const anchor = outline.anchor;
    assert.equal(anchor.lastEntryId, null, "idless spine has no record ids");
    assert.equal(anchor.entryCount, 0);
    assert.ok(anchor.sizeBytes > 0);
    const target = outline.entries[5].entryId; // answer 2

    // Grow the file AFTER the snapshot: the anchored prefix view must be
    // retained (same migrated ids), never re-migrated with fresh random ids.
    appendFileSync(file, [
      JSON.stringify({ type: "message", timestamp: TS(50), message: { role: "user", content: "later request" } }),
      JSON.stringify({ type: "message", timestamp: TS(51), message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "later answer" }] } }),
    ].join("\n") + "\n");
    // Distinct mtime so the append cannot be mistaken for a same-size rewrite
    // on coarse-granularity filesystems.
    const appendTime = new Date(Date.UTC(2026, 0, 1, 0, 2, 0));
    utimesSync(file, appendTime, appendTime);

    const anchoredOutline = await readSessionOutline(file, { anchor });
    assert.deepEqual(anchoredOutline.entries.map((e) => e.entryId), outline.entries.map((e) => e.entryId));
    assert.deepEqual(anchoredOutline.anchor, anchor);

    const around = await readSessionHistory(file, { around: target, limit: 6, anchor });
    assert.ok(around.context.entryIds.includes(target), "original migrated target still reachable");
    assert.equal(around.context.entryIds.length, 6);
    assert.deepEqual(around.context.entryIds, outline.entries.slice(3, 9).map((e) => e.entryId));
    assert.equal(around.page.tailEntryId, outline.entries[11].entryId, "tail bounded by the snapshot");
    assert.equal(around.page.hasLater, true);
    for (const entry of around.context.messages) {
      assert.ok(!textOf(entry).startsWith("later"), "post-anchor appends excluded");
    }

    // Unanchored reads see the grown transcript (fresh migration, new ids).
    const grown = await readSessionOutline(file);
    assert.equal(grown.entries.length, 14);
    assert.equal(grown.entries[13].preview, "later answer");

    // Same-size in-place rewrite in the MIDDLE of the snapshot prefix (outside
    // any bounded probe window): the size-unchanged + mtime-changed rebuild
    // wipes the views and records their extents as invalidated, so anchored
    // navigation fails stale fail-closed even if the rewrite shares the
    // snapshot's mtime millisecond. Unanchored reads re-migrate.
    const raw = readFileSync(file, "utf8");
    const rewritten = raw.replace("answer 2", "answr 2X"); // same byte length, inside prefix
    assert.equal(rewritten.length, raw.length);
    writeFileSync(file, rewritten);
    await assertTargetUnavailable(readSessionOutline(file, { anchor }), "stale_anchor");
    await assertTargetUnavailable(readSessionHistory(file, { around: target, limit: 6, anchor }), "stale_anchor");
    const freshOutline = await readSessionOutline(file);
    assert.equal(freshOutline.entries.length, 14);
    assert.equal(freshOutline.entries[5].preview, "answr 2X");
    const tail = await readSessionHistory(file, { limit: 5 });
    assert.equal(tail.context.messages.length, 5);
    assert.equal(textOf(tail.context.messages[4]), "later answer");
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("header-only empty anchor bounds legacy reads after appends (no snapshot leak)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp104-empty-anchor-"));
  const file = join(dir, "session.jsonl");
  const headerLine = JSON.stringify({ type: "session", version: 2, id: "empty-sess", timestamp: TS(0), cwd: "/tmp/project" });
  writeFileSync(file, headerLine + "\n");
  try {
    const empty = await readSessionOutline(file);
    assert.deepEqual(empty.entries, []);
    const anchor = empty.anchor;
    assert.equal(anchor.entryCount, 0);
    assert.equal(anchor.lastEntryId, null);
    assert.equal(anchor.sizeBytes, headerLine.length + 1);

    appendFileSync(file, [
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: TS(1), message: { role: "user", content: "post snapshot" } }),
    ].join("\n") + "\n");

    // The empty snapshot must stay empty even though the file grew.
    const stillEmpty = await readSessionOutline(file, { anchor });
    assert.deepEqual(stillEmpty.entries, []);
    assert.deepEqual(stillEmpty.anchor, anchor);
    await assertTargetUnavailable(readSessionHistory(file, { around: "anything", limit: 5, anchor }), "not_found");
    const window = await readSessionHistory(file, { limit: 5, anchor });
    assert.deepEqual(window.context.entryIds, []);
    assert.equal(window.page.tailEntryId, null);

    // Unanchored reads see the appended entry.
    const fresh = await readSessionOutline(file);
    assert.equal(fresh.entries.length, 1);
    assert.equal(fresh.entries[0].preview, "post snapshot");

    // Same-size rewrite of the header (inside the empty snapshot's extent):
    // the boundary probe no longer matches, so the snapshot fails stale.
    const raw = readFileSync(file, "utf8");
    const rewritten = raw.replace("empty-sess", "empty-sesX"); // same byte length
    assert.equal(rewritten.length, raw.length);
    writeFileSync(file, rewritten);
    await assertTargetUnavailable(readSessionOutline(file, { anchor }), "stale_anchor");
    await assertTargetUnavailable(readSessionHistory(file, { around: "anything", limit: 5, anchor }), "stale_anchor");
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evicted legacy prefix snapshot fails stale, never a false not_found from re-migrated ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp104-evict-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 1, id: "evict-sess", timestamp: TS(0), cwd: "/tmp/project" }),
    JSON.stringify({ type: "message", timestamp: TS(1), message: { role: "user", content: "request 0" } }),
    JSON.stringify({ type: "message", timestamp: TS(2), message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "answer 0" }] } }),
  ].join("\n") + "\n");
  try {
    const outline = await readSessionOutline(file);
    const anchor = outline.anchor;
    const target = outline.entries[1].entryId;
    // Four more extents fill the per-journal view LRU (cap 4) and evict the
    // snapshot's prefix view; re-migration would assign fresh random ids.
    for (let i = 1; i <= 4; i++) {
      appendFileSync(file, JSON.stringify({ type: "message", timestamp: TS(i + 2), message: { role: "user", content: `request ${i}` } }) + "\n");
      // Distinct mtimes per append so the test never depends on filesystem
      // timestamp granularity (same-ms appends would look like rewrites).
      const t = new Date(Date.UTC(2026, 0, 1, 0, 1, i));
      utimesSync(file, t, t);
      await readSessionOutline(file);
    }
    // The stale decision happens BEFORE migration, so neither read can heal
    // the cache with a re-migrated (wrong-id) view of the evicted extent.
    await assertTargetUnavailable(readSessionOutline(file, { anchor }), "stale_anchor");
    await assertTargetUnavailable(readSessionHistory(file, { around: target, limit: 5, anchor }), "stale_anchor");
    // Without an anchor a genuinely unknown id is still not_found.
    await assertTargetUnavailable(readSessionHistory(file, { around: target, limit: 5 }), "not_found");
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});
