// Bug B regression: assistant narration/thinking must render flat (visible
// without expanding anything); only toolResult bodies stay folded.
// Runs the REAL ChatWindow render loop against a stubbed useAgentSession via
// renderToStaticMarkup. The mock is transparent: when no fixture is active it
// delegates to the real hook, so other test files in the same bun run are
// unaffected by the module mock.
import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = { active: false, messages: [], entryIds: [], outline: [], historyHasEarlier: false, historyBrowsing: false };
const realHookModule = await import("../hooks/useAgentSession.ts");
mock.module("@/hooks/useAgentSession", () => ({
  ...realHookModule,
  useAgentSession: (opts) => {
    if (!fixture.active) return realHookModule.useAgentSession(opts);
    return {
      loading: false, error: null, refreshError: null,
      data: { messages: fixture.messages }, messages: fixture.messages, entryIds: fixture.entryIds,
      streamState: { isStreaming: false, streamingMessage: null },
      agentRunning: false, bashRunning: false, pendingBash: null,
      modelNames: {}, modelList: [], modelError: null, modelScopeWarnings: [], hiddenModelCount: 0,
      modelThinkingLevels: {}, modelThinkingLevelMaps: {}, modelRoles: [], toolPreset: null, thinkingLevel: null,
      retryInfo: null, contextUsage: null, tokensPerSecond: null, forkingEntryId: null,
      isCompacting: false, compactError: null, compactResult: null, displayModel: null, modelSwitching: false, sessionStats: null,
      slashCommands: [], slashCommandsLoading: false, queuedMessages: null, subagents: [], planMode: null,
      notices: [], extensionDialog: null, extensionCustomUi: null, extensionStatuses: [], extensionWidgets: [],
      respondToExtensionUi: () => {}, sendExtensionCustomInput: () => {},
      isAutoModelSelection: false, agentPhase: null, isNew: false,
      historyHasEarlier: fixture.historyHasEarlier, historyLoading: false, handleLoadEarlier: async () => {},
      sessionIdRef: { current: "sess-fold-test" }, scrollContainerRef: { current: null }, scrollContentRef: { current: null },
      autoFollow: true, toggleAutoFollow: () => {},
      outline: fixture.outline, outlineLoading: false, outlineError: null, loadOutline: async () => {},
      historyBrowsing: fixture.historyBrowsing, historyTargetEntryId: null, historyNavigationLoading: false, historyNavigationError: null,
      handleJumpToEntry: async () => {}, handleReturnToLatest: async () => {}, cancelHistoryNavigation: () => {},
      handleSend: () => {}, handleAbort: () => {}, handleFork: () => {}, handleNavigate: () => {},
      handleModelChange: () => {}, handleRoleModelChange: () => {},
      handleCompact: () => {}, handleSteer: () => {}, handleFollowUp: () => {}, handlePromptWithStreamingBehavior: () => {},
      handleAbortCompaction: () => {}, handleRecallQueue: () => {}, handleBuiltinSlashCommand: () => {}, handleSetPlanMode: () => {},
      handleToolPresetChange: () => {}, handleThinkingLevelChange: () => {}, loadSlashCommands: async () => {}, uploadSessionFiles: async () => ({}),
    };
  },
}));


const { ChatWindow } = await import("./ChatWindow.tsx");
const { MessageView } = await import("./MessageView.tsx");
const { SessionOutline } = await import("./SessionOutline.tsx");
const { I18nProvider } = await import("../hooks/useI18n.tsx");

function renderChat() {
  fixture.active = true;
  try {
    return renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(ChatWindow, { session: { id: "s-fold", cwd: "/tmp" }, newSessionCwd: null }),
      ),
    );
  } finally {
    fixture.active = false;
  }
}

// The exact block shape measured on journal 01a202cd: a stop=toolUse assistant
// message whose narration sits between thinking and two tool calls.
const NARRATION = "代码层面已定位到问题根源 NARRATION-MARKER";
const THINKING = "THINKING-MARKER reasoning about the root cause";
const READ_RESULT = "READ-RESULT-MARKER file body line one\nline two";
const GREP_RESULT = "GREP-RESULT-MARKER matched line";
const FINAL_ANSWER = "FINAL-ANSWER-MARKER conclusion";

function toolUseAssistant() {
  return {
    role: "assistant", provider: "test", model: "m", stopReason: "toolUse", timestamp: 1_700_000_001_000,
    content: [
      { type: "thinking", thinking: THINKING },
      { type: "text", text: NARRATION },
      { type: "toolCall", toolCallId: "c1", toolName: "read", input: { path: "lib/history-window.ts" } },
      { type: "toolCall", toolCallId: "c2", toolName: "grep", input: { pattern: "upsert" } },
    ],
  };
}

function baseTurn() {
  return [
    { role: "user", content: "question one", timestamp: 1_700_000_000_000 },
    toolUseAssistant(),
    { role: "toolResult", toolCallId: "c1", toolName: "read", timestamp: 1_700_000_002_000, content: [{ type: "text", text: READ_RESULT }], isError: false },
    { role: "toolResult", toolCallId: "c2", toolName: "grep", timestamp: 1_700_000_003_000, content: [{ type: "text", text: GREP_RESULT }], isError: false },
    { role: "assistant", provider: "test", model: "m", stopReason: "stop", timestamp: 1_700_000_004_000, content: [{ type: "text", text: FINAL_ANSWER }] },
  ];
}

function entryIdsFor(messages) {
  return messages.map((_, i) => `entry-${i}`);
}

function anchorIds(html) {
  return [...html.matchAll(/data-entry-id="([^"]+)"/g)].map((m) => m[1]);
}

test("narration and thinking of a toolUse turn render without expanding anything", () => {
  fixture.messages = baseTurn();
  fixture.entryIds = entryIdsFor(fixture.messages);
  fixture.outline = [];
  const html = renderChat();
  assert.ok(html.includes(NARRATION), "narration text must be visible in the flat transcript");
  assert.ok(html.includes(THINKING), "thinking text must stay visible");
  assert.ok(html.includes(FINAL_ANSWER), "final answer still renders");
  assert.ok(!html.includes("Process details"), "assistant messages must not sit inside a collapsed process group");
});

test("toolResult bodies stay folded but discoverable, and reveal when expanded", () => {
  fixture.messages = baseTurn();
  fixture.entryIds = entryIdsFor(fixture.messages);
  fixture.outline = [];
  const html = renderChat();
  // Presence discoverable via the tool call headers…
  assert.ok(html.includes("read"), "read tool call header present");
  assert.ok(html.includes("grep"), "grep tool call header present");
  // …but bodies only render once the tool call is expanded.
  assert.ok(!html.includes(READ_RESULT), "read result body must be folded initially");
  assert.ok(!html.includes(GREP_RESULT), "grep result body must be folded initially");
  assert.ok(html.includes('aria-expanded="false"'), "tool calls render collapsed by default");

  // Prove the SAME ToolCallBlock reveals the body when expanded. A non-edit
  // tool starts collapsed (body hidden); an edit tool starts expanded
  // (useState(isEditTool) === true) and renders the identical
  // `{expanded && result && …}` branch, so its body is present. This exercises
  // the real fold/expand code path, not a mock.
  const renderPaired = (toolName, resultText) => renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, {
        message: {
          role: "assistant", provider: "test", model: "m", stopReason: "toolUse",
          content: [{ type: "toolCall", toolCallId: "cx", toolName, input: { path: "f.ts" } }],
        },
        toolResults: new Map([["cx", { role: "toolResult", toolCallId: "cx", toolName, content: [{ type: "text", text: resultText }], isError: false }]]),
      }),
    ),
  );
  const collapsed = renderPaired("read", READ_RESULT);
  assert.ok(!collapsed.includes(READ_RESULT), "collapsed tool call hides its result body");
  assert.ok(collapsed.includes('aria-expanded="false"'));
  const expanded = renderPaired("edit", READ_RESULT);
  assert.ok(expanded.includes(READ_RESULT), "expanded tool call reveals its result body");
  assert.ok(expanded.includes('aria-expanded="true"'));
});

test("every outline entry keeps a data-entry-id target (jump affordance intact)", () => {
  const messages = baseTurn();
  fixture.messages = messages;
  fixture.entryIds = entryIdsFor(messages);
  fixture.outline = [
    { entryId: "entry-0", role: "user", preview: "question one", timestamp: "1700000000000", ordinal: 0 },
    { entryId: "entry-1", role: "assistant", preview: "read, grep", timestamp: "1700000001000", ordinal: 1 },
    { entryId: "entry-4", role: "assistant", preview: FINAL_ANSWER, timestamp: "1700000004000", ordinal: 4 },
  ];
  const html = renderChat();
  const ids = anchorIds(html);
  for (const entry of fixture.outline) {
    assert.ok(ids.includes(entry.entryId), `outline entry ${entry.entryId} must have a DOM anchor`);
  }
  // The outline rail only mounts at container width >= 1000px (ResizeObserver,
  // absent in SSR) — render it directly with the same entries and prove every
  // listed row targets an anchor that exists in the transcript DOM.
  const outlineHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SessionOutline, {
        variant: "rail", entries: fixture.outline, loading: false, error: null,
        onRetryLoad: () => {}, readingEntryId: null, targetEntryId: null,
        navigating: false, onJump: () => {}, onClose: () => {},
      }),
    ),
  );
  const listedIds = [...outlineHtml.matchAll(/data-outline-entry="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listedIds.sort(), fixture.outline.map((e) => e.entryId).sort(), "outline lists every entry");
  for (const id of listedIds) {
    assert.ok(ids.includes(id), `outline row ${id} must resolve to a transcript anchor`);
  }
});

test("lazy window: only the tail entries present still renders narration flat", () => {
  // Simulate a window that starts mid-turn: earlier user page not loaded.
  const full = baseTurn();
  const tail = full.slice(1); // assistant + results + final answer, no user anchor
  fixture.messages = tail;
  fixture.entryIds = entryIdsFor(tail);
  fixture.historyHasEarlier = true;
  fixture.outline = [];
  const html = renderChat();
  fixture.historyHasEarlier = false;
  assert.ok(html.includes(NARRATION), "narration visible even without the user anchor loaded");
  assert.ok(html.includes(THINKING));
  assert.ok(html.includes('data-testid="load-earlier"'), "Load earlier button still offered");
  assert.ok(!html.includes("Process details"));
});

test("stopped-answer mid turn keeps its answer visible and flat", () => {
  const messages = [
    { role: "user", content: "question one", timestamp: 1_700_000_000_000 },
    toolUseAssistant(),
    { role: "toolResult", toolCallId: "c1", toolName: "read", timestamp: 1_700_000_002_000, content: [{ type: "text", text: READ_RESULT }], isError: false },
    { role: "toolResult", toolCallId: "c2", toolName: "grep", timestamp: 1_700_000_003_000, content: [{ type: "text", text: GREP_RESULT }], isError: false },
    { role: "assistant", provider: "test", model: "m", stopReason: "stop", timestamp: 1_700_000_004_000, content: [{ type: "text", text: "STOPPED-RECAP-MARKER" }] },
    { role: "assistant", provider: "test", model: "m", stopReason: "stop", timestamp: 1_700_000_005_000, content: [{ type: "text", text: FINAL_ANSWER }] },
  ];
  fixture.messages = messages;
  fixture.entryIds = entryIdsFor(messages);
  fixture.outline = [];
  const html = renderChat();
  assert.ok(html.includes("STOPPED-RECAP-MARKER"), "stopped answer stays visible");
  assert.ok(html.includes(NARRATION));
  assert.ok(html.includes(FINAL_ANSWER));
});

test("empty assistant entries keep an anchored marker; fileMention stays visible", () => {
  const messages = [
    { role: "user", content: "question one", timestamp: 1_700_000_000_000 },
    { role: "fileMention", files: [{ path: "notes.md", content: "FILEMENTION-MARKER" }] },
    { role: "assistant", provider: "test", model: "m", stopReason: "stop", timestamp: 1_700_000_002_000, content: [] },
    { role: "assistant", provider: "test", model: "m", stopReason: "stop", timestamp: 1_700_000_003_000, content: [{ type: "text", text: FINAL_ANSWER }] },
  ];
  fixture.messages = messages;
  fixture.entryIds = entryIdsFor(messages);
  fixture.outline = [
    { entryId: "entry-2", role: "assistant", preview: "(empty)", timestamp: "1700000002000", ordinal: 2 },
    { entryId: "entry-3", role: "assistant", preview: FINAL_ANSWER, timestamp: "1700000003000", ordinal: 3 },
  ];
  const html = renderChat();
  const ids = anchorIds(html);
  assert.ok(ids.includes("entry-2"), "empty assistant still anchored for outline seeks");
  assert.ok(ids.includes("entry-3"));
  assert.ok(html.includes("FILEMENTION-MARKER") || html.includes("notes.md"), "fileMention renders beside the prompt");
});
