// Guards the role-tagged journal reader (issue #116) and pins the SDK defect
// it compensates for: SessionManager's listing reads a 4 KB head window, so a
// journal whose real messages start past it reports zero messages and
// "(no messages)". Every web journal looks like that because plan mode injects
// a ~7 KB plan-mode-context record at the head.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readJournalMessageStats, readJournalMessageStatsCached } = await jiti.import("./journal-stats.ts");
const { readSessionInfo } = await jiti.import("@oh-my-pi/pi-coding-agent");

const dir = mkdtempSync(join(tmpdir(), "omp-journal-stats-"));

function resetStatsCache() {
  globalThis.__ompJournalStatsCache = undefined;
}

/** A journal shaped like a real web session: padded title slot, header, the
 *  plan-mode context record, then the actual messages past the 4 KB window. */
function writeJournal(name, messages) {
  const path = join(dir, name);
  const lines = [
    JSON.stringify({
      type: "title",
      v: 1,
      title: "",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pad: " ".repeat(110),
    }),
    JSON.stringify({
      type: "session",
      version: 3,
      id: name.replace(/\.jsonl$/, ""),
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: dir,
    }),
    JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", model: "p/m" }),
    JSON.stringify({ type: "thinking_level_change", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:00.000Z", thinkingLevel: null, configured: null }),
    JSON.stringify({ type: "custom_message", customType: "plan-mode-context", content: "x".repeat(7000) }),
    ...messages.map((message, index) => JSON.stringify({
      type: "message",
      id: `e${index + 1}`,
      parentId: index === 0 ? null : `e${index}`,
      timestamp: "2026-01-01T00:00:01.000Z",
      message,
    })),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("counts message records by role and finds the first user text past the 4 KB window", async () => {
  resetStatsCache();
  const path = writeJournal("roles.jsonl", [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "hi" }] },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
  ]);

  const stats = await readJournalMessageStats(path);
  assert.deepEqual(stats, {
    messageCount: 3,
    userMessages: 1,
    assistantMessages: 1,
    toolResultMessages: 1,
    firstUserMessage: "hello",
  });
});

test("the SDK listing is wrong on the same journal, which is what the reader compensates for", async () => {
  const path = writeJournal("sdk-window.jsonl", [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "hi" }] },
  ]);

  const sdk = await readSessionInfo(path);
  assert.ok(sdk, "SDK reads the header");
  assert.equal(sdk.messageCount, 0, "SDK's 4 KB window misses every message");
  assert.equal(sdk.firstMessage, "(no messages)");

  const stats = await readJournalMessageStats(path);
  assert.equal(stats.messageCount, 2);
  assert.equal(stats.firstUserMessage, "hello");
});

test("a journal with no user message reports zero users and empty first text", async () => {
  resetStatsCache();
  const path = writeJournal("no-user.jsonl", [
    { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "unsolicited" }] },
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }] },
  ]);

  const stats = await readJournalMessageStats(path);
  assert.equal(stats.userMessages, 0);
  assert.equal(stats.firstUserMessage, "");
  assert.equal(stats.messageCount, 2);
});

test("an image-only user message yields the [image] placeholder, not an empty first message", async () => {
  resetStatsCache();
  const path = writeJournal("image-only.jsonl", [
    { role: "user", content: [{ type: "text", text: "" }, { type: "image", data: "blob:sha256:abc", mimeType: "image/png" }] },
    { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "nice picture" }] },
  ]);

  const stats = await readJournalMessageStats(path);
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.firstUserMessage, "[image]");
});

test("cached reads repeat the same numbers and re-scan when the file grows", async () => {
  resetStatsCache();
  const path = writeJournal("cache.jsonl", [
    { role: "user", content: [{ type: "text", text: "first" }] },
  ]);

  const first = await readJournalMessageStatsCached(path);
  assert.equal(first.messageCount, 1);
  assert.deepEqual(await readJournalMessageStatsCached(path), first, "unchanged identity repeats the same stats");

  // A grown file changes (mtime, size), so the memo must not answer for it.
  writeJournal("cache.jsonl", [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "second" }] },
  ]);
  const rescanned = await readJournalMessageStatsCached(path);
  assert.equal(rescanned.messageCount, 2);
  assert.equal(rescanned.assistantMessages, 1);

  // A vanished journal has no identity to memoize against: callers keep their
  // previous source's numbers rather than reading a stale entry for a session
  // that no longer exists.
  rmSync(path);
  assert.equal(await readJournalMessageStatsCached(path), undefined);
});

test("a partial trailing line is never counted", async () => {
  resetStatsCache();
  const path = writeJournal("partial.jsonl", [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
  // No terminating newline: an in-flight append.
  writeFileSync(path, '{"type":"message","id":"e2","parentId":"e1","message":{"role":"user","content":[{"type":"text","text":"half', { flag: "a" });

  const stats = await readJournalMessageStats(path);
  assert.equal(stats.messageCount, 1);
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.firstUserMessage, "hello");
});