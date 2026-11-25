// Refresh-diff panel (issue #140); header badge + timestamp from #145.
// Individually runnable: bun test components/models-config/RefreshDiffPanel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { RefreshDiffPanel } = await jiti.import("./RefreshDiffPanel.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");

function render(state, providerName = "openai-codex") {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(RefreshDiffPanel, { state, providerName })),
  );
}

test("idle, and a result for another provider, render nothing", () => {
  assert.equal(render({ phase: "idle" }), "");
  assert.equal(render({ phase: "loading", providerName: "zai" }), "");
  assert.equal(render({ phase: "success", providerName: "zai" }), "");
});

test("a running refresh and a failed one keep their bare status", () => {
  assert.match(render({ phase: "loading", providerName: "openai-codex" }), /Refreshing models…/);
  const failed = render({ phase: "error", providerName: "openai-codex", message: "boom" });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /boom/);
  assert.doesNotMatch(failed, /Catalog cache updated/);
});

test("a finished refresh carries the catalog-updated badge and the time it finished", () => {
  const finishedAt = new Date();
  finishedAt.setHours(22, 4, 13, 0);
  const html = render({ phase: "success", providerName: "openai-codex", diff: { added: [], removed: [], changed: [] }, completedAt: finishedAt.getTime() });
  assert.match(html, /Refresh result/);
  assert.match(html, /Catalog cache updated/);
  assert.equal(
    html.match(/data-testid="refresh-diff-time"[^>]*>([^<]*)</)[1],
    finishedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  );
  assert.match(html, /No change \(0 added \/ 0 removed \/ 0 changed\)\./);
});

test("the badge shows even when the caller did not stamp a completion time", () => {
  const html = render({ phase: "success", providerName: "openai-codex" });
  assert.match(html, /Catalog cache updated/);
  assert.doesNotMatch(html, /refresh-diff-time/);
});
