import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcFrameEncoder, RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { createSessionTransport } from "../ops/session-host/transport.ts";

async function setup(t, onFrame) {
  const previous = process.env.OMP_WEB_HOST_RUN_DIR;
  const dir = mkdtempSync(join(tmpdir(), "omp-flood-"));
  process.env.OMP_WEB_HOST_RUN_DIR = dir;
  const transport = await createSessionTransport({
    sessionId: "flood", helloSessionId: "real-flood", sessionFile: "", cwd: dir,
    onFrame: (frame) => onFrame?.(frame, transport),
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.end();
    await transport.close();
    if (previous === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
    else process.env.OMP_WEB_HOST_RUN_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  async function connect(lastSeenSeq = 0) {
    const frames = [];
    const listeners = new Set();
    let pending = "";
    const receive = (bytes) => {
      pending += Buffer.from(bytes).toString("utf8");
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line) continue;
        const frame = JSON.parse(line); frames.push(frame);
        for (const listener of listeners) listener(frame);
      }
    };
    const waitFor = (predicate, timeout = 4000) => {
      const found = frames.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const listener = (frame) => {
          if (!predicate(frame)) return;
          clearTimeout(timer); listeners.delete(listener); resolve(frame);
        };
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`transport frame timeout; received ${frames.length} frames`));
        }, timeout);
        listeners.add(listener);
      });
    };
    const socket = await Bun.connect({
      unix: transport.socketPath,
      socket: {
        open(s) { s.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq })}\n`); },
        data(_s, bytes) { receive(bytes); },
        drain() {}, close() {}, error() {}, end() {},
      },
    });
    sockets.push(socket);
    await waitFor((frame) => frame.type === "host_attach");
    return { socket, frames, waitFor };
  }
  return { transport, connect };
}

test("progress flood cannot spool or starve commands and a slow client catches up with a sequence checkpoint", async (t) => {
  const { transport, connect } = await setup(t, (frame, host) => {
    host.stdoutAdapter.write(`${JSON.stringify({ id: frame.id, type: "response", command: frame.type, success: true })}\n`);
  });
  const fast = await connect();
  const slow = await connect();
  slow.socket.pause();
  const progress = `${JSON.stringify({ type: "subagent_progress", id: "worker", text: "x".repeat(16 * 1024) })}\n`;
  let callbacks = 0;
  const flood = (async () => {
    for (let burst = 0; burst < 20; burst++) {
      for (let i = 0; i < 64; i++) {
        assert.equal(transport.stdoutAdapter.write(progress, () => callbacks++), true, "SDK sink must always accept");
      }
      await Bun.sleep(1);
    }
  })();
  for (const command of ["get_state", "set_subagent_subscription"]) {
    const started = performance.now();
    fast.socket.write(`${JSON.stringify({ type: command, id: command })}\n`);
    await fast.waitFor((frame) => frame.type === "response" && frame.id === command);
    assert.ok(performance.now() - started < 1000, `${command} exceeded one second`);
  }
  await flood;
  assert.equal(callbacks, 20 * 64);
  const resumed = performance.now();
  slow.socket.resume();
  slow.socket.write(`${JSON.stringify({ type: "get_state", id: "slow-recovered" })}\n`);
  await slow.waitFor((frame) => frame.type === "response" && frame.id === "slow-recovered");
  assert.ok(performance.now() - resumed < 1000, "slow client must retain bounded backlog, not detach");
  assert.ok(slow.frames.some((frame) => frame.type === "host_seq"), "dropped progress must publish an authoritative ring checkpoint");
  assert.ok(slow.frames.filter((frame) => frame.type === "subagent_progress").length < callbacks, "slow client should shed volatile progress");
});

test("more than 32 MiB of separately written chunk lines replays only complete logical sequences", async (t) => {
  const { transport, connect } = await setup(t);
  const encoder = new RpcFrameEncoder(); encoder.setProtocolVersion(2);
  const payload = "y".repeat(1200 * 1024);
  let transferred = 0;
  for (let index = 0; index < 30; index++) {
    for (const line of encoder.encodeFrames({ type: "message_update", index, payload })) {
      transferred += Buffer.byteLength(line);
      transport.stdoutAdapter.write(line);
    }
  }
  assert.ok(transferred > 32 * 1024 * 1024);
  transport.stdoutAdapter.write(`${JSON.stringify({ type: "replay_done" })}\n`);
  const client = await connect(0);
  await client.waitFor((frame) => frame.type === "replay_done", 10000);
  const decoder = new RpcFrameDecoder();
  const decoded = [];
  for (const frame of client.frames) {
    if (frame.type.startsWith("host_")) continue;
    const value = decoder.push(frame); // Any cut sequence throws and fails the regression.
    if (value?.type === "message_update") decoded.push(value);
  }
  assert.ok(decoded.length > 0 && decoded.length < 30, "ring must retain a bounded complete tail");
  assert.equal(decoded.at(-1).index, 29);
  for (const frame of decoded) assert.equal(frame.payload, payload, "retained messages must be byte-exact");
});
