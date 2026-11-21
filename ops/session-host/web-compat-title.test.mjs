import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebCompat } from "./web-compat.ts";

function makeCompat(t) {
  const savedRunDir = process.env.OMP_WEB_HOST_RUN_DIR;
  const savedNoTitle = process.env.PI_NO_TITLE;
  const runDir = mkdtempSync(join(tmpdir(), "omp-title-"));
  process.env.OMP_WEB_HOST_RUN_DIR = runDir;
  delete process.env.PI_NO_TITLE;

  const frames = [];
  const forwarded = [];
  const names = [];
  let name;
  let registryReads = 0;
  const settings = {
    revision: 0,
    valueCache: [],
    warnState: { invalid: new Map(), items: new Map() },
    rawValue: (setting) => setting.id === "plan.defaultOnStartup" || setting.id === "plan.enabled" ? false : undefined,
  };
  const sessionManager = {
    getEntries: () => [],
    getHeader: () => ({ id: "title-session", cwd: runDir, timestamp: new Date().toISOString() }),
    getSessionName: () => name,
    getSessionFile: () => "",
    setSessionName: async (title, source) => {
      name = title;
      names.push([title, source]);
      return true;
    },
    buildSessionContext: () => ({ messages: [] }),
  };
  const session = {
    agent: { state: { messages: [] } },
    extensionRunner: { getRegisteredCommands: () => [] },
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    getTodoPhases: () => [],
    getPlanModeState: () => undefined,
    sessionId: "title-session",
    sessionFile: "",
    sessionManager,
    settings,
    modelRegistry: { getAvailable: () => { registryReads++; return []; } },
  };
  const compat = createWebCompat({
    session,
    sessionManager,
    settings,
    cwd: runDir,
    transport: {
      emitHostFrame: (frame) => frames.push(frame),
      forwardToSdk: (frame) => forwarded.push(frame),
      hasOpenPrompt: () => false,
      releasePrompt: () => {},
      socketPath: join(runDir, "title.sock"),
      socketKey: "title",
    },
    eventBus: { on: () => () => {} },
    getDecoration: () => undefined,
    onShutdown: () => {},
  });
  t.after(() => {
    compat.dispose();
    if (savedRunDir === undefined) delete process.env.OMP_WEB_HOST_RUN_DIR;
    else process.env.OMP_WEB_HOST_RUN_DIR = savedRunDir;
    if (savedNoTitle === undefined) delete process.env.PI_NO_TITLE;
    else process.env.PI_NO_TITLE = savedNoTitle;
    rmSync(runDir, { recursive: true, force: true });
  });
  compat.handleOutboundFrame({ type: "available_commands_update", commands: [] });
  return { compat, session, frames, forwarded, names, registryReads: () => registryReads };
}

async function until(predicate, what) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

test("prompt admission titles immediately via SDK decline fallback, never again at completion", async (t) => {
  const { compat, frames, forwarded, names, registryReads } = makeCompat(t);
  compat.handleInboundFrame({ type: "prompt", id: "p1", message: "修复登录跳转问题", promptId: "d1" });
  await until(() => forwarded.length === 1, "prompt forwarding");
  assert.equal(names.length, 0, "unadmitted prompts stay unnamed");
  compat.handleOutboundFrame({ type: "response", id: "p1", command: "prompt", success: true, data: null });
  await until(() => frames.some((frame) => frame.type === "session_renamed"), "admission title");
  assert.deepEqual(names, [["修复登录跳转问题", "auto"]]);
  assert.equal(registryReads(), 1, "real SDK reached the empty model registry");
  assert.deepEqual(compat.pendingPromptIdentities(), [{ id: "p1", promptId: "d1" }]);
  compat.handleOutboundFrame({ type: "prompt_result", id: "p1", status: "completed" });
  await Bun.sleep(10);
  assert.deepEqual(names, [["修复登录跳转问题", "auto"]]);
  assert.equal(registryReads(), 1);
  assert.deepEqual(frames.find((frame) => frame.type === "host_prompt_identity"), {
    type: "host_prompt_identity", id: "p1", promptId: "d1",
  });
  assert.deepEqual(compat.pendingPromptIdentities(), []);
});

test("low-signal gate skips remain absolute even with a fallback available", async (t) => {
  const { compat, forwarded, names, registryReads } = makeCompat(t);
  compat.handleInboundFrame({ type: "prompt", id: "p1", message: "hi" });
  await until(() => forwarded.length === 1, "greeting forwarding");
  compat.handleOutboundFrame({ type: "response", id: "p1", command: "prompt", success: true, data: null });
  await Bun.sleep(10);
  assert.deepEqual(names, []);
  assert.equal(registryReads(), 0);
});

test("manual title uses the live first user message before the journal flush", async (t) => {
  const { compat, session, frames, names, registryReads } = makeCompat(t);
  session.agent.state.messages = [{ role: "user", content: [{ type: "text", text: "给会话起标题" }] }];
  compat.handleInboundFrame({ type: "auto_name", id: "a1" });
  await until(() => frames.some((frame) => frame.type === "response" && frame.id === "a1"), "manual title response");
  const response = frames.find((frame) => frame.type === "response" && frame.id === "a1");
  assert.equal(response.success, true);
  assert.equal(response.data.title, "给会话起标题");
  assert.deepEqual(names, [["给会话起标题", "user"]]);
  assert.equal(registryReads(), 1, "manual generation also uses the real SDK decline path");
});
