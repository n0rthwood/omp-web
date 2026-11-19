import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RpcFrameEncoder, RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";

const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;

test("transport delivers a multi-MiB chunked frame byte-exact under backpressure", async (t) => {
  const runDir = mkdtempSync(join(tmpdir(), "omp-delivery-"));
  process.env.OMP_WEB_HOST_RUN_DIR = runDir;
  const { createSessionTransport } = await import("../ops/session-host/transport.ts");
  const key = `delivery-${Date.now()}`;
  const transport = await createSessionTransport({
    sessionId: key, helloSessionId: "real-1", sessionFile: "", cwd: runDir,
    onFrame: () => {},
  });
  t.after(async () => {
    await transport.close();
    if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
    else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
    rmSync(runDir, { recursive: true, force: true });
  });

  const enc = new RpcFrameEncoder(); enc.setProtocolVersion(2);
  const frame = { type: "message_update", payload: "x".repeat(6 * 1024 * 1024) };
  const encoded = enc.encode(frame);                 // one logical frame, many rpc_chunk lines
  const expectedBytes = Buffer.byteLength(encoded, "utf8");

  const got = []; let received = 0;
  const client = await Bun.connect({
    unix: transport.socketPath,
    socket: {
      open(s) { s.write(`${JSON.stringify({ type: "host_attach", lastSeenSeq: 0 })}\n`); },
      data(s, chunk) { got.push(Buffer.from(chunk)); received += chunk.length; },
      drain() {}, close() {}, error() {}, end() {},
    },
  });
  // Wait for the attach ack so the client is registered, then write the frame.
  await Bun.sleep(50);
  transport.stdoutAdapter.write(encoded);
  const result = await Promise.race([
    (async () => { while (received < expectedBytes) await Bun.sleep(10); return "complete"; })(),
    Bun.sleep(8000).then(() => "timeout"),
  ]);
  client.end();
  assert.equal(result, "complete", `stalled: received ${received}/${expectedBytes}`);
  const buf = Buffer.concat(got);
  // Strip the hello/ready/host_attach greeting lines, keep the chunk lines.
  const text = buf.toString("utf8");
  const chunkLines = text.split("\n").filter((l) => l.includes('"rpc_chunk"'));
  const dec = new RpcFrameDecoder();
  let decoded;
  for (const line of chunkLines) { const d = dec.push(JSON.parse(line)); if (d) decoded = d; }
  assert.deepEqual(decoded, frame, "decoded frame must equal the original (no dropped/truncated bytes)");
});
