import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("RPC session startup reuses the shared omp runtime instead of a per-session one", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /getOmpRuntime\(\)/);
  assert.match(startupSource, /getSettingsForCwd\(sessionCwd\)/);
  assert.match(startupSource, /modelRegistry,/);
});

test("RPC session startup gates untrusted project code before creating the session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const discoverIndex = startupSource.indexOf("discoverSessionExtensionPaths(");
  const gateIndex = startupSource.indexOf("untrustedProjectSessionOptions(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(discoverIndex >= 0);
  assert.ok(gateIndex > discoverIndex);
  assert.ok(createIndex > gateIndex);
  assert.match(startupSource, /discoverCustomToolPaths\(\[\], sessionCwd\)/);
  assert.match(startupSource, /\.\.\.\(untrusted \?\? \{\}\)/);
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: initial\.scopedModels/);
  assert.match(startupSource, /model: initial\.model/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.buildSessionContext\(\)\.messages\.length > 0/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /const hasExistingMessages = sessionManager\.getBranch\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /untrustedProjectSessionOptions\(sessionCwd, agentDir, \{ extensionPaths, customToolPaths \}\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle and running-state maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const notifySource = source.slice(
    source.indexOf("export function notifyRunningChange"),
    source.indexOf("export async function startRpcSession"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.match(startSource, /RUNNING_STATE_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
  assert.match(notifySource, /if \(listeners\.size === 0\)/);
  assert.match(notifySource, /lastRunningSnapshot = ""/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(forkSource, /await this\.shutdown\(\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(\s*runtime\.settings/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("RPC command bridge dispatches omp text-mode slash builtins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const commandSource = source.slice(
    source.indexOf('case "execute_slash_command"'),
    source.indexOf('case "set_tools"'),
  );

  assert.match(commandSource, /executeAcpBuiltinSlashCommand\(/);
  assert.match(commandSource, /output\.push\(text\)/);
  assert.match(commandSource, /handled: true/);
  assert.match(commandSource, /prompt: result\.prompt/);
});
test("RPC state retains completed subagent snapshots for history", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const stateSource = source.slice(
    source.indexOf('case "get_state"'),
    source.indexOf('case "get_subagent_messages"'),
  );

  assert.match(source, /private readonly subagentHistory = new Map<string, SubagentSnapshot>\(\)/);
  assert.match(source, /private getSubagentSnapshots\(\)/);
  assert.match(stateSource, /subagents: this\.getSubagentSnapshots\(\)/);
  assert.match(source, /this\.subagentHistory\.clear\(\)/);
  assert.match(source, /this\.subagents\.getSubagents\(\)\.length > 0/);
});

// --- issue #20: browser auto-title trigger wiring ---

test("a completed (non-streaming-behavior) prompt turn fires the auto-title trigger alongside prompt_done", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const promptCaseSource = source.slice(source.indexOf('case "prompt": {'), source.indexOf('case "abort"'));
  const thenBlock = promptCaseSource.slice(promptCaseSource.indexOf(").then(() => {"));

  assert.match(thenBlock, /if \(!streamingBehavior\) \{\s*\n\s*this\.emit\(\{ type: "prompt_done" \}\);\s*\n\s*void this\.maybeAutoGenerateTitle\(command\.message as string\);\s*\n\s*\}/);
});

test("maybeAutoGenerateTitle composes the gate from the live session name, PI_NO_TITLE, and registered extension commands", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const methodSource = source.slice(
    source.indexOf("private async maybeAutoGenerateTitle("),
    source.indexOf("private resetIdleTimer("),
  );

  assert.match(methodSource, /this\.inner\.extensionRunner\?\.getRegisteredCommands\(\) \?\? \[\]/);
  assert.match(methodSource, /shouldAutoGenerateTitle\(\{/);
  assert.match(methodSource, /hasSessionName: Boolean\(sessionManager\.getSessionName\(\)\)/);
  assert.match(methodSource, /piNoTitle: process\.env\.PI_NO_TITLE/);
  assert.match(methodSource, /extensionCommandNames: commandNames/);
  assert.match(methodSource, /if \(!eligible\) return;/);
});

test("maybeAutoGenerateTitle threads the triggering message into generateSessionTitle and re-checks the name before applying it", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const methodSource = source.slice(
    source.indexOf("private async maybeAutoGenerateTitle("),
    source.indexOf("private resetIdleTimer("),
  );

  // The literal message that passed the gate drives generation — never a
  // history-derived lookup, which would re-target a stale first turn.
  assert.match(methodSource, /generateSessionTitle\(this\.inner, message\)/);
  // A concurrent manual "Generate title" click (or a second racing call)
  // must still win: re-check right before writing the name.
  assert.match(methodSource, /if \(sessionManager\.getSessionName\(\)\) return;/);
  assert.match(methodSource, /setSessionName\(result\.title, "auto"\)/);
});

test("a successful auto title invalidates the session cache and relays a session_renamed event carrying the session id", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const methodSource = source.slice(
    source.indexOf("private async maybeAutoGenerateTitle("),
    source.indexOf("private resetIdleTimer("),
  );

  assert.match(methodSource, /invalidateSessionListCache\(\);/);
  assert.match(methodSource, /this\.emit\(\{ type: "session_renamed", title: result\.title, sessionId: this\.inner\.sessionId \}\);/);
  assert.match(methodSource, /notifyRunningChange\(\);/);
  // Never surfaces to the client as a hard failure — a title-generation
  // hiccup must not break the turn the browser is already looking at.
  assert.match(methodSource, /catch \(error\) \{\s*\n\s*console\.error\("\[pi-web\] auto title generation failed:"/);
});
