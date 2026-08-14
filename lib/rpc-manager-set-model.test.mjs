import assert from "node:assert/strict";
import test from "node:test";
import { AgentSessionWrapper } from "./rpc-manager.ts";

/**
 * SDK 17.3.0's ModelRegistry.find() takes (provider, modelId) — not a single
 * "provider/modelId" selector (#9). This exercises the set_model command
 * against a registry stub with the SDK's real signature.
 */
function makeInner(find) {
  const setModelCalls = [];
  const inner = {
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
  return { inner, setModelCalls };
}

function makeWrapper(inner) {
  // Minimal EventBus stub: RpcSubagentRegistry only calls eventBus.on(...).
  const eventBus = { on: () => () => {} };
  return new AgentSessionWrapper(inner, eventBus);
}

test("set_model looks the model up with the SDK's two-argument find(provider, modelId)", async () => {
  const calls = [];
  const model = { id: "glm-5.1", provider: "zhipu-coding-plan" };
  const { inner, setModelCalls } = makeInner((provider, modelId) => {
    calls.push([provider, modelId]);
    return provider === "zhipu-coding-plan" && modelId === "glm-5.1" ? model : undefined;
  });
  const wrapper = makeWrapper(inner);
  try {
    const result = await wrapper.send({
      type: "set_model",
      provider: "zhipu-coding-plan",
      modelId: "glm-5.1",
    });
    assert.deepEqual(calls, [["zhipu-coding-plan", "glm-5.1"]]);
    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls[0].model, model);
    assert.deepEqual(result, { id: "glm-5.1", provider: "zhipu-coding-plan" });
  } finally {
    wrapper.destroy();
  }
});

test("set_model retries via registry refresh when the model is missing, then reports not found", async () => {
  let refreshCount = 0;
  const calls = [];
  const { inner, setModelCalls } = makeInner((provider, modelId) => {
    calls.push([provider, modelId]);
    return calls.length > 1 ? { id: modelId, provider } : undefined;
  });
  inner.modelRegistry.refresh = async () => {
    refreshCount += 1;
  };
  const wrapper = makeWrapper(inner);
  try {
    const result = await wrapper.send({
      type: "set_model",
      provider: "deepseek",
      modelId: "deepseek-chat",
      role: "default",
    });
    assert.equal(refreshCount, 1);
    assert.deepEqual(result, { id: "deepseek-chat", provider: "deepseek", role: "default" });
    assert.equal(setModelCalls.length, 1);

    // A model the registry genuinely does not know: refresh runs, then throws.
    inner.modelRegistry.find = () => undefined;
    await assert.rejects(
      () => wrapper.send({ type: "set_model", provider: "nope", modelId: "nope" }),
      /Model not found: nope\/nope/,
    );
  } finally {
    wrapper.destroy();
  }
});
