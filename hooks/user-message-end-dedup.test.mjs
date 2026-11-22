// Regression: user message_end must not duplicate the optimistic bubble when
// the assistant's message_end lands first (Bug A — duplicate user bubble
// rendered below the answer).
//
// Runs the REAL reducer body extracted from hooks/useAgentSession.ts against
// real message lists; pure helpers come from lib/history-window.ts.
// Individually runnable: bun test hooks/user-message-end-dedup.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { upsertCompletedMessage, messageContentKey } = await import("../lib/history-window.ts");

const transpiler = new Bun.Transpiler({ loader: "ts" });
const toJs = (src) => transpiler.transformSync(src);

const hookSource = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `end marker not found after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

// Real identity helpers (string vs array content normalization, image
// signatures) — extracted verbatim from the hook.
const helperSource = sliceBetween(hookSource, "function extractMessageText(", "function readCompactResult(");
const extractMessageText = new Function(`${toJs(helperSource)}\nreturn extractMessageText;`)();
const userMessageKey = new Function(`${toJs(helperSource)}\nreturn userMessageKey;`)();

// Real message_end user-branch reducer body (everything inside setMessages).
const reducerStart = "setMessages((prev) => {";
const reducerBodyStart = hookSource.indexOf(reducerStart);
assert.ok(reducerBodyStart >= 0);
const reducerBodyEnd = hookSource.indexOf("});\n        } else if (completed)", reducerBodyStart);
assert.ok(reducerBodyEnd > reducerBodyStart);
const reducerSource = hookSource.slice(reducerBodyStart + reducerStart.length, reducerBodyEnd);

// Reducer factory: binds the real upsert/messageContentKey plus per-test state.
const makeReducer = new Function(
  "upsertCompletedMessage",
  "userMessageKey",
  "messageContentKey",
  `return (prev, delivered, optimisticKey, windowSize) => {
     const deliveredKey = userMessageKey(delivered);
     const windowRef = { current: windowSize > 0 ? { entryIds: { length: windowSize } } : null };
     ${toJs(reducerSource)}
   };`,
);

function runReducer(prev, delivered, optimisticKey, windowSize = 0) {
  const reduce = makeReducer(upsertCompletedMessage, userMessageKey, messageContentKey);
  return reduce(prev, delivered, optimisticKey, windowSize);
}

const user = (text, timestamp = 100) => ({ role: "user", content: text, timestamp });
const userArray = (text, timestamp = 100) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text, timestamp = 200) => ({ role: "assistant", content: [{ type: "text", text }], timestamp, model: "m" });
const toolResult = (id, timestamp = 150) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], timestamp });

const countUserText = (messages, text) => messages.filter((m) => m.role === "user" && userMessageKey(m) === userMessageKey(user(text))).length;

test("(a) assistant message_end lands before user message_end: bubble replaced in place, exactly once, above the answer", () => {
  const optimistic = user("如何改进，你说一下思路", 100);
  const answer = assistant("思路如下……", 200);
  const prev = [optimistic, answer];
  const delivered = userArray("如何改进，你说一下思路", 101);
  const result = runReducer(prev, delivered, userMessageKey(optimistic), 0);
  assert.equal(countUserText(result, "如何改进，你说一下思路"), 1, "user bubble must appear exactly once");
  const userIdx = result.findIndex((m) => m.role === "user");
  const answerIdx = result.indexOf(answer);
  assert.ok(userIdx < answerIdx, "user bubble must stay ABOVE the answer");
  assert.equal(result[answerIdx], answer, "answer untouched");
  assert.equal(result.length, 2);
});

test("(b) >5 trailing toolResult/assistant entries: no duplicate, position preserved", () => {
  const optimistic = user("question", 100);
  const trailing = [];
  for (let i = 0; i < 7; i += 1) trailing.push(toolResult(`t${i}`, 110 + i), assistant(`step ${i}`, 120 + i));
  const prev = [optimistic, ...trailing];
  const delivered = userArray("question", 101);
  const result = runReducer(prev, delivered, userMessageKey(optimistic), 0);
  assert.equal(countUserText(result, "question"), 1, "no duplicate user bubble");
  assert.equal(result.length, prev.length, "nothing appended");
  assert.equal(userMessageKey(result[0]), userMessageKey(delivered), "optimistic bubble consumed in place at index 0");
  assert.deepEqual(result.slice(1), trailing, "trailing entries untouched, order kept");
});

test("(c) later same-text queued delivery still appends (optimistic key already consumed)", () => {
  const first = userArray("same text", 100);
  const answer = assistant("answer", 200);
  const prev = [first, answer];
  const queued = userArray("same text", 300);
  const result = runReducer(prev, queued, null, 0);
  assert.equal(countUserText(result, "same text"), 2, "genuine repeat delivery must render twice");
  assert.equal(result[result.length - 1], queued, "queued delivery appended at the end");
});

test("(c2) same-text delivery with optimistic key set but no matching bubble still appends", () => {
  const prev = [assistant("answer", 200)];
  const queued = userArray("fresh steer", 300);
  const result = runReducer(prev, queued, userMessageKey(user("other prompt")), 0);
  assert.equal(countUserText(result, "fresh steer"), 1);
  assert.equal(result[result.length - 1], queued);
});

test("(d) durable copy already installed by the splice race: replaced in place, not appended", () => {
  // The journal stores the same SDK object the wire event emits: the raced
  // durable copy carries the IDENTICAL timestamp as the delivery.
  const durableUser = userArray("durable question", 100);
  const durableAnswer = assistant("answer", 200);
  const prev = [durableUser, durableAnswer, toolResult("t1", 250)];
  const delivered = userArray("durable question", 100);
  const result = runReducer(prev, delivered, null, 2);
  assert.equal(countUserText(result, "durable question"), 1, "durable copy replaced, no append");
  assert.equal(result.length, prev.length);
  assert.equal(result[0], delivered, "durable entry replaced with the event copy in place");
});

test("(d2) durable copy outside the old 5-entry tail is still found and replaced", () => {
  const durableUser = userArray("old question", 100);
  const filler = [];
  for (let i = 0; i < 8; i += 1) filler.push(assistant(`a${i}`, 200 + i), toolResult(`t${i}`, 210 + i));
  const prev = [durableUser, ...filler];
  const delivered = userArray("old question", 100);
  const result = runReducer(prev, delivered, null, prev.length);
  assert.equal(countUserText(result, "old question"), 1);
  assert.equal(result.length, prev.length);
  assert.equal(result[0], delivered);
});

test("(c3) repeated same-text steer with an older DURABLE copy must append, old entry untouched", () => {
  // handleSteer/handleFollowUp set no optimistic key: a fresh delivery of the
  // same text carries a NEW timestamp and must render at its own position.
  const durableUser = userArray("继续", 100);
  const durableAnswer = assistant("好的", 200);
  const prev = [durableUser, durableAnswer];
  const delivered = userArray("继续", 300);
  const result = runReducer(prev, delivered, null, 2);
  assert.equal(countUserText(result, "继续"), 2, "repeat steer must render twice");
  assert.equal(result[0], durableUser, "old durable entry untouched");
  assert.equal(result[result.length - 1], delivered, "new delivery appended at the end");
});

test("(c4) timestamp-less delivery falls back to the bounded last-5 durable search", () => {
  const old = userArray("继续", 100);
  const filler = [];
  for (let i = 0; i < 8; i += 1) filler.push(assistant(`a${i}`, 200 + i), toolResult(`t${i}`, 210 + i));
  const prev = [old, ...filler];
  const delivered = { role: "user", content: [{ type: "text", text: "继续" }] };
  const result = runReducer(prev, delivered, null, prev.length);
  assert.equal(countUserText(result, "继续"), 2, "legacy delivery beyond the bound appends");
  assert.equal(result[0], old);
  assert.equal(result[result.length - 1], delivered);
});

test("image attachments: string/array normalization still matches the optimistic bubble", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } };
  const optimistic = { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 100 };
  const answer = assistant("nice", 200);
  const prev = [optimistic, answer];
  const delivered = { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 101 };
  assert.equal(userMessageKey(optimistic), userMessageKey(delivered), "keys match across timestamps");
  const result = runReducer(prev, delivered, userMessageKey(optimistic), 0);
  assert.equal(result.length, 2);
  assert.equal(userMessageKey(result[0]), userMessageKey(delivered));
  assert.equal(result[1], answer);
});
