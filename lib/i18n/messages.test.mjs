// #146: the settings dialog frame (Settings / Models / Themes / …) must have a
// zh-CN entry for every en key, so the frame is never left English.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { enLocale } = await jiti.import("./messages/en.ts");
const { zhCNLocale } = await jiti.import("./messages/zh-CN.ts");

const keys = (messages, prefix) => Object.keys(messages).filter((key) => key.startsWith(prefix)).sort();

test("settings.* key sets match across locales", () => {
  assert.deepEqual(keys(zhCNLocale.messages, "settings."), keys(enLocale.messages, "settings."));
});

test("the frame words are translated", () => {
  const zh = zhCNLocale.messages;
  assert.equal(zh["settings.title"], "设置");
  assert.equal(zh["settings.sectionModels"], "模型");
  assert.equal(zh["settings.sectionThemes"], "主题");
  assert.equal(zh["settings.sectionPrompts"], "提示词");
  assert.equal(zh["settings.close"], "关闭设置");
  assert.equal(zh["settings.configuration"], "配置");
  assert.ok(!JSON.stringify(zh).includes('"Models"'));
});