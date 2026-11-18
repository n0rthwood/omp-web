import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Issue #94 split the monolithic rpc-manager into a per-conversation host
// (ops/session-host/*) and a UDS proxy wrapper (lib/rpc-manager.ts). These
// source-regex guards follow the behavior to its new owner: startup/trust/
// scope live in the host entry, idle reaping in host idle.ts + transport.ts,
// command semantics in web-compat.ts, browser frames + caches in the wrapper.

const wrapperUrl = new URL("./rpc-manager.ts", import.meta.url);
const hostMainUrl = new URL("../ops/session-host/main.ts", import.meta.url);
const compatUrl = new URL("../ops/session-host/web-compat.ts", import.meta.url);

/** Host startup preamble: main() body (the old startRpcSession slice). */
async function hostStartupSource() {
  const source = await readFile(hostMainUrl, "utf8");
  return source.slice(source.indexOf("async function main()"));
}

/** Slice between two anchors, failing loudly if an anchor drifted away. */
function between(source, startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, `missing start anchor: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `missing end anchor: ${endAnchor}`);
  return source.slice(start, end);
}

test("host startup reuses the shared omp runtime instead of a per-session one", async () => {
  const startupSource = await hostStartupSource();

  assert.match(startupSource, /getOmpRuntime\(\)/);
  assert.match(startupSource, /getSettingsForCwd\(sessionCwd\)/);
  assert.match(startupSource, /modelRegistry,/);
});

test("host startup gates untrusted project code before creating the session", async () => {
  const startupSource = await hostStartupSource();
  const discoverIndex = startupSource.indexOf("discoverSessionExtensionPaths(");
  const gateIndex = startupSource.indexOf("untrustedProjectSessionOptions(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(discoverIndex >= 0);
  assert.ok(gateIndex > discoverIndex);
  assert.ok(createIndex > gateIndex);
  assert.match(startupSource, /discoverCustomToolPaths\(\[\], sessionCwd\)/);
  assert.match(startupSource, /\.\.\.\(untrusted \?\? \{\}\)/);
});

test("host startup resolves and passes the SDK-native enabled model scope", async () => {
  const startupSource = await hostStartupSource();
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  // Initial fields are conditional spreads now: a continuing session must
  // NOT re-apply model/thinkingLevel, so unset values are omitted entirely.
  assert.match(startupSource, /\.\.\.\(initial\.scopedModels\.length > 0 \? \{ scopedModels: initial\.scopedModels \} : \{\}\)/);
  assert.match(startupSource, /\.\.\.\(initial\.model \? \{ model: initial\.model \} : \{\}\)/);
  assert.match(startupSource, /\.\.\.\(initial\.thinkingLevel \? \{ thinkingLevel: initial\.thinkingLevel \} : \{\}\)/);
});

test("host startup treats only sessions with messages as continuing", async () => {
  const startupSource = await hostStartupSource();

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.buildSessionContext\(\)\.messages\.length > 0/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = args\.sessionFile/);
  assert.doesNotMatch(startupSource, /const hasExistingMessages = sessionManager\.getBranch\(\)/);
});

test("host startup opens an existing session file only once and trusts its cwd", async () => {
  const startupSource = await hostStartupSource();
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

test("idle reaping never fires on active sessions and tears down via input EOF", async () => {
  const idleSource = await readFile(new URL("../ops/session-host/idle.ts", import.meta.url), "utf8");
  const mainSource = await readFile(hostMainUrl, "utf8");

  // The old per-chunk idle timer became an activity-whitelist reaper: the
  // SDK settle predicate plus explicit guards for open prompts, live
  // subagents, shell runs and compaction. An active session is never reaped.
  assert.match(idleSource, /!isRpcSessionSettled\(options\.session\)/);
  assert.match(idleSource, /options\.transport\.hasOpenPrompt\(\)/);
  assert.match(idleSource, /options\.hasLiveSubagents\(\)/);
  assert.match(idleSource, /options\.session\.isBashRunning/);
  assert.match(idleSource, /options\.session\.isCompacting/);
  assert.match(idleSource, /if \(active\(\)\) \{/);
  // Reap action = close the shell-owned input (SDK EOF teardown) with a
  // dispose+exit grace fallback, not a kill.
  const exitHelper = between(mainSource, "const closeInputAndArmExit", "let decoration");
  assert.match(exitHelper, /transport\.closeInput\(\)/);
  assert.match(exitHelper, /session\.dispose\(\)/);
  assert.match(mainSource, /onReap: \(\) => \{[\s\S]*?closeInputAndArmExit\(\)/);
});

test("the transport interprets only the activity whitelist for the idle timer", async () => {
  const transportSource = await readFile(new URL("../ops/session-host/transport.ts", import.meta.url), "utf8");
  const whitelist = between(transportSource, "const ACTIVITY_FRAME_TYPES", "};");

  for (const type of [
    "agent_start",
    "agent_end",
    "prompt_result",
    "session_settled",
    "subagent_lifecycle",
    "subagent_progress",
  ]) {
    assert.match(whitelist, new RegExp(`${type}: true`));
  }
  // Streaming message frames are the multi-MiB per-chunk traffic the old
  // wrapper reset its idle timer on; the shell must stay transparent to them.
  assert.doesNotMatch(whitelist, /message_/);
  assert.match(transportSource, /if \(ACTIVITY_FRAME_TYPES\[type\]\)/);
});

test("RPC wrapper tracks running state from frames without per-chunk maintenance", async () => {
  const source = await readFile(wrapperUrl, "utf8");
  const frameSource = between(source, "private handleFrame(", "private handleResponseFrame(");
  const notifySource = between(source, "export function notifyRunningChange", "export async function startRpcSession");

  assert.match(frameSource, /RUNNING_STATE_EVENT_TYPES\[type\]/);
  assert.doesNotMatch(source, /IDLE_RESET_EVENT_TYPES/);
  assert.doesNotMatch(source, /resetIdleTimer/);
  assert.doesNotMatch(source, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
  assert.match(notifySource, /listeners\.size === 0/);
  assert.match(notifySource, /lastRunningSnapshot = ""/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const compatSource = await readFile(compatUrl, "utf8");
  const mainSource = await readFile(hostMainUrl, "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const forkSource = between(compatSource, 'case "fork"', 'case "navigate_tree"');
  const shutdownSource = between(compatSource, 'if (type === "shutdown")', "void (async () => {");

  // Idle reap closes the input → SDK EOF teardown (graceful extension shutdown).
  assert.match(mainSource, /onReap: \(\) => \{[\s\S]*?closeInputAndArmExit\(\)/);
  // A successful fork ends the OLD host: respond first, then shut down.
  assert.match(forkSource, /if \(!result\.cancelled\) onShutdown\(\);/);
  // Explicit shutdown responds BEFORE onShutdown (route treats it as terminal).
  assert.match(shutdownSource, /respondSuccess\(id, "shutdown"\);\s*onShutdown\(\);/);
  // DELETE is a host-owned write now: the route sends delete_session through
  // the lease-owning host (attach when live, spawn otherwise) instead of
  // poking a wrapper shutdown + unlinking the journal itself.
  assert.match(deleteRouteSource, /session\.send\(\{ type: "delete_session" \}\)/);
  assert.match(deleteRouteSource, /rpc\?\.isAlive\(\) \? rpc : undefined/);
  assert.doesNotMatch(deleteRouteSource, /getRpcSession\(id\)\?\.shutdown\(\)/);
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

test("host startup persists explicit preferences without replaying setters", async () => {
  const startupSource = await hostStartupSource();
  const wrapperSource = await readFile(wrapperUrl, "utf8");

  assert.match(startupSource, /persistExplicitStartupPreferences\(\s*runtime\.settings/);
  // modelDefaultChanged invalidation stays WEB-side (contract §3): the
  // process-local models cache is dropped when a model/scope command
  // response lands, including reload.
  assert.match(
    wrapperSource,
    /command === "set_model" \|\| command === "set_role_model" \|\| command === "reload"\) \{\s*invalidateModelsCache\(\);/,
  );
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("../ops/session-host/ui-decoration.ts", import.meta.url), "utf8");
  const customUiSource = between(source, "function requestExtensionCustomUi", "// ---------------------------------------------------------------- overrides");

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const compatSource = await readFile(compatUrl, "utf8");
  const wrapperSource = await readFile(wrapperUrl, "utf8");
  const reloadSource = between(compatSource, 'case "reload"', 'case "abort_compaction"');

  assert.match(reloadSource, /await session\.reload\(\)/);
  assert.match(reloadSource, /applyForcedEmptySystemPrompt\(\)/);
  // Cache invalidation is process-local to the web tier: it fires when the
  // reload RESPONSE lands in the wrapper tap, not inside the host.
  assert.match(
    wrapperSource,
    /command === "set_model" \|\| command === "set_role_model" \|\| command === "reload"\) \{\s*invalidateModelsCache\(\);/,
  );
});

test("RPC command bridge dispatches omp text-mode slash builtins", async () => {
  const compatSource = await readFile(compatUrl, "utf8");
  const commandSource = between(compatSource, "async function executeSlashCommand", "async function executeBashCommand");
  const dispatchSource = between(compatSource, 'case "execute_slash_command"', 'case "set_tools"');

  assert.match(dispatchSource, /executeSlashCommand\(String\(command\.message \?\? ""\)\)/);
  assert.match(commandSource, /executeAcpBuiltinSlashCommand\(/);
  assert.match(commandSource, /output\.push\(text\)/);
  assert.match(commandSource, /handled: true/);
  assert.match(commandSource, /prompt: result\.prompt/);
});

test("RPC state retains completed subagent snapshots for history", async () => {
  const wrapperSource = await readFile(wrapperUrl, "utf8");
  const compatSource = await readFile(compatUrl, "utf8");
  const stateSource = between(compatSource, "function buildWebState()", "async function executeFork(");

  // Wrapper history: fed by forwarded lifecycle/progress frames, overlaid on
  // every get_state response, cleared only on detach.
  assert.match(wrapperSource, /private readonly subagentHistory = new Map<string, SubagentSnapshot>\(\)/);
  assert.match(wrapperSource, /private getSubagentSnapshots\(\)/);
  assert.match(wrapperSource, /subagents: this\.getSubagentSnapshots\(\)/);
  assert.match(wrapperSource, /this\.subagentHistory\.clear\(\)/);
  // Host history: same retention on the owning side; live subagents also
  // keep the host out of the idle reaper's reach.
  assert.match(compatSource, /const subagentHistory = new Map<string, SubagentSnapshot>\(\)/);
  assert.match(stateSource, /subagents: getSubagentSnapshots\(\)/);
  assert.match(compatSource, /hasLiveSubagents: \(\) => subagents\.getSubagents\(\)\.length > 0/);
});

// --- issue #20: browser auto-title trigger wiring ---

test("a completed (non-streaming-behavior) prompt turn fires the auto-title trigger", async () => {
  const compatSource = await readFile(compatUrl, "utf8");
  const wrapperSource = await readFile(wrapperUrl, "utf8");
  const outboundSource = between(compatSource, "function handleOutboundFrame(", 'if (type === "agent_end"');
  const settleSource = between(wrapperSource, "private settlePrompt(", "// --------------------------------------------------------------------------");

  // The host owns the trigger: only a real (non-queued) prompt that COMPLETED
  // names the conversation, using the admitted message.
  assert.match(
    outboundSource,
    /if \(meta && !meta\.streamingBehavior && "status" in frame && frame\.status === "completed"\) \{\s*void maybeAutoGenerateTitle\(meta\.message\);/,
  );
  // The wrapper still settles every successful prompt with prompt_done.
  assert.match(settleSource, /this\.emit\(\{ type: "prompt_done", \.\.\.tracker\.promptEvent \}\);/);
});

// --- issue #88: a prompt's outcome events carry its client-generated identity ---

test("prompt outcome events echo the client's promptId and streamingBehavior", async () => {
  const wrapperSource = await readFile(wrapperUrl, "utf8");
  const sendSource = between(wrapperSource, "async send(", "private writeFrame(");
  const settleSource = between(wrapperSource, "private settlePrompt(", "// --------------------------------------------------------------------------");
  const successBlock = between(settleSource, "} else {", "notifyRunningChange();");
  const errorBlock = between(settleSource, "if (errorMessage !== undefined) {", "} else {");

  assert.match(sendSource, /const promptId = typeof command\.promptId === "string" && command\.promptId \? command\.promptId : undefined;/);
  assert.match(sendSource, /const promptEvent = \{\s*\.\.\.\(promptId \? \{ promptId \} : \{\}\),\s*\.\.\.\(streamingBehavior \? \{ streamingBehavior \} : \{\}\),\s*\};/);

  // A queued prompt (streamingBehavior) reports its own success, flagged as
  // such, instead of staying silent until the main turn ends: the success
  // path emits unconditionally, with no streamingBehavior gate.
  assert.match(successBlock, /this\.emit\(\{ type: "prompt_done", \.\.\.tracker\.promptEvent \}\);/);
  assert.doesNotMatch(successBlock, /if \(!tracker\.streamingBehavior\)/);

  // On failure both prompt kinds report prompt_error with their identity; only a
  // main prompt follows it with the prompt_done that settles its UI stage.
  assert.match(errorBlock, /this\.emit\(\{ type: "prompt_error", errorMessage, \.\.\.tracker\.promptEvent \}\);/);
  assert.match(errorBlock, /if \(!tracker\.streamingBehavior\) this\.emit\(\{ type: "prompt_done", \.\.\.tracker\.promptEvent \}\);/);
});

test("maybeAutoGenerateTitle composes the gate from the live session name, PI_NO_TITLE, and registered extension commands", async () => {
  const compatSource = await readFile(compatUrl, "utf8");
  const methodSource = between(compatSource, "async function maybeAutoGenerateTitle(", "function hostIsRunning()");

  assert.match(methodSource, /session\.extensionRunner\?\.getRegisteredCommands\(\) \?\? \[\]/);
  assert.match(methodSource, /shouldAutoGenerateTitle\(\{/);
  assert.match(methodSource, /hasSessionName: Boolean\(sessionManager\.getSessionName\(\)\)/);
  assert.match(methodSource, /piNoTitle: process\.env\.PI_NO_TITLE/);
  assert.match(methodSource, /extensionCommandNames: commandNames/);
  assert.match(methodSource, /if \(!eligible\) return;/);
});

test("maybeAutoGenerateTitle threads the triggering message into generateSessionTitle and re-checks the name before applying it", async () => {
  const compatSource = await readFile(compatUrl, "utf8");
  const methodSource = between(compatSource, "async function maybeAutoGenerateTitle(", "function hostIsRunning()");

  // The literal message that passed the gate drives generation — never a
  // history-derived lookup, which would re-target a stale first turn.
  assert.match(methodSource, /generateSessionTitle\(webSession, message\)/);
  // A concurrent manual "Generate title" click (or a second racing call)
  // must still win: re-check right before writing the name.
  assert.match(methodSource, /if \(sessionManager\.getSessionName\(\)\) return;/);
  assert.match(methodSource, /setSessionName\(result\.title, "auto"\)/);
});

test("a successful auto title invalidates the session cache and relays a session_renamed event carrying the session id", async () => {
  const compatSource = await readFile(compatUrl, "utf8");
  const wrapperSource = await readFile(wrapperUrl, "utf8");
  const methodSource = between(compatSource, "async function maybeAutoGenerateTitle(", "function hostIsRunning()");
  const frameSource = between(wrapperSource, "private handleFrame(", "private handleResponseFrame(");

  // Host emits the rename with the session id and refreshes its mirror...
  assert.match(methodSource, /type: "session_renamed", title: result\.title, sessionId: session\.sessionId/);
  assert.match(methodSource, /emitSessionInfo\(\);/);
  // ...and the WEB tier owns the process-local caches + running broadcast
  // (contract §3: cache invalidation stays web-side).
  assert.match(frameSource, /if \(type === "session_renamed" \|\| type === "session_info_update"\) invalidateSessionListCache\(\);/);
  assert.match(frameSource, /notifyRunningChange\(\);/);
  // Never surfaces to the client as a hard failure — a title-generation
  // hiccup must not break the turn the browser is already looking at.
  assert.match(methodSource, /catch \(error\) \{\s*\n\s*console\.error\("\[pi-web\] auto title generation failed:"/);
});
