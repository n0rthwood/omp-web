// Fallback chain editor (issue #140); empty-state wording from #145: the mockup
// states the consequence of having no fallback instead of "no backups".
// Individually runnable: bun test components/models-config/FallbackChainEditor.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { FallbackChainEditor } = await jiti.import("./FallbackChainEditor.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
const { enLocale } = await jiti.import("../../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../../lib/i18n/messages/zh-CN.ts");
const { translateMessage } = await jiti.import("../../lib/i18n/format.ts");

function render(chain) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(FallbackChainEditor, {
        chain,
        models: [],
        inherited: false,
        roleLabel: "default",
        onChange: () => {},
      }),
    ),
  );
}

test("an empty chain states the consequence: a failed request is an error", () => {
  assert.match(render([]), /No fallback — a failed request errors out/);
});

test("the empty state is gone as soon as the chain has a node", () => {
  const html = render(["zhipu-coding-plan/glm-5.3"]);
  assert.doesNotMatch(html, /No fallback/);
  assert.match(html, /zhipu-coding-plan\/glm-5\.3/);
});

test("the empty state says the same thing in Chinese", () => {
  assert.equal(enLocale.messages["roles.backupsNone"], "No fallback — a failed request errors out");
  assert.equal(zhCNLocale.messages["roles.backupsNone"], "无降级 — 失败即报错");
  assert.equal(
    translateMessage("zh-CN", "roles.backupsNone", { "zh-CN": zhCNLocale.messages }),
    "无降级 — 失败即报错",
  );
});
