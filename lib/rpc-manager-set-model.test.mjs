import assert from "node:assert/strict";
import test from "node:test";
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("../ops/session-host/web-compat.ts");
  } catch {
    return import("../ops/session-host/web-compat.ts");
  }
}
const { createWebCompat } = await loadSubject();

/**
 * SDK 17.3.0's ModelRegistry.find() takes (provider, modelId) — not a single
 * "provider/modelId" selector (#9). This exercises the set_model command
 * against a registry stub with the SDK's real signature.
 */
function makeSession(find) {
  const setModelCalls = [];
  const session = {
    sessionId: "test-session",
    sessionFile: "/tmp/test-session.jsonl",
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: false,
    model: undefined,
    modelRegistry: {
      find,
      getAll: () => [],
      getAvailable: () => [],
      refresh: async () => undefined,
    },
    sessionManager: {
      getSessionFile: () => "/tmp/test-session.jsonl",
      getHeader: () => null,
      getEntries: () => [],
    },
    agent: { state: {} },
    setModel: async (model, role) => {
      setModelCalls.push({ model, role });
    },
  };
  return { session, setModelCalls };
}

function makeCompat(session) {
  const captured = [];
  const transport = {
    emitHostFrame(frame) { captured.push(frame); },
    forwardToSdk() {},
    hasOpenPrompt: () => false,
    closeInput() {},
  };
  // Minimal EventBus stub: RpcSubagentRegistry only calls eventBus.on(...).
  const eventBus = { on: () => () => {}, emit() {} };
  const compat = createWebCompat({
    session,
    sessionManager: session.sessionManager,
    settings: {},
    cwd: "/tmp",
    transport,
    getDecoration: () => undefined,
    eventBus,
    onShutdown() {},
  });
  // Unblock extension-gated commands the way runRpcMode does after binding.
  compat.handleOutboundFrame({ type: "available_commands_update" });
  return { compat, captured };
}

async function sendSetModel(compat, captured, command) {
  const id = `set-model-${captured.length}`;
  compat.handleInboundFrame({ id, ...command });
  for (let i = 0; i < 200; i++) {
    const response = captured.find(
      (frame) => frame.type === "response" && frame.command === "set_model" && frame.id === id,
    );
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("set_model response never arrived");
}

test("set_model looks the model up with the SDK's two-argument find(provider, modelId)", async () => {
  const calls = [];
  const model = { id: "glm-5.1", provider: "zhipu-coding-plan" };
  const { session, setModelCalls } = makeSession((provider, modelId) => {
    calls.push([provider, modelId]);
    return provider === "zhipu-coding-plan" && modelId === "glm-5.1" ? model : undefined;
  });
  const { compat, captured } = makeCompat(session);
  try {
    const response = await sendSetModel(compat, captured, {
      type: "set_model",
      provider: "zhipu-coding-plan",
      modelId: "glm-5.1",
    });
    assert.equal(response.success, true);
    assert.deepEqual(calls, [["zhipu-coding-plan", "glm-5.1"]]);
    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls[0].model, model);
    assert.deepEqual(response.data, { id: "glm-5.1", provider: "zhipu-coding-plan" });
  } finally {
    compat.dispose();
  }
});

test("set_model retries via registry refresh when the model is missing, then reports not found", async () => {
  let refreshCount = 0;
  const calls = [];
  const { session, setModelCalls } = makeSession((provider, modelId) => {
    calls.push([provider, modelId]);
    return calls.length > 1 ? { id: modelId, provider } : undefined;
  });
  session.modelRegistry.refresh = async () => {
    refreshCount += 1;
  };
  const { compat, captured } = makeCompat(session);
  try {
    const response = await sendSetModel(compat, captured, {
      type: "set_model",
      provider: "deepseek",
      modelId: "deepseek-chat",
      role: "default",
    });
    assert.equal(response.success, true);
    assert.equal(refreshCount, 1);
    assert.deepEqual(response.data, { id: "deepseek-chat", provider: "deepseek", role: "default" });
    assert.equal(setModelCalls.length, 1);

    // A model the registry genuinely does not know: refresh runs, then errors.
    session.modelRegistry.find = () => undefined;
    const failure = await sendSetModel(compat, captured, {
      type: "set_model",
      provider: "nope",
      modelId: "nope",
    });
    assert.equal(failure.success, false);
    assert.match(failure.error, /Model not found: nope\/nope/);
  } finally {
    compat.dispose();
  }
});