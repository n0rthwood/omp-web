// Permanent behavioral regression for issue #98 (transport delivery layer):
// - command responses round-trip < 1 s while a stalled client is flooded with
//   transient progress frames (droppable lane; SDK spool unreachable because
//   the adapter always accepts);
// - ring eviction stays sequence-aligned: > 32 MiB of chunked traffic replays
//   through the REAL SDK RpcFrameDecoder with zero sequence errors;
// - mid-sequence orphan resume skips the torn sequence cleanly;
// - the 64 MiB must-deliver detach guard survives and the host stays alive.
// Individually runnable: bun test ops/session-host/transport-flood.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RpcFrameEncoder, RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { classifyOutboundLine } from "./transport.ts";

const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;
let keyCounter = 0;

async function makeTransport(t, onFrame = () => {}) {
  const runDir = mkdtempSync(join(tmpdir(), "omp-flood-"));
  process.env.OMP_WEB_HOST_RUN_DIR = runDir;
  const { createSessionTransport } = await import("./transport.ts");
  const key = `flood-${Date.now()}-${++keyCounter}`;
  const transport = await createSessionTransport({
    sessionId: key, helloSessionId: `real-${key}`, sessionFile: "", cwd: runDir,
    onFrame,
  });
  t.after(async () => {
    await transport.close();
    if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
    else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
    rmSync(runDir, { recursive: true, force: true });
  });
  return transport;
}

/** Real UDS client that line-splits inbound bytes; optional per-line hook. */
async function openCollector(transport, { lastSeenSeq = 0, onLine, storeLines = true } = {}) {
  const state = { socket: null, lines: [], ack: null, closed: false, pending: "" };
  state.socket = await Bun.connect({
    unix: transport.socketPath,
    socket: {
      open(s) { s.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq })}\n`); },
      data(_s, chunk) {
        state.pending += Buffer.from(chunk).toString("utf8");
        let nl = state.pending.indexOf("\n");
        while (nl !== -1) {
          const line = state.pending.slice(0, nl);
          state.pending = state.pending.slice(nl + 1);
          if (line.length > 0) {
            if (storeLines) state.lines.push(line);
            if (line.startsWith('{"type":"host_attach"')) state.ack = JSON.parse(line);
            onLine?.(line);
          }
          nl = state.pending.indexOf("\n");
        }
      },
      drain() {},
      close() { state.closed = true; },
      error() { state.closed = true; },
      end() { state.closed = true; },
    },
  });
  return state;
}

async function until(pred, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Feed replayed/live lines through the real SDK decoder; collect errors. */
function decodeLines(lines) {
  const dec = new RpcFrameDecoder();
  const decoded = [];
  const errors = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch (e) { errors.push(`parse: ${e.message}`); continue; }
    if (obj.type === "host_hello" || obj.type === "host_attach") continue;
    try {
      const out = dec.push(obj);
      if (out !== undefined && obj.type === "rpc_chunk") decoded.push(out);
    } catch (e) { errors.push(e.message); }
  }
  return { decoded, errors };
}

/** One chunked logical frame (> 1 MiB ⇒ protocol-v2 rpc_chunk lines). */
function bigFrame() {
  return { type: "message_update", payload: "x".repeat(Math.floor(1.4 * 1024 * 1024)) };
}

/** Write one logical frame line-by-line; return cumulative byte ends per line. */
function writeFrame(transport, enc, frame) {
  const ends = [];
  let total = 0;
  for (const line of enc.encodeFrames(frame)) {
    assert.equal(transport.stdoutAdapter.write(line), true, "adapter must always accept (#98)");
    total += Buffer.byteLength(line, "utf8");
    ends.push(total);
  }
  return ends;
}

test("classifyOutboundLine: shared type/seqStart/chunkId/bulk convention (#98)", () => {
  for (const type of ["subagent_progress", "tool_execution_update", "tool_stream_update"]) {
    const c = classifyOutboundLine(`{"type":"${type}","payload":{}}`);
    assert.deepEqual(c, { type, seqStart: true, chunkId: undefined, bulk: true });
  }
  const resp = classifyOutboundLine('{"id":"web-1","type":"response","command":"get_state","success":true}');
  assert.deepEqual(resp, { type: "response", seqStart: true, chunkId: undefined, bulk: false });
  const first = classifyOutboundLine('{"type":"rpc_chunk","chunkId":"rpc-9","index":0,"count":6,"byteLength":1400000,"data":"AA"}');
  assert.deepEqual(first, { type: "rpc_chunk", seqStart: true, chunkId: "rpc-9", bulk: false });
  const mid = classifyOutboundLine('{"type":"rpc_chunk","chunkId":"rpc-9","index":12,"count":20,"byteLength":1400000,"data":"AA"}');
  assert.deepEqual(mid, { type: "rpc_chunk", seqStart: false, chunkId: "rpc-9", bulk: false });
  // Field order varies; index 10 must not read as index 0.
  const ten = classifyOutboundLine('{"type":"rpc_chunk","index":10,"chunkId":"c"}');
  assert.equal(ten.seqStart, false);
  const reordered = classifyOutboundLine('{"type":"rpc_chunk","index":0,"chunkId":"abc"}');
  assert.equal(reordered.seqStart, true);
  assert.equal(reordered.chunkId, "abc");
  // Unknown/absent types are must-deliver (conservative default).
  assert.equal(classifyOutboundLine('{"type":"message_update"}').bulk, false);
  assert.deepEqual(classifyOutboundLine("not json"), { type: undefined, seqStart: true, chunkId: undefined, bulk: false });
});

test("responses round-trip < 1 s under a 200k-frame progress flood to a stalled client (#98)", async (t) => {
  const transport = await makeTransport(t);
  const respAt = new Map();
  let bulkReceived = 0;
  let markerSeen = false;
  const respCounts = new Map();
  const a = await openCollector(transport, {
    storeLines: false,
    onLine(line) {
      if (line.includes('"subagent_progress"')) bulkReceived++;
      else if (line.includes('"flood-resp-')) {
        const id = /"id":"(flood-resp-\d)"/.exec(line)?.[1];
        if (id) {
          respCounts.set(id, (respCounts.get(id) ?? 0) + 1);
          if (!respAt.has(id)) respAt.set(id, performance.now());
        }
      } else if (line.includes('"session_settled"')) markerSeen = true;
    },
  });
  await until(() => a.ack !== null, "client A attach ack");
  a.socket.pause(); // stall: stop reading entirely

  const bulkLine = `${JSON.stringify({ type: "subagent_progress", payload: { subagentId: "E2eRound2", text: "x".repeat(60) } })}\n`;
  let allAccepted = true;
  let cbCount = 0;
  const flood = (n) => {
    for (let i = 0; i < n; i++) {
      allAccepted &&= transport.stdoutAdapter.write(bulkLine, () => { cbCount++; });
    }
  };
  flood(100_000); // paused client: bulk lane must shed, never detach
  const t0 = performance.now();
  transport.stdoutAdapter.write('{"id":"flood-resp-1","type":"response","command":"get_state","success":true,"data":{}}\n');
  transport.stdoutAdapter.write('{"id":"flood-resp-2","type":"response","command":"set_subagent_subscription","success":true,"data":{}}\n');
  a.socket.resume();
  // Keep flooding WHILE the responses travel — the acceptance criterion is
  // latency under continued streaming, not after the flood ends.
  for (let batch = 0; batch < 10; batch++) {
    flood(10_000);
    await Bun.sleep(0);
  }
  transport.stdoutAdapter.write('{"type":"session_settled"}\n');
  await until(() => respAt.has("flood-resp-1") && respAt.has("flood-resp-2") && markerSeen, "mid-flood responses");

  assert.equal(allAccepted, true, "adapter must never signal backpressure (SDK spool unreachable)");
  assert.equal(cbCount, 200_000, "exactly one settled callback per bulk write");
  assert.equal(respCounts.get("flood-resp-1"), 1, "response 1 delivered exactly once");
  assert.equal(respCounts.get("flood-resp-2"), 1, "response 2 delivered exactly once");
  const latency1 = respAt.get("flood-resp-1") - t0;
  const latency2 = respAt.get("flood-resp-2") - t0;
  assert.ok(latency1 < 1000, `get_state latency ${latency1.toFixed(1)} ms must be < 1 s`);
  assert.ok(latency2 < 1000, `set_subagent_subscription latency ${latency2.toFixed(1)} ms must be < 1 s`);
  assert.equal(a.closed, false, "bulk flood must never detach the client (64 MiB guard is must-deliver only)");
  assert.ok(bulkReceived > 0 && bulkReceived < 200_000, `droppable lane must shed bulk (received ${bulkReceived})`);

  // The ring keeps EVERY shed byte: a fresh full replay sees all 200k frames.
  let replayBulk = 0;
  let replayResp = 0;
  const b = await openCollector(transport, {
    storeLines: false,
    onLine(line) {
      if (line.includes('"subagent_progress"')) replayBulk++;
      else if (line.includes('"flood-resp-')) replayResp++;
    },
  });
  await until(() => b.ack !== null && replayBulk === 200_000, "full ring replay delivery", 30000);
  assert.equal(replayBulk, 200_000, "ring replay must retain all dropped bulk frames (< 32 MiB total)");
  assert.equal(replayResp, 2, "both responses retained in ring");
  assert.deepEqual(Object.keys(b.ack).sort(), ["seq", "type"], "host_attach wire shape unchanged");
  a.socket.end();
  b.socket.end();
});

test("a paused second client cannot steal the first client's drain or sequence position (#98)", async (t) => {
  let transport;
  transport = await makeTransport(t, (frame) => {
    transport.stdoutAdapter.write(`${JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true })}\n`);
  });
  const responses = new Set();
  const fast = await openCollector(transport, {
    storeLines: false,
    onLine(line) {
      const frame = JSON.parse(line);
      if (frame.type === "response") responses.add(frame.id);
    },
  });
  await until(() => fast.ack !== null, "fast client attached");
  let checkpoint = false;
  const slow = await openCollector(transport, {
    storeLines: false,
    onLine(line) { if (JSON.parse(line).type === "host_seq") checkpoint = true; },
  });
  await until(() => slow.ack !== null, "slow client attached");
  slow.socket.pause();
  const progress = `${JSON.stringify({ type: "subagent_progress", text: "x".repeat(16 * 1024) })}\n`;
  const flood = (async () => {
    for (let burst = 0; burst < 20; burst++) {
      for (let i = 0; i < 64; i++) transport.stdoutAdapter.write(progress);
      await Bun.sleep(1);
    }
  })();
  for (const command of ["get_state", "set_subagent_subscription"]) {
    const started = performance.now();
    fast.socket.write(`${JSON.stringify({ type: command, id: command })}\n`);
    await until(() => responses.has(command), command, 2000);
    assert.ok(performance.now() - started < 1000, `${command} must round-trip during the two-client flood`);
  }
  await flood;
  slow.socket.resume();
  transport.stdoutAdapter.write('{"type":"session_settled"}\n');
  await until(() => checkpoint, "skipped-byte checkpoint");
  assert.equal(fast.closed, false);
  assert.equal(slow.closed, false);
  fast.socket.end();
  slow.socket.end();
});

test("> 32 MiB chunked traffic: full replay is sequence-aligned, zero decoder errors (#98)", async (t) => {
  const transport = await makeTransport(t);
  const enc = new RpcFrameEncoder(); enc.setProtocolVersion(2);
  const frame = bigFrame();
  // 40 × ~1.4 MiB ≈ 56 MiB > 32 MiB ring: eviction must cut at frame starts.
  for (let i = 0; i < 40; i++) writeFrame(transport, enc, frame);

  const c = await openCollector(transport, { lastSeenSeq: 0 });
  await until(() => c.ack !== null, "full-replay attach ack");
  const { decoded, errors } = decodeLines(c.lines);
  assert.deepEqual(errors, [], "replay must decode with ZERO sequence errors");
  assert.ok(decoded.length >= 1, "retained window must contain at least one whole chunked frame");
  for (const d of decoded) assert.deepEqual(d, frame, "decoded frame byte-exact");
  const firstChunk = c.lines.find((l) => l.includes('"rpc_chunk"'));
  assert.ok(firstChunk !== undefined, "chunked traffic retained");
  assert.equal(JSON.parse(firstChunk).index, 0, "replay must begin at a sequence start");
  assert.deepEqual(Object.keys(c.ack).sort(), ["seq", "type"], "host_attach wire shape unchanged");
  c.socket.end();
});

test("mid-sequence orphan resume skips the torn sequence cleanly (#98)", async (t) => {
  const transport = await makeTransport(t);
  const enc = new RpcFrameEncoder(); enc.setProtocolVersion(2);
  const frame = bigFrame();
  const ends1 = writeFrame(transport, enc, frame); // chunkId rpc-1
  const ends2 = writeFrame(transport, enc, frame); // chunkId rpc-2
  writeFrame(transport, enc, frame);               // chunkId rpc-3
  const frame2Start = ends1[ends1.length - 1];
  const tornSeq = frame2Start + ends2[1] + 5; // inside chunk line index 2 of rpc-2
  const boundarySeq = frame2Start + ends2[1]; // start of chunk line index 2

  for (const [lastSeen, label] of [[tornSeq, "torn"], [boundarySeq, "boundary"]]) {
    const c = await openCollector(transport, { lastSeenSeq: lastSeen });
    await until(() => c.ack !== null, `${label} resume attach ack`);
    assert.ok(!c.lines.some((l) => l.includes('"chunkId":"rpc-2"')), `${label}: orphan sequence must be skipped whole`);
    const { decoded, errors } = decodeLines(c.lines);
    assert.deepEqual(errors, [], `${label}: zero decoder errors`);
    assert.equal(decoded.length, 1, `${label}: only the following whole frame replays`);
    assert.deepEqual(decoded[0], frame);
    c.socket.end();
    await until(() => c.closed, `${label} client detach`);
  }

  // Exact sequence-start resume still replays both following frames (#94 accounting).
  const c = await openCollector(transport, { lastSeenSeq: frame2Start });
  await until(() => c.ack !== null, "aligned resume attach ack");
  const { decoded, errors } = decodeLines(c.lines);
  assert.deepEqual(errors, []);
  assert.equal(decoded.length, 2, "aligned resume replays both whole frames");
  c.socket.end();
});

test("64 MiB must-deliver backlog still detaches the slow client; host survives (#98)", async (t) => {
  const transport = await makeTransport(t);
  const enc = new RpcFrameEncoder(); enc.setProtocolVersion(2);
  const frame = bigFrame();
  const a = await openCollector(transport, { storeLines: false });
  await until(() => a.ack !== null, "stalled client attach ack");
  a.socket.pause();
  // ~70 MiB of rpc_chunk lines: must-deliver, never dropped ⇒ detach guard.
  for (let i = 0; i < 50; i++) writeFrame(transport, enc, frame);
  await until(() => a.closed, "must-deliver detach guard");
  // Host alive: adapter still accepts, and a fresh client replays the aligned ring.
  assert.equal(transport.stdoutAdapter.write('{"type":"session_settled"}\n'), true);
  const b = await openCollector(transport, { lastSeenSeq: 0 });
  await until(() => b.ack !== null, "post-detach attach ack");
  const { decoded, errors } = decodeLines(b.lines);
  assert.deepEqual(errors, [], "post-detach replay decodes with zero sequence errors");
  assert.ok(decoded.length >= 1, "aligned ring retains whole frames after must-deliver eviction");
  assert.ok(b.lines.some((l) => l.includes('"session_settled"')), "live frames flow after detach");
  b.socket.end();
});
