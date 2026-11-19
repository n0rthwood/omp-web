import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const subject = await import("./history-window.ts");
const { LOCAL_MACHINE_ID, setCurrentMachineId } = await import("./api-path.ts");

const {
  INITIAL_HISTORY_WINDOW,
  EARLIER_PAGE_SIZE,
  historyCacheKey,
  readHistoryCache,
  writeHistoryCache,
  clearHistoryCache,
  sameAnchor,
  anchorIsAppend,
  decideWindowRefresh,
  mergeDurableWindow,
  reconcileLiveSuffix,
  upsertCompletedMessage,
  messageContentKey,
} = subject;

function createStorage() {
  const data = new Map();
  return {
    failWrites: false,
    get length() {
      return data.size;
    },
    key(index) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (this.failWrites) throw new Error("QuotaExceededError");
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    keys() {
      return [...data.keys()];
    },
  };
}

const anchor = (overrides = {}) => ({
  lastEntryId: "e5",
  leafId: "leaf-a",
  entryCount: 5,
  sizeBytes: 500,
  mtimeMs: 1000,
  ...overrides,
});

const page = (overrides = {}) => ({
  anchor: anchor(),
  hasEarlier: true,
  headEntryId: "e1",
  ...overrides,
});

const userMessage = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistantMessage = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "p",
  model: "m",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 2,
});

const snapshot = (overrides = {}) => ({
  messages: [userMessage("hello"), assistantMessage("world")],
  entryIds: ["e1", "e2"],
  anchor: anchor({ lastEntryId: "e2", entryCount: 2 }),
  hasEarlier: false,
  headEntryId: "e1",
  leafId: "leaf-a",
  ...overrides,
});

let storage;
beforeEach(() => {
  storage = createStorage();
  setCurrentMachineId(LOCAL_MACHINE_ID);
});
afterEach(() => {
  setCurrentMachineId(LOCAL_MACHINE_ID);
});

test("owner window sizes: initial 5, earlier page 20", () => {
  assert.equal(INITIAL_HISTORY_WINDOW, 5);
  assert.equal(EARLIER_PAGE_SIZE, 20);
});

test("cache round-trips a window and survives a simulated page reload", () => {
  const snap = snapshot();
  writeHistoryCache(storage, "alice", "s1", snap);
  // A fresh read (no in-memory state) returns the same durable window.
  const restored = readHistoryCache(storage, "alice", "s1");
  assert.deepEqual(restored, snap);
});

test("cache is scoped per user, session and machine", () => {
  writeHistoryCache(storage, "alice", "s1", snapshot());
  assert.equal(readHistoryCache(storage, "bob", "s1"), null);
  assert.equal(readHistoryCache(storage, "alice", "s2"), null);
  assert.equal(readHistoryCache(storage, null, "s1"), null);
  setCurrentMachineId("remote-1");
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
  writeHistoryCache(storage, "alice", "s1", snapshot({ headEntryId: "remote-head" }));
  assert.equal(readHistoryCache(storage, "alice", "s1").headEntryId, "remote-head");
  setCurrentMachineId(LOCAL_MACHINE_ID);
  assert.equal(readHistoryCache(storage, "alice", "s1").headEntryId, "e1");
});

test("cache keys encode the user scope so separators cannot collide", () => {
  const a = historyCacheKey("a:b", "s1");
  const b = historyCacheKey("a", "b:s1");
  assert.notEqual(a, b);
});

test("corrupt, version-mismatched and malformed records are ignored", () => {
  const key = historyCacheKey("alice", "s1");
  storage.setItem(key, "{not json");
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
  storage.setItem(key, JSON.stringify({ ...snapshot(), v: 999, updatedAt: 1 }));
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
  storage.setItem(key, JSON.stringify({ ...snapshot(), v: 1, updatedAt: 1, entryIds: ["only-one"] }));
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
  storage.setItem(key, JSON.stringify({ ...snapshot(), v: 1, updatedAt: 1, anchor: { lastEntryId: 5 } }));
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
});

test("oversized windows are not cached; an existing record is dropped", () => {
  writeHistoryCache(storage, "alice", "s1", snapshot());
  const huge = snapshot({
    messages: [userMessage("x".repeat(1_100_000))],
    entryIds: ["e1"],
  });
  writeHistoryCache(storage, "alice", "s1", huge);
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
});

test("total cache budget evicts the oldest records first", () => {
  const filler = "y".repeat(900_000);
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    for (let index = 0; index < 10; index += 1) {
      clock += 1000;
      writeHistoryCache(storage, "alice", `s${index}`, snapshot({
        messages: [userMessage(filler)],
        entryIds: ["e1"],
      }));
    }
  } finally {
    Date.now = realNow;
  }
  // Oldest evicted, newest retained, total under the 8MB budget.
  assert.equal(readHistoryCache(storage, "alice", "s0"), null);
  assert.ok(readHistoryCache(storage, "alice", "s9"));
  let total = 0;
  for (const key of storage.keys()) total += storage.getItem(key).length;
  assert.ok(total <= 8_000_000, `total ${total} must stay bounded`);
});

test("quota failures never throw and leave no half-written record", () => {
  storage.failWrites = true;
  writeHistoryCache(storage, "alice", "s1", snapshot());
  storage.failWrites = false;
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
});

test("empty windows clear their cache record", () => {
  writeHistoryCache(storage, "alice", "s1", snapshot());
  writeHistoryCache(storage, "alice", "s1", snapshot({ messages: [], entryIds: [] }));
  assert.equal(readHistoryCache(storage, "alice", "s1"), null);
  clearHistoryCache(storage, "alice", "s1");
});

test("anchor identity compares every version field", () => {
  assert.ok(sameAnchor(anchor(), anchor()));
  for (const field of ["lastEntryId", "leafId", "entryCount", "sizeBytes", "mtimeMs"]) {
    assert.equal(sameAnchor(anchor(), anchor({ [field]: field === "entryCount" || field === "sizeBytes" || field === "mtimeMs" ? 9999 : "different" })), false, field);
  }
  assert.equal(sameAnchor(null, anchor()), false);
});

test("append detection requires same leaf and non-shrinking journal", () => {
  const base = anchor();
  assert.ok(anchorIsAppend(base, anchor({ lastEntryId: "e9", entryCount: 9, sizeBytes: 900, mtimeMs: 2000 })));
  assert.equal(anchorIsAppend(base, anchor({ leafId: "leaf-b", entryCount: 9, sizeBytes: 900 })), false);
  assert.equal(anchorIsAppend(base, anchor({ entryCount: 3, sizeBytes: 900 })), false);
  assert.equal(anchorIsAppend(base, anchor({ entryCount: 9, sizeBytes: 300 })), false);
});

test("refresh decision: unchanged anchor reuses cached pages", () => {
  assert.equal(decideWindowRefresh(anchor(), 2, page({ anchor: anchor() })), "reuse");
});

test("refresh decision: advanced journal yields delta, never reuse (anchor-echo trap)", () => {
  const cached = anchor({ lastEntryId: "e2", entryCount: 2, sizeBytes: 200, mtimeMs: 1000 });
  // A background refresh passes NO anchor; the server returns a FRESH page
  // anchor. Even though the tail route echoes passed anchors, the decision
  // must compare against the window's own anchor and detect the append.
  const fresh = page({ anchor: anchor({ lastEntryId: "e7", entryCount: 7, sizeBytes: 700, mtimeMs: 2000 }) });
  assert.equal(decideWindowRefresh(cached, 2, fresh), "delta");
});

test("refresh decision: cold start, rewrite and branch switch replace", () => {
  assert.equal(decideWindowRefresh(null, 0, page()), "replace");
  assert.equal(decideWindowRefresh(anchor(), 0, page()), "replace");
  assert.equal(decideWindowRefresh(anchor(), 2, undefined), "replace");
  // Shrink (rewrite/compaction) and leaf change are replacements.
  assert.equal(decideWindowRefresh(anchor(), 2, page({ anchor: anchor({ entryCount: 1, sizeBytes: 100 }) })), "replace");
  assert.equal(decideWindowRefresh(anchor(), 2, page({ anchor: anchor({ leafId: "leaf-b", entryCount: 9, sizeBytes: 900 }) })), "replace");
});

test("delta merge appends only unseen entries (idempotent)", () => {
  const prev = { messages: [userMessage("a")], entryIds: ["e1"] };
  const delta = { messages: [userMessage("a"), userMessage("b")], entryIds: ["e1", "e2"] };
  const merged = mergeDurableWindow(prev.messages, prev.entryIds, delta.messages, delta.entryIds);
  assert.deepEqual(merged.entryIds, ["e1", "e2"]);
  assert.equal(merged.messages.length, 2);
  // Applying the same delta again changes nothing.
  const again = mergeDurableWindow(merged.messages, merged.entryIds, delta.messages, delta.entryIds);
  assert.deepEqual(again, merged);
});

test("live suffix reconciliation drops promoted entries and local command bubbles", () => {
  const streamed = assistantMessage("done");
  const localCommand = { role: "custom", customType: "command", content: "ls output", display: true, timestamp: 3 };
  const stillLive = assistantMessage("in flight");
  const suffix = [streamed, localCommand, stillLive];
  const delta = [assistantMessage("done")]; // same content, fresh wire identity
  const kept = reconcileLiveSuffix(suffix, delta);
  assert.deepEqual(kept, [stillLive]);
});

test("completed-message upsert replaces a journal-window duplicate in place", () => {
  const journaled = assistantMessage("answer");
  const windowMessages = [userMessage("q"), journaled];
  // The live message_end carries the same content but a different object
  // (wire messageId is process-scoped, never the journal entry id).
  const live = { ...assistantMessage("answer"), messageId: "wire-123" };
  const result = upsertCompletedMessage(windowMessages, live);
  assert.equal(result.length, 2);
  assert.equal(result[1], live);
  // Idempotent: applying the same event again neither appends nor replaces.
  assert.equal(upsertCompletedMessage(result, live), result);
});

test("completed-message upsert appends genuinely new messages", () => {
  const windowMessages = [userMessage("q"), assistantMessage("older answer")];
  const fresh = assistantMessage("new answer");
  const result = upsertCompletedMessage(windowMessages, fresh);
  assert.equal(result.length, 3);
  assert.equal(result[2], fresh);
});

test("upsert does not resurrect identical older messages beyond the window tail", () => {
  const repeated = assistantMessage("ok");
  const windowMessages = [
    userMessage("q1"), repeated,
    userMessage("q2"), assistantMessage("b"), userMessage("q3"),
    assistantMessage("c"), assistantMessage("d"), assistantMessage("e"), assistantMessage("f"),
  ];
  const live = assistantMessage("ok");
  const result = upsertCompletedMessage(windowMessages, live);
  // The identical entry sits far outside the 5-message tail: append, and the
  // older occurrence survives untouched.
  assert.equal(result.length, windowMessages.length + 1);
  assert.equal(result[1], repeated);
});

test("content identity ignores deferred thinking bodies and wire ids", () => {
  const full = assistantMessage("answer");
  full.content.unshift({ type: "thinking", thinking: "long private reasoning" });
  const deferred = assistantMessage("answer");
  deferred.content.unshift({ type: "thinking", thinking: "[thinking deferred]" });
  assert.equal(messageContentKey(full), messageContentKey(deferred));
  assert.equal(messageContentKey({ ...deferred, messageId: "wire-1" }), messageContentKey({ ...deferred, messageId: "wire-2" }));
  assert.notEqual(messageContentKey(assistantMessage("a")), messageContentKey(assistantMessage("b")));
});

test("tool results reconcile by toolCallId, user messages by content", () => {
  const toolA = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "full output" }], isError: false };
  const toolADeferred = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "[deferred]" }], isError: false };
  assert.equal(messageContentKey(toolA), messageContentKey(toolADeferred));
  assert.notEqual(messageContentKey(toolA), messageContentKey({ ...toolA, toolCallId: "t2" }));
  assert.equal(messageContentKey(userMessage("hi")), messageContentKey(userMessage("hi")));
  assert.notEqual(messageContentKey(userMessage("hi")), messageContentKey(userMessage("bye")));
});
test("identical OK replies with different timestamps are distinct entries, not collapses", () => {
  const first = { ...assistantMessage("OK"), timestamp: 100 };
  const windowMessages = [userMessage("q"), first];
  const second = { ...assistantMessage("OK"), timestamp: 200 };
  const result = upsertCompletedMessage(windowMessages, second);
  assert.equal(result.length, 3);
  assert.equal(result[1], first);
  assert.equal(result[2], second);
});

test("repeated OK after an intervening user message appends, never replaces", () => {
  const first = { ...assistantMessage("OK"), timestamp: 100 };
  const second = { ...assistantMessage("OK"), timestamp: 200 };
  const windowMessages = [userMessage("q1"), first, userMessage("q2")];
  const result = upsertCompletedMessage(windowMessages, second);
  assert.equal(result.length, 4);
  assert.equal(result[1], first);
  assert.equal(result[2], windowMessages[2]);
  assert.equal(result[3], second);
});

test("two equal live copies with a one-copy delta reconcile to exactly one copy", () => {
  const live = assistantMessage("repeat");
  const stillLive = assistantMessage("in flight");
  const suffix = [{ ...live }, { ...live }, stillLive];
  const delta = [assistantMessage("repeat")];
  const kept = reconcileLiveSuffix(suffix, delta);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], suffix[1]);
  assert.equal(kept[1], stillLive);
});
