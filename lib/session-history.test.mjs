import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  readSessionHistory,
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

function journal(entries, { title } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omp99-history-"));
  const file = join(dir, "session.jsonl");
  const lines = [];
  if (title !== undefined) {
    const slot = JSON.stringify({ type: "title", v: 1, title, updatedAt: TS(0), pad: "" });
    lines.push(slot + " ".repeat(Math.max(0, 255 - slot.length)));
  }
  lines.push(JSON.stringify(header()));
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
