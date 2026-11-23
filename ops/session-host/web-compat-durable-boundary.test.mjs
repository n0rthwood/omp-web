// #124 durable-boundary regression: the SDK queues message_end persistence
// BEFORE emitting the frame, so a boundary captured with flushSync alone can
// cover a message_end whose journal entry does not exist yet. The host must
// await settleInFlightMessagePersistence before the synchronous snapshot.
//   D1 get_history_anchor issued after message_end is on the wire WAITS for
//      deferred persistence; the anchor includes the entry.
//   D2 journal-mode attach ack waits too; a live frame emitted during the
//      wait is post-boundary (seq > boundary.seq) and still delivered.
//   D3 the settle loop re-settles when new persistence lands mid-wait, and a
//      rejecting settle still captures (allSettled semantics).
// Individually runnable: bun test ops/session-host/web-compat-durable-boundary.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";

const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;
const leaseBase = mkdtempSync(join(tmpdir(), "omp124-lease-"));
const savedOwnersDir = process.env.PI_TEST_SESSION_OWNERS_DIR;
process.env.PI_TEST_SESSION_OWNERS_DIR = join(leaseBase, "owners");

// Redirect the agent dir BEFORE importing the SDK: SessionManager.create()
// must never journal into the real ~/.omp store.
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
setAgentDir(join(leaseBase, "agent"));

const { createSessionTransport } = await import("./transport.ts");
const { createWebCompat } = await import("./web-compat.ts");
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");

after(() => {
  if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
  else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
  if (savedOwnersDir === undefined) delete process.env.PI_TEST_SESSION_OWNERS_DIR;
  else process.env.PI_TEST_SESSION_OWNERS_DIR = savedOwnersDir;
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else setAgentDir(savedAgentDir);
  rmSync(leaseBase, { recursive: true, force: true });
});

async function until(pred, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Real SessionManager + real transport + real web-compat; only the SDK
 *  session's persistence settlement is stubbed (deferred promise the test
 *  resolves after appending the entry — exactly the queued-microtask race). */
async function makeHost(t, { settle }) {
  const runDir = mkdtempSync(join(tmpdir(), "omp124-run-"));
  process.env.OMP_WEB_HOST_RUN_DIR = runDir;
  const sm = await SessionManager.create(runDir);
  await sm.ensureOnDisk();
  const settings = {
    revision: 0,
    valueCache: [],
    warnState: { invalid: new Map(), items: new Map() },
    rawValue: () => undefined,
  };
  const session = {
    agent: { state: { messages: [] } },
    extensionRunner: { getRegisteredCommands: () => [] },
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    getTodoPhases: () => [],
    getPlanModeState: () => undefined,
    sessionId: sm.getSessionId(),
    sessionFile: sm.getSessionFile(),
    sessionManager: sm,
    settings,
    modelRegistry: { getAvailable: () => [] },
    settleInFlightMessagePersistence: settle,
  };
  let transport;
  transport = await createSessionTransport({
    sessionId: `durable-${randomUUID()}`,
    helloSessionId: sm.getSessionId(),
    sessionFile: sm.getSessionFile(),
    cwd: runDir,
    onFrame: (frame) => compat.handleInboundFrame(frame),
    onOutboundFrame: (frame) => compat.handleOutboundFrame(frame),
    onJournalAttach: () => compat.captureHistoryBoundary(),
  });
  const compat = createWebCompat({
    session,
    sessionManager: sm,
    settings,
    cwd: runDir,
    transport,
    eventBus: { on: () => () => {} },
    getDecoration: () => undefined,
    onShutdown: () => {},
  });
  t.after(async () => {
    compat.dispose();
    await transport.close();
    await sm.close();
    rmSync(runDir, { recursive: true, force: true });
  });
  const frames = [];
  const collector = await Bun.connect({
    unix: transport.socketPath,
    socket: {
      open(s) { s.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq: -1, historyMode: "journal" })}\n`); },
      data(_s, chunk) {
        collector.pending += Buffer.from(chunk).toString("utf8");
        let nl = collector.pending.indexOf("\n");
        while (nl !== -1) {
          const line = collector.pending.slice(0, nl);
          collector.pending = collector.pending.slice(nl + 1);
          if (line.length > 0) frames.push(JSON.parse(line));
          nl = collector.pending.indexOf("\n");
        }
      },
      drain() {}, close() {}, error() {}, end() {},
    },
  });
  collector.pending = "";
  t.after(() => collector.end());
  return { sm, transport, compat, frames };
}

function anchorResponses(frames, id) {
  return frames.filter((f) => f.type === "response" && f.command === "get_history_anchor" && f.id === id);
}

test("D1: get_history_anchor after message_end waits for deferred persistence; anchor includes the entry", { timeout: 20000 }, async (t) => {
  const deferred = Promise.withResolvers();
  let settleCalls = 0;
  const { sm, transport, compat, frames } = await makeHost(t, {
    settle: () => { settleCalls++; return deferred.promise; },
  });
  // Baseline durable history.
  sm.appendCustomEntry("probe", { text: "baseline" });
  const baselineCount = sm.getEntries().length;

  // message_end is ON THE WIRE while its persistence is still queued.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] }, messageId: "m-final" })}\n`);
  const frameSeq = transport.currentSeq();

  compat.handleInboundFrame({ type: "get_history_anchor", id: "a1" });
  await until(() => settleCalls >= 1, "settleInFlightMessagePersistence called");
  await Bun.sleep(30);
  assert.equal(anchorResponses(frames, "a1").length, 0, "response must WAIT for in-flight persistence, not flushSync past it");

  // Deferred persistence lands: the entry is appended, then the promise resolves.
  const entryId = sm.appendCustomEntry("probe", { text: "final answer" });
  deferred.resolve();
  await until(() => anchorResponses(frames, "a1").length === 1, "durable anchor response");
  const response = anchorResponses(frames, "a1")[0];
  assert.equal(response.success, true);
  assert.equal(response.data.journal.entryCount, baselineCount + 1, "anchor counts the persisted message_end entry");
  assert.equal(response.data.journal.lastEntryId, entryId, "anchor tail is the persisted entry");
  assert.ok(response.data.seq >= frameSeq, "boundary seq covers the message_end frame");
});

test("D2: journal-mode attach ack waits for persistence; live frames during the wait stay post-boundary", { timeout: 20000 }, async (t) => {
  const deferred = Promise.withResolvers();
  const { sm, transport, frames } = await makeHost(t, { settle: () => deferred.promise });
  sm.appendCustomEntry("probe", { text: "baseline" });
  // The collector attached in makeHost; its ack must not arrive before settlement.
  await Bun.sleep(30);
  assert.equal(frames.filter((f) => f.type === "host_attach").length, 0, "attach ack waits for in-flight persistence");

  // A live frame emitted DURING the settle wait: it must be delivered and be
  // post-boundary (the boundary snapshots seq AFTER settlement).
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  const entryId = sm.appendCustomEntry("probe", { text: "persisted at attach" });
  deferred.resolve();
  await until(() => frames.some((f) => f.type === "host_attach"), "durable attach ack");
  const ack = frames.find((f) => f.type === "host_attach");
  assert.ok(ack.boundary, "ack carries the durable boundary");
  assert.equal(ack.boundary.journal.lastEntryId, entryId);
  assert.ok(ack.seq >= ack.boundary.seq, "ack ring position never behind the boundary");
  const live = frames.find((f) => f.type === "agent_start");
  assert.ok(live, "live frame during the wait is still delivered");
});

test("D3: settle loop re-settles new mid-wait persistence; a rejecting settle still captures", { timeout: 20000 }, async (t) => {
  // Pass 1: persistence still landing (wire advances during the wait) → the
  // loop must settle AGAIN; pass 2 is quiet.
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let pass = 0;
  const { sm, transport, compat, frames } = await makeHost(t, {
    settle: () => {
      pass++;
      return pass === 1 ? first.promise : second.promise;
    },
  });
  sm.appendCustomEntry("probe", { text: "baseline" });
  compat.handleInboundFrame({ type: "get_history_anchor", id: "a1" });
  await until(() => pass >= 1, "first settle pass");
  // New message_end + persistence land while pass 1 is in flight.
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [] }, messageId: "m-1" })}\n`);
  const id1 = sm.appendCustomEntry("probe", { text: "one" });
  first.resolve();
  await until(() => pass >= 2, "second settle pass after wire advanced");
  assert.equal(anchorResponses(frames, "a1").length, 0, "no capture while the wire kept advancing");
  const id2 = sm.appendCustomEntry("probe", { text: "two" });
  second.resolve();
  await until(() => anchorResponses(frames, "a1").length === 1, "converged durable anchor");
  const data = anchorResponses(frames, "a1")[0].data;
  assert.equal(data.journal.lastEntryId, id2, "anchor covers the mid-wait entry too");
  assert.ok(id1 !== id2);

  // Rejecting settle (should not happen — allSettled internally): capture anyway.
  const { sm: sm2, compat: compat2, frames: frames2 } = await makeHost(t, {
    settle: () => Promise.reject(new Error("persistence exploded")),
  });
  const idX = sm2.appendCustomEntry("probe", { text: "durable despite rejection" });
  compat2.handleInboundFrame({ type: "get_history_anchor", id: "a2" });
  await until(() => anchorResponses(frames2, "a2").length === 1, "anchor despite rejecting settle");
  const response = anchorResponses(frames2, "a2")[0];
  assert.equal(response.success, true);
  assert.equal(response.data.journal.lastEntryId, idX);
});
