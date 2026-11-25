import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { SubagentDetail } = await import("./SubagentDetail.tsx");
const { I18nProvider } = await import("../hooks/useI18n.tsx");
const { enLocale } = await import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await import("../lib/i18n/messages/zh-CN.ts");

const source = await readFile(new URL("./SubagentDetail.tsx", import.meta.url), "utf8");

function snapshot(overrides = {}) {
  return {
    id: "ScoutSdkUsage",
    index: 0,
    agent: "scout",
    agentSource: "bundled",
    status: "running",
    lastUpdate: 1,
    progress: {
      index: 0,
      id: "ScoutSdkUsage",
      agent: "scout",
      status: "running",
      task: "map the repo",
      recentTools: [],
      recentOutput: [],
      toolCount: 3,
      requests: 1,
      tokens: 120,
      cost: 0,
      durationMs: 65000,
      resolvedModel: "anthropic/claude-opus-5",
    },
    ...overrides,
  };
}

function renderDetail(props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SubagentDetail, {
      sessionId: "session-1", subagent: snapshot(), onBack() {}, ...props,
    }),
  ));
}

test("renders the subagent header, progress strip and transcript placeholder", () => {
  const html = renderDetail();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Subagent execution details"/);
  assert.match(html, />ScoutSdkUsage</);
  assert.match(html, />scout</);
  assert.match(html, />Running</);
  assert.match(html, />1m 05s</);
  assert.match(html, />3 tools</);
  assert.match(html, />120 tokens</);
  assert.match(html, />anthropic\/claude-opus-5</);
  assert.match(html, /Loading live transcript…/);
});

test("finished subagents render the finished activity and zeroed progress", () => {
  const html = renderDetail({ subagent: snapshot({ status: "completed", progress: { ...snapshot().progress, status: "completed", durationMs: 2000, toolCount: 0, tokens: 0 } }) });
  assert.match(html, />Finished</);
  assert.match(html, />2s</);
  assert.match(html, />0 tools</);
});

test("locate-in-chat action renders only when the outline supplies a handler", () => {
  const without = renderDetail();
  assert.doesNotMatch(without, /data-testid="subagent-locate-in-chat"/);
  const withHandler = renderDetail({ onLocateInChat() {} });
  assert.match(withHandler, /data-testid="subagent-locate-in-chat"/);
  assert.match(withHandler, /aria-label="Locate in chat"/);
});

test("keeps the byte-incremental transcript contract from the old panel", () => {
  assert.match(source, /type: "get_subagent_messages"/);
  assert.match(source, /subagentId: subagent\.id/);
  assert.match(source, /fromByte: nextByte/);
  assert.match(source, /active \? setInterval/);
  assert.match(source, /scrollTop = transcript\.scrollHeight/);
  assert.match(source, /event\.key === "Escape"\) onBack\(\)/);
  assert.match(source, /subagents\.transcriptUnavailable/);
});

test("the standalone panel shell is gone", () => {
  assert.doesNotMatch(source, /subagent-panel/);
  assert.doesNotMatch(source, /SubagentRow/);
  assert.doesNotMatch(source, /subagents\.history/);
  assert.doesNotMatch(source, /subagents\.runningCount/);
});

test("all built-in locales translate the locate-in-chat label", () => {
  assert.equal(enLocale.messages["subagents.locateInChat"], "Locate in chat");
  assert.equal(zhCNLocale.messages["subagents.locateInChat"], "在会话中定位");
  assert.equal(enLocale.messages["subagents.back"], "Back to outline");
  assert.equal(zhCNLocale.messages["subagents.back"], "返回大纲");
});