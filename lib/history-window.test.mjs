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
  deltaContinuesWindow,
  mergeDurableWindow,
  applyRefreshedWindow,
  refreshMayInstall,
  agentEndContinues,
  upsertCompletedMessage,
  messageContentKey,
  createRefreshCoalescer,
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

test("append detection: journal growth is an append candidate even when the leaf advanced", () => {
  const base = anchor();
  assert.ok(anchorIsAppend(base, anchor({ lastEntryId: "e9", leafId: "leaf-b", entryCount: 9, sizeBytes: 900, mtimeMs: 2000 })));
  // Captured #124 boundaries: leafId advances on every append (1→15→26).
  const step1 = anchor({ lastEntryId: "356e28af", leafId: "356e28af", entryCount: 1, sizeBytes: 100 });
  const step2 = anchor({ lastEntryId: "ec15163b", leafId: "ec15163b", entryCount: 15, sizeBytes: 1500, mtimeMs: 2000 });
  const step3 = anchor({ lastEntryId: "c6ed7226", leafId: "c6ed7226", entryCount: 26, sizeBytes: 2600, mtimeMs: 3000 });
  assert.ok(anchorIsAppend(step1, step2));
  assert.ok(anchorIsAppend(step2, step3));
  // Shrink (rewrite/compaction), identical anchors and cold journals replace.
  assert.equal(anchorIsAppend(base, anchor({ entryCount: 3, sizeBytes: 900 })), false);
  assert.equal(anchorIsAppend(base, anchor({ entryCount: 9, sizeBytes: 300 })), false);
  assert.equal(anchorIsAppend(base, anchor()), false);
  assert.equal(anchorIsAppend(anchor({ lastEntryId: null, entryCount: 0, sizeBytes: 0 }), anchor()), false);
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

test("refresh decision: cold start and shrink replace; grown journal is a delta candidate", () => {
  assert.equal(decideWindowRefresh(null, 0, page()), "replace");
  assert.equal(decideWindowRefresh(anchor(), 0, page()), "replace");
  assert.equal(decideWindowRefresh(anchor(), 2, undefined), "replace");
  // Shrink (rewrite/compaction) is a replacement.
  assert.equal(decideWindowRefresh(anchor(), 2, page({ anchor: anchor({ entryCount: 1, sizeBytes: 100 }) })), "replace");
  // A leaf change with growth is only a CANDIDATE — the delta walk validates
  // branch continuity (deltaContinuesWindow) before anything is appended.
  assert.equal(decideWindowRefresh(anchor(), 2, page({ anchor: anchor({ leafId: "leaf-b", entryCount: 9, sizeBytes: 900 }) })), "delta");
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

test("refresh merge drops promoted live entries and local command bubbles", () => {
  const streamed = assistantMessage("done");
  const localCommand = { role: "custom", customType: "command", content: "ls output", display: true, timestamp: 3 };
  const stillLive = assistantMessage("in flight");
  const prev = [userMessage("q"), streamed, localCommand, stillLive];
  const windowMessages = [userMessage("q"), assistantMessage("done")];
  const result = applyRefreshedWindow(prev, ["e1"], windowMessages, ["e1", "e2"]);
  assert.deepEqual(result.messages, [...windowMessages, stillLive]);
  assert.deepEqual(result.entryIds, ["e1", "e2"]);
});

test("completed-message upsert replaces a journal-window duplicate in place", () => {
  const journaled = assistantMessage("answer");
  const windowMessages = [userMessage("q"), journaled];
  // The live message_end carries the same content but a different object
  // (wire messageId is process-scoped, never the journal entry id).
  const live = { ...assistantMessage("answer"), messageId: "wire-123" };
  const result = upsertCompletedMessage(windowMessages, 2, live);
  assert.equal(result.length, 2);
  assert.equal(result[1], live);
  // Idempotent: applying the same event again neither appends nor replaces.
  assert.equal(upsertCompletedMessage(result, 2, live), result);
});

test("completed-message upsert appends genuinely new messages", () => {
  const windowMessages = [userMessage("q"), assistantMessage("older answer")];
  const fresh = assistantMessage("new answer");
  const result = upsertCompletedMessage(windowMessages, 2, fresh);
  assert.equal(result.length, 3);
  assert.equal(result[2], fresh);
});

test("upsert searches the WHOLE durable window, not only the last five entries", () => {
  const repeated = assistantMessage("ok");
  const windowMessages = [
    userMessage("q1"), repeated,
    userMessage("q2"), assistantMessage("b"), userMessage("q3"),
    assistantMessage("c"), assistantMessage("d"), assistantMessage("e"), assistantMessage("f"),
  ];
  const live = assistantMessage("ok");
  const result = upsertCompletedMessage(windowMessages, windowMessages.length, live);
  // The raced durable copy sits far outside the old 5-message tail bound:
  // replace it in place — never append a duplicate after the final answer.
  assert.equal(result.length, windowMessages.length);
  assert.equal(result[1], live);
});

test("upsert never replaces a LIVE copy: an identical older live message stays distinct", () => {
  const liveOld = assistantMessage("ok");
  const messages = [userMessage("q"), liveOld];
  const fresh = assistantMessage("ok");
  const result = upsertCompletedMessage(messages, 1, fresh);
  assert.equal(result.length, 3);
  assert.equal(result[1], liveOld);
  assert.equal(result[2], fresh);
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
  const result = upsertCompletedMessage(windowMessages, 2, second);
  assert.equal(result.length, 3);
  assert.equal(result[1], first);
  assert.equal(result[2], second);
});

test("repeated OK after an intervening user message appends, never replaces", () => {
  const first = { ...assistantMessage("OK"), timestamp: 100 };
  const second = { ...assistantMessage("OK"), timestamp: 200 };
  const windowMessages = [userMessage("q1"), first, userMessage("q2")];
  const result = upsertCompletedMessage(windowMessages, 3, second);
  assert.equal(result.length, 4);
  assert.equal(result[1], first);
  assert.equal(result[2], windowMessages[2]);
  assert.equal(result[3], second);
});

test("two equal live copies with a one-copy durable window reconcile to exactly one copy", () => {
  const live = assistantMessage("repeat");
  const stillLive = assistantMessage("in flight");
  const prev = [userMessage("q"), { ...live }, { ...live }, stillLive];
  const windowMessages = [userMessage("q"), assistantMessage("repeat")];
  const result = applyRefreshedWindow(prev, ["e1"], windowMessages, ["e1", "e2"]);
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[2], prev[2]);
  assert.equal(result.messages[3], stillLive);
});

// --- #124 regressions: live append classification, journal-order merge,
// latest-wins installs, willContinue decision, delta continuity. ---

const toolCallMsg = (id, name, timestamp) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: {} }],
  timestamp,
});
const toolResultMsg = (id, timestamp) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: `${id} out` }], isError: false, timestamp });

test("#124 (a) captured live append with advancing leafId decides delta, never replace", () => {
  const step1 = anchor({ lastEntryId: "356e28af", leafId: "356e28af", entryCount: 1, sizeBytes: 120, mtimeMs: 1000 });
  const step2 = anchor({ lastEntryId: "ec15163b", leafId: "ec15163b", entryCount: 15, sizeBytes: 1800, mtimeMs: 2000 });
  const step3 = anchor({ lastEntryId: "c6ed7226", leafId: "c6ed7226", entryCount: 26, sizeBytes: 3100, mtimeMs: 3000 });
  assert.equal(decideWindowRefresh(step1, 1, page({ anchor: step2 })), "delta");
  assert.equal(decideWindowRefresh(step2, 5, page({ anchor: step3 })), "delta");
});

test("#124 (b) completion refresh yields exactly journal order, final LAST, no duplicates", () => {
  const user1 = userMessage("prompt 1");
  const custom = { role: "custom", customType: "notice", content: "note", timestamp: 2 };
  const alphaCall = toolCallMsg("a", "alpha", 10);
  const alphaResult = toolResultMsg("a", 11);
  const betaCall = toolCallMsg("b", "beta", 12);
  const betaResult = toolResultMsg("b", 13);
  const gammaCall = toolCallMsg("g", "gamma", 14);
  const gammaResult = toolResultMsg("g", 15);
  const final1 = assistantMessage("final answer");
  const journalOrder = [user1, custom, alphaCall, alphaResult, betaCall, betaResult, gammaCall, gammaResult, final1];
  const journalIds = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"];
  // Captured state: 5 PRE-TURN durable entries plus the whole streamed turn
  // live: [user1, custom, alphaCall, alphaResult, betaCall, betaResult,
  // gammaCall, gammaResult, final1].
  const preTurn = Array.from({ length: 5 }, (_, i) => assistantMessage(`history ${i}`));
  const preTurnIds = ["h1", "h2", "h3", "h4", "h5"];
  const prevMessages = [...preTurn, ...journalOrder];
  // Fresh tail=5 page (journal order): the whole turn is now durable.
  const tailMessages = journalOrder.slice(4);
  const tailIds = journalIds.slice(4);
  // Delta path: base = pre-turn + first 4 turn entries; walk delivers the tail.
  const baseMessages = [...preTurn, ...journalOrder.slice(0, 4)];
  const baseIds = [...preTurnIds, ...journalIds.slice(0, 4)];
  const merged = mergeDurableWindow(baseMessages, baseIds, tailMessages, tailIds);
  const viaDelta = applyRefreshedWindow(prevMessages, baseIds, merged.messages, merged.entryIds);
  assert.deepEqual(viaDelta.messages, [...preTurn, ...journalOrder], "journal order, final LAST");
  assert.deepEqual(viaDelta.entryIds, [...preTurnIds, ...journalIds]);
  assert.equal(viaDelta.messages[viaDelta.messages.length - 1], final1);
  // Replace path (the captured misclassification): install the tail=5 window
  // over the same state. The installed window is exactly the fetched tail;
  // the live prefix [user1…gammaResult] is now covered by the journal even
  // though the bounded tail no longer shows it — the chronological suffix cut
  // drops it; NOTHING lands after final1.
  const replaced = applyRefreshedWindow(prevMessages, preTurnIds, tailMessages, tailIds);
  assert.deepEqual(replaced.messages, tailMessages);
  assert.equal(replaced.messages[replaced.messages.length - 1], final1);
  assert.deepEqual(replaced.entryIds, tailIds);
  // Cold window (new session, nothing durable yet): same result.
  const cold = applyRefreshedWindow(journalOrder, [], tailMessages, tailIds);
  assert.deepEqual(cold.messages, tailMessages, "no stale live prefix after the final");
  // Idempotent: re-applying the same refresh changes nothing.
  const again = applyRefreshedWindow(replaced.messages, replaced.entryIds, tailMessages, tailIds);
  assert.deepEqual(again.messages, replaced.messages);
  assert.deepEqual(again.entryIds, replaced.entryIds);
  // Reproduce the captured corruption with the OLD semantics: leafId equality
  // forced REPLACE, which installed the tail=5 window and then appended
  // messagesRef.slice(base.messages.length) reconciled ONLY against that
  // 5-entry page — the stale slice [user1, custom, alphaCall, alphaResult]
  // landed AFTER final1 (the final moved from the tail to index 4).
  const promoted = new Map();
  for (const message of tailMessages) {
    const key = messageContentKey(message);
    promoted.set(key, (promoted.get(key) ?? 0) + 1);
  }
  const oldKept = journalOrder.slice(0).filter((message) => {
    const key = messageContentKey(message);
    const count = promoted.get(key) ?? 0;
    if (count > 0) {
      promoted.set(key, count - 1);
      return false;
    }
    return true;
  });
  const oldResult = [...tailMessages, ...oldKept];
  assert.deepEqual(oldResult, [betaCall, betaResult, gammaCall, gammaResult, final1, user1, custom, alphaCall, alphaResult]);
  assert.notDeepEqual(replaced.messages, oldResult, "new merge differs from the buggy splice");
});

test("#124 (c) a stale refresh response applied after a newer one leaves state unchanged", () => {
  const older = anchor({ lastEntryId: "e7", leafId: "l7", entryCount: 7, sizeBytes: 700, mtimeMs: 2000 });
  const newer = anchor({ lastEntryId: "e9", leafId: "l9", entryCount: 9, sizeBytes: 900, mtimeMs: 3000 });
  // Newer response (seq 5) installed first; the older (seq 4) arrives late.
  assert.equal(refreshMayInstall(newer, older, 4, 5), false);
  // Older ANCHOR after a newer install is discarded even without a seq gap.
  assert.equal(refreshMayInstall(newer, older, 6, 5), false);
  // Same-anchor retries and genuine growth may install.
  assert.equal(refreshMayInstall(newer, newer, 6, 5), true);
  assert.equal(refreshMayInstall(newer, anchor({ lastEntryId: "e12", entryCount: 12, sizeBytes: 1200 }), 6, 5), true);
  assert.equal(refreshMayInstall(null, older, 1, 0), true);
  assert.equal(refreshMayInstall(newer, null, 6, 5), false);
  // And when the guard rejects, the hook installs nothing — state identity holds.
  const installed = { messages: [assistantMessage("final")], entryIds: ["e9"] };
  const next = refreshMayInstall(newer, older, 4, 5)
    ? applyRefreshedWindow(installed.messages, ["e9"], [assistantMessage("stale")], ["e7"])
    : installed;
  assert.equal(next, installed);
});

test("#124 (d) a live message not yet durable stays after all durable ones", () => {
  const durableA = assistantMessage("durable answer");
  const liveFinal = assistantMessage("still streaming in");
  const prev = [userMessage("q"), durableA, liveFinal];
  const windowMessages = [userMessage("q"), durableA, assistantMessage("newly durable")];
  const result = applyRefreshedWindow(prev, ["e1", "e2"], windowMessages, ["e1", "e2", "e3"]);
  assert.deepEqual(result.messages, [...windowMessages, liveFinal]);
  assert.equal(result.messages[result.messages.length - 1], liveFinal);
  assert.deepEqual(result.entryIds, ["e1", "e2", "e3"]);
});

test("#124 willContinue:true agent_end is a continuation; terminal events are not", () => {
  assert.equal(agentEndContinues({ type: "agent_end", willContinue: true }), true);
  assert.equal(agentEndContinues({ type: "agent_end", willContinue: false }), false);
  assert.equal(agentEndContinues({ type: "agent_end" }), false);
  assert.equal(agentEndContinues({ type: "agent_end", willContinue: "true" }), false);
});

test("#124 delta continuity: one-entry overlap required, silent tail fallback rejected", () => {
  const m = (text) => assistantMessage(text);
  // Genuine continuation with the requested overlap: batch starts at the old tail.
  assert.ok(deltaContinuesWindow([m("x"), m("y")], ["e5", "e6"], "e5"));
  assert.ok(deltaContinuesWindow([m("x")], ["e5"], "e5"));
  // No previous tail (single-entry window): nothing to validate.
  assert.ok(deltaContinuesWindow([m("x")], ["e6"], null));
  assert.ok(deltaContinuesWindow([], [], null));
  // Silent tail fallback / branch switch / compaction elision: the batch does
  // NOT start with the old tail id — replace, never append.
  assert.equal(deltaContinuesWindow([m("x"), m("y")], ["e6", "e7"], "e5"), false);
  assert.equal(deltaContinuesWindow([m("x"), m("y")], ["b1", "b2"], "e5"), false);
  assert.equal(deltaContinuesWindow([], [], "e5"), false);
  // Malformed (ids not parallel) never appends.
  assert.equal(deltaContinuesWindow([m("x")], [], "e5"), false);
});

test("#124 repeated prompt: an already-durable identical entry never retires the fresh live bubble", () => {
  // messageContentKey ignores user timestamps: the earlier "继续" is durable
  // AND sits inside the freshly installed window; the freshly sent one is
  // live. Only NEWLY durable entries may retire live copies, so the repeat
  // survives after the installed window (a key-anywhere filter would delete
  // it — the exact failure the repeat-steer tests guard).
  const oldUser = userMessage("继续");
  const oldAnswer = assistantMessage("好的");
  const freshUser = userMessage("继续");
  const newAnswer = assistantMessage("新的回答");
  const prev = [oldUser, oldAnswer, freshUser];
  const windowMessages = [oldUser, oldAnswer, newAnswer];
  const result = applyRefreshedWindow(prev, ["e1", "e2"], windowMessages, ["e1", "e2", "e3"]);
  assert.deepEqual(result.messages, [oldUser, oldAnswer, newAnswer, freshUser]);
  assert.equal(result.messages[3], freshUser);
});

// Behavioral tests for the per-session single-flight coalescer factory the
// hook instantiates — controllable deferred runs, no React, no source text.
function deferredRunner() {
  const calls = [];
  const deferreds = [];
  const run = (sid) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push(sid);
    deferreds.push({ resolve, reject });
    return promise;
  };
  return { calls, deferreds, run };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("#124 coalescer: N triggers during flight collapse into exactly ONE trailing run", async () => {
  const { calls, deferreds, run } = deferredRunner();
  const coalescer = createRefreshCoalescer(run);
  const first = coalescer.request("s1");
  void coalescer.request("s1");
  void coalescer.request("s1");
  void coalescer.request("s1");
  assert.deepEqual(calls, ["s1"], "one run in flight");
  deferreds.shift().resolve(true);
  await tick();
  assert.deepEqual(calls, ["s1", "s1"], "exactly ONE trailing run for all coalesced triggers");
  deferreds.shift().resolve(true);
  await first;
  await tick();
  assert.equal(calls.length, 2, "no spurious trailing run without pending triggers");
  // A later trigger starts a fresh flight.
  const later = coalescer.request("s1");
  assert.equal(calls.length, 3);
  deferreds.shift().resolve(true);
  await later;
});

test("#124 coalescer: a rejected run still releases the flight and runs the trailing trigger", async () => {
  const { calls, deferreds, run } = deferredRunner();
  const coalescer = createRefreshCoalescer(run);
  const first = coalescer.request("s1");
  void coalescer.request("s1");
  assert.equal(calls.length, 1);
  deferreds.shift().reject(new Error("network partition"));
  await tick();
  assert.deepEqual(calls, ["s1", "s1"], "trailing run happens after a failure");
  deferreds.shift().resolve(true);
  await first;
  // Flight released: a new trigger runs immediately.
  const next = coalescer.request("s1");
  assert.equal(calls.length, 3);
  deferreds.shift().resolve(true);
  await next;
});

test("#124 coalescer: no trailing run when no trigger arrived during flight", async () => {
  const { calls, deferreds, run } = deferredRunner();
  const coalescer = createRefreshCoalescer(run);
  const only = coalescer.request("s1");
  deferreds.shift().resolve(true);
  await only;
  await tick();
  assert.deepEqual(calls, ["s1"]);
});

test("#124 coalescer: sessions are independent — B runs while A is in flight", async () => {
  const { calls, deferreds, run } = deferredRunner();
  const coalescer = createRefreshCoalescer(run);
  const flightA = coalescer.request("A");
  const flightB = coalescer.request("B");
  assert.deepEqual(calls, ["A", "B"], "B's trigger is never lost behind A's flight");
  // A trigger for B while B is in flight coalesces per session, not globally.
  void coalescer.request("B");
  assert.equal(calls.length, 2);
  deferreds[0].resolve(true); // A settles
  await flightA;
  await tick();
  assert.equal(calls.length, 2, "A settling does not start B's trailing run early");
  deferreds[1].resolve(true); // B settles → B's trailing run
  await tick();
  assert.deepEqual(calls, ["A", "B", "B"]);
  deferreds[2].resolve(true);
  await flightB;
  await tick();
  assert.equal(calls.length, 3);
});
