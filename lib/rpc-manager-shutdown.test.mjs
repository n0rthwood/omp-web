import assert from "node:assert/strict";
import test from "node:test";
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}
const { AgentSessionWrapper } = await loadSubject();

// Issue #94: the wrapper no longer owns an SDK session. Shutdown writes ONE
// wire shutdown frame to the host, waits for the host process to exit (the
// host runs extension session_shutdown hooks + SDK dispose itself), and only
// then force-stops the unit. destroy() is detach-only and idempotent.
function makeConnection({ exitOnShutdown = true, neverExit = false } = {}) {
  const written = [];
  const exits = [];
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  const connection = {
    written,
    exits,
    process: {
      stdin: {
        write(chunk) {
          written.push(JSON.parse(String(chunk)));
          if (exitOnShutdown && !neverExit
            && written[written.length - 1]?.type === "shutdown") {
            resolveExited(0);
          }
          return true;
        },
      },
      stdout: { on() {}, once() {}, removeListener() {}, destroy() {} },
      exited,
      peekStderr: () => "",
      kill() { exits.push("kill"); },
    },
    detach() { exits.push("detach"); },
    feedStdout() {},
    resolveExited,
  };
  return connection;
}

function makeWrapper(connection, terminate = { allowed: false }) {
  return new AgentSessionWrapper(
    connection,
    { sessionId: "shutdown-test", sessionFile: "/tmp/shutdown-test.jsonl", cwd: "/tmp" },
    { attach: false, terminate },
  );
}

test("session shutdown sends one shutdown frame and waits for host exit before detaching", async () => {
  const calls = [];
  const connection = makeConnection();
  const terminate = { allowed: false };
  const wrapper = makeWrapper(connection, terminate);
  wrapper.onDestroy(() => calls.push("destroy"));

  await Promise.all([wrapper.shutdown(), wrapper.shutdown()]);

  const shutdownFrames = connection.written.filter((frame) => frame.type === "shutdown");
  assert.equal(shutdownFrames.length, 1, "shutdown frame must be written exactly once (memoized)");
  assert.equal(terminate.allowed, true, "shutdown must gate-allow process termination");
  assert.deepEqual(calls, ["destroy"]);
  assert.deepEqual(connection.exits, ["detach"], "host exited cleanly: detach only, no forced kill");
  assert.equal(wrapper.isAlive(), false);
  assert.ok(connection.written.length >= 1);
});

test("session shutdown still completes when the host never exits (grace timeout path)", async () => {
  const calls = [];
  const connection = makeConnection({ neverExit: true });
  const wrapper = makeWrapper(connection);
  wrapper.onDestroy(() => calls.push("destroy"));

  // The grace path would stop the systemd unit after HOST_SHUTDOWN_GRACE_MS;
  // resolve the exit manually right after shutdown starts so the test does
  // not wait out the grace window.
  const pending = wrapper.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  connection.resolveExited(0);
  await pending;

  assert.equal(connection.written.filter((frame) => frame.type === "shutdown").length, 1);
  assert.deepEqual(calls, ["destroy"]);
  assert.equal(wrapper.isAlive(), false);
});

test("direct destruction detaches without killing the host and is idempotent", () => {
  const calls = [];
  const connection = makeConnection({ exitOnShutdown: false });
  const wrapper = makeWrapper(connection);
  wrapper.onDestroy(() => calls.push("destroy"));

  wrapper.destroy();
  wrapper.destroy();

  assert.deepEqual(calls, ["destroy"], "onDestroy must fire exactly once");
  assert.equal(connection.written.length, 0, "detach-only destroy must not write frames");
  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(connection.exits, ["detach"], "detach-only destroy must detach, never kill");
});