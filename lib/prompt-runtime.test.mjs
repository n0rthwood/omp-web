import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager, Settings, createAgentSession, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent";
import "@oh-my-pi/pi-coding-agent/config/all-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { bindPreparedExtensions, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { bindPromptProfile, inheritPromptProfile, loadPromptSnapshot, readPromptCatalog, readPromptMarker, resolvePromptDefaults, savePromptDefaults } from "./prompt-store.ts";
import { afterPlanApprovalText, createPromptExtension, promptSessionOptions } from "./prompt-runtime.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omp118-runtime-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  return { root, cwd, agentDir, close: () => rmSync(root, { recursive: true, force: true }) };
}
function manager() {
  const entries = [];
  return { getEntries: () => entries, appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); } };
}
async function save(f, scope, values) {
  const current = resolvePromptDefaults(f.agentDir, f.cwd);
  await savePromptDefaults({ cwd: f.cwd, scope, etag: current[scope].etag, values }, f.agentDir);
}

test("scope inheritance, intentional empty supplements, reset and stale concurrent editors", async () => {
  const f = fixture();
  try {
    const stale = resolvePromptDefaults(f.agentDir, f.cwd).global.etag;
    await save(f, "global", { append: "global", planningGuidance: "plan" });
    await assert.rejects(savePromptDefaults({ scope: "global", etag: stale, values: { append: "lost writer" } }, f.agentDir), /changed elsewhere/);
    await save(f, "project", { append: "" });
    assert.deepEqual(resolvePromptDefaults(f.agentDir, f.cwd).values, { append: "", planningGuidance: "plan" });
    await save(f, "project", { append: null });
    assert.equal(resolvePromptDefaults(f.agentDir, f.cwd).values.append, "global");
    await assert.rejects(save(f, "global", { baseTemplate: "{{#if a}}unterminated" }), /Invalid base template/);
    await assert.rejects(save(f, "global", { baseTemplate: "" }), /must not be empty/);
    await assert.rejects(save(f, "global", { append: "\u0001".repeat(255 * 1024) }), /too large after JSON encoding/);
  } finally { f.close(); }
});

test("new profiles pin bytes privately; resume/forks keep old settings and missing snapshots fail closed", async () => {
  const f = fixture();
  try {
    await save(f, "global", { append: "revision one", planningGuidance: "first plan" });
    const original = manager();
    const pinned = await bindPromptProfile(original, f.cwd, true, f.agentDir);
    const journal = JSON.stringify(original.getEntries());
    assert.ok(!journal.includes("revision one"));
    const snapshot = join(f.agentDir, "omp-web-prompt-snapshots", `${pinned.marker.profileId}.json`);
    assert.equal(statSync(snapshot).mode & 0o777, 0o600);
    await save(f, "global", { append: "revision two" });
    assert.equal((await bindPromptProfile(original, f.cwd, false, f.agentDir)).values.append, "revision one");
    assert.equal(await bindPromptProfile(manager(), f.cwd, false, f.agentDir), null);
    const fork = manager(); inheritPromptProfile(original, fork);
    assert.equal((await bindPromptProfile(fork, f.cwd, false, f.agentDir)).marker.profileId, pinned.marker.profileId);
    const fresh = await bindPromptProfile(manager(), f.cwd, true, f.agentDir);
    assert.equal(fresh.values.append, "revision two");
    writeFileSync(snapshot, "{}");
    assert.throws(() => loadPromptSnapshot(readPromptMarker(original.getEntries()), f.agentDir), /unavailable or changed/);
  } finally { f.close(); }
});

test("native catalog does not expand imports, follow source symlinks or reveal server project in global view", async () => {
  const f = fixture();
  try {
    const secret = join(f.root, "outside.md"); writeFileSync(secret, "outside-private-value");
    writeFileSync(join(f.agentDir, "AGENTS.md"), `@${secret}\naccount rules`);
    symlinkSync(secret, join(f.agentDir, "PERSONALITY.md"));
    const catalog = await readPromptCatalog(null, f.agentDir);
    assert.ok(catalog.sources.some((s) => s.label === "PERSONALITY.md" && !s.content));
    assert.ok(!JSON.stringify(catalog).includes("outside-private-value"));
    assert.ok(!catalog.sources.some((s) => s.path === join(process.cwd(), "AGENTS.md")));
    assert.equal(catalog.presets.length, 1);
    assert.equal(catalog.presets[0].values.baseTemplate, undefined);
  } finally { f.close(); }
});

test("SDK extension chaining preserves other hooks; typed planning copies and approval transition get additions", async () => {
  const f = fixture();
  try {
    await save(f, "global", { append: "managed append", planningGuidance: "managed plan", afterPlanApproval: "managed execute" });
    const profile = await bindPromptProfile(manager(), f.cwd, true, f.agentDir);
    const loaded = await bindPreparedExtensions([
      { path: "other", resolvedPath: "other", error: null, factory(api) { api.on("before_agent_start", (event) => ({ systemPrompt: [...event.systemPrompt, "other extension"] })); } },
      { path: "managed", resolvedPath: "managed", error: null, factory: createPromptExtension(profile) },
    ], f.cwd);
    assert.deepEqual(loaded.errors, []);
    const sessions = SessionManager.inMemory(f.cwd);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, f.cwd, sessions, {});
    const output = await runner.emitBeforeAgentStart("hello", undefined, ["base", "project"]);
    assert.deepEqual(output.systemPrompt.slice(0, 3), ["base", "project", "other extension"]);
    assert.match(output.systemPrompt[3], /managed append/);
    const messages = [
      { role: "custom", customType: "plan-mode-context", content: [{ type: "text", text: "SDK path and guard" }, { type: "image", data: "unchanged" }] },
      { role: "custom", customType: "plan-mode-reference", content: "approved plan body" },
      { role: "user", customType: "plan-mode-context", content: "never transform user" },
    ];
    const original = structuredClone(messages);
    const transformed = await runner.emitContext(messages);
    assert.deepEqual(messages, original);
    assert.deepEqual(transformed[0].content.slice(0, 2), original[0].content);
    assert.match(transformed[0].content[2].text, /managed plan/);
    assert.match(transformed[1].content, /approved plan body[\s\S]*managed execute/);
    assert.deepEqual(transformed[2], original[2]);
    assert.match(afterPlanApprovalText("Approved now", profile), /^Approved now[\s\S]*managed execute/);
    const child = new ExtensionRunner(loaded.extensions, loaded.runtime, f.cwd, sessions, {}, undefined, undefined, undefined, undefined, { kind: "sub", id: "child", name: "sub", depth: 0 });
    const childSystem = await child.emitBeforeAgentStart("child task", undefined, ["child base"]);
    assert.deepEqual(childSystem.systemPrompt, ["child base", "other extension"]);
    assert.deepEqual(await child.emitContext(messages), messages);
  } finally { f.close(); }
});

test("real restricted SDK sends managed system and planning instructions without admitting tools or rewriting history", async () => {
  const f = fixture();
  let session;
  try {
    await save(f, "global", { baseTemplate: "# Owned base\n{{#if skills.length}}skills{{/if}}", append: "owned append", planningGuidance: "request planning sentinel" });
    const profile = await bindPromptProfile(manager(), f.cwd, true, f.agentDir);
    const settings = await Settings.loadIsolated({ cwd: f.cwd, agentDir: f.agentDir, inMemory: true });
    const created = await createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, settings, sessionManager: SessionManager.inMemory(f.cwd), toolNames: [], restrictToolNames: true, enableMCP: false, enableLsp: false, disableExtensionDiscovery: true, ...promptSessionOptions(profile, true) });
    session = created.session;
    assert.deepEqual(session.getActiveToolNames(), []);
    assert.match(session.systemPrompt.join("\n"), /Owned base/);
    const transformed = await session.extensionRunner.emitBeforeAgentStart("hello", undefined, session.systemPrompt);
    assert.equal(transformed.systemPrompt.filter((block) => block.includes("owned append")).length, 1);
    session.modelRegistry.registerProvider("omp118-test", {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "test-only-key",
      models: [{ id: "local", name: "Local test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    });
    await session.setModelTemporary(session.modelRegistry.find("omp118-test", "local"));
    let captured;
    session.agent.streamFn = (model, context) => {
      captured = structuredClone(context);
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "The request has been inspected." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    };
    session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" });
    await session.prompt("Inspect the local test request and answer briefly.");
    assert.match(captured.systemPrompt.join("\n"), /owned append/);
    assert.ok(captured.messages.some((message) => message.role === "developer" && JSON.stringify(message.content).includes("request planning sentinel")));
    assert.deepEqual(session.getActiveToolNames(), []);
    assert.ok(!JSON.stringify(session.sessionManager.getEntries()).includes("request planning sentinel"));
  } finally { if (session) await session.dispose(); f.close(); }
});

test("real branch writer releases the child lease and preserves profile metadata", async () => {
  const f = fixture();
  const sessions = join(f.root, "sessions"); mkdirSync(sessions);
  const parent = SessionManager.create(f.cwd, sessions);
  try {
    await bindPromptProfile(parent, f.cwd, true, f.agentDir);
    const firstId = parent.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    parent.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
    await parent.ensureOnDisk(); parent.flushSync();
    for (const deep of [false, true]) {
      const child = deep ? await SessionManager.open(parent.getSessionFile(), sessions) : SessionManager.create(f.cwd, sessions);
      let childFile; let childId;
      try {
        if (deep) assert.ok(child.createBranchedSession(firstId));
        else await child.newSession({ parentSession: parent.getSessionFile() });
        inheritPromptProfile(parent, child);
        await child.ensureOnDisk(); child.flushSync(); childFile = child.getSessionFile(); childId = child.getSessionId();
      } finally { await child.close(); }
      const probe = tryAcquireSessionLease(childId);
      assert.ok(probe, "a fresh host can immediately claim fork"); probe.release();
      const opened = await SessionManager.open(childFile, sessions);
      try { assert.deepEqual(readPromptMarker(opened.getEntries()), readPromptMarker(parent.getEntries())); }
      finally { await opened.close(); }
    }
  } finally { await parent.close(); f.close(); }
});

test("scoped Settings reload native injection changes while retaining rotated model roles", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.agentDir, "config.yml"), "todo:\n  reminders: true\n");
    const global = await Settings.loadIsolated({ cwd: f.cwd, agentDir: f.agentDir });
    const scoped = await global.cloneForCwd(f.cwd);
    scoped.overrideModelRoles({ default: "test/rotated-model" });
    writeFileSync(join(f.agentDir, "config.yml"), "todo:\n  reminders: false\n");
    await scoped.reloadFromDisk();
    assert.equal(lookup("todo.reminders").get(scoped), false);
    assert.equal(scoped.getModelRole("default"), "test/rotated-model");
  } finally { f.close(); }
});
