import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { localizedToolName, localizedToolPreview, toolNameKey, LOCALIZED_TOOL_NAMES } = await jiti.import("./tool-name-i18n.ts");
const { translateMessage } = await jiti.import("./i18n/format.ts");
const { enLocale } = await jiti.import("./i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("./i18n/messages/zh-CN.ts");

const MESSAGES = { en: enLocale.messages, "zh-CN": zhCNLocale.messages };
const t = (locale) => (key, params) => translateMessage(locale, key, MESSAGES, params);

test("every localized tool id has an entry in both locales", () => {
  for (const name of LOCALIZED_TOOL_NAMES) {
    for (const locale of ["en", "zh-CN"]) {
      assert.equal(typeof MESSAGES[locale][`toolName.${name}`], "string", `${locale} missing toolName.${name}`);
    }
  }
});

test("the toolName.* and injection.source.* key sets match across locales", () => {
  const keys = (messages, prefix) => Object.keys(messages).filter((key) => key.startsWith(prefix)).sort();
  for (const prefix of ["toolName.", "injection.source."]) {
    assert.deepEqual(keys(MESSAGES["zh-CN"], prefix), keys(MESSAGES.en, prefix), `${prefix} key sets diverge`);
  }
});

test("the SDK builtin and hidden tool ids stay covered", async () => {
  const { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } = await jiti.import(
    "../node_modules/@oh-my-pi/pi-coding-agent/src/tools/builtin-names.ts",
  );
  for (const name of [...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]) {
    assert.ok(LOCALIZED_TOOL_NAMES.includes(name), `toolName.${name} is not localized`);
  }
});

test("chinese locale localizes tool ids and english keeps the raw id", () => {
  const zh = t("zh-CN");
  const en = t("en");
  assert.equal(localizedToolName("write", zh), "写入");
  assert.equal(localizedToolName("todo", zh), "待办列表");
  assert.equal(localizedToolName("web_search", zh), "联网搜索");
  assert.equal(localizedToolName("manage_skill", zh), "技能管理");
  assert.equal(localizedToolName("write", en), "write");
  assert.equal(localizedToolName("todo", en), "todo");
});

test("unknown and namespaced ids fall back or resolve by trailing segment", () => {
  const zh = t("zh-CN");
  assert.equal(localizedToolName("mcp__github_create_pull_request", zh), "mcp__github_create_pull_request");
  assert.equal(localizedToolName("plugin.write", zh), "写入");
  assert.equal(localizedToolName("mcp__server_read", zh), "读取");
  assert.equal(localizedToolName("bash (local)", zh), "命令行");
  assert.equal(localizedToolName("", zh), "");
  assert.equal(localizedToolName("   ", zh), "   ");
});

test("toolNameKey only maps canonical ids", () => {
  assert.equal(toolNameKey("write"), "toolName.write");
  assert.equal(toolNameKey("WRITE"), "toolName.write");
  assert.equal(toolNameKey("mcp__x_write"), null);
  assert.equal(toolNameKey(""), null);
});

test("outline previews localize each token and keep overflow markers", () => {
  const zh = t("zh-CN");
  assert.equal(localizedToolPreview("task, bash, +2 more", zh), "任务, 命令行, 另有 2 个");
  assert.equal(localizedToolPreview("write, … more", zh), "写入, … 更多");
  assert.equal(localizedToolPreview("mcp__x_custom, read", zh), "mcp__x_custom, 读取");
  assert.equal(localizedToolPreview("", zh), "");
});

test("subagent outline rows carry toolNames so their preview localizes", async () => {
  // #143: subagent rows are tool-only task spawns; without toolNames the row
  // face falls through to the raw "task"/"todo, task" preview.
  const { readSessionOutline, invalidateJournalIndex } = await jiti.import("./session-history.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "subagent-i18n-"));
  const file = join(dir, "s.jsonl");
  const rows = [
    { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", name: "task", arguments: {} }] } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  try {
    const outline = await readSessionOutline(file);
    const sub = outline.entries.find((e) => e.role === "subagent");
    assert.ok(sub, "subagent row exists");
    assert.deepEqual(sub.toolNames, ["task"], "subagent row carries the raw tool id list");
  } finally {
    invalidateJournalIndex(file);
    rmSync(dir, { recursive: true, force: true });
  }
});