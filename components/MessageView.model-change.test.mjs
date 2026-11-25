import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { entryToUiMessage } = await jiti.import("../lib/session-reader.ts");

function renderEntry(entry) {
  const message = entryToUiMessage(entry, {});
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(MessageView, { message })),
  );
}

const modelChange = (extra) => ({
  type: "model_change",
  id: "m1",
  parentId: null,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 5)).toISOString(),
  model: "zhipu-coding-plan/glm-5.3",
  ...extra,
});

test("a journal model_change becomes a transcript system row", () => {
  const html = renderEntry(modelChange({ role: "default" }));
  assert.match(html, /data-testid="model-change-row"/);
  assert.match(html, /zhipu-coding-plan\/glm-5\.3/);
  assert.match(html, /data-fallback="false"/);
});

test("a retry fallback row is tinted and names the fallback role", () => {
  const html = renderEntry(modelChange({ role: "fallback", resolvedModelIsFallback: true }));
  assert.match(html, /data-fallback="true"/);
  assert.match(html, /fallback/);
  assert.match(html, /zhipu-coding-plan\/glm-5\.3/);
});

test("the SDK's resolvedModelIsFallback flag alone marks the row", () => {
  const html = renderEntry(modelChange({ resolvedModelIsFallback: true }));
  assert.match(html, /data-fallback="true"/);
});

test("a model_change without a selector renders nothing", () => {
  const entry = modelChange({});
  delete entry.model;
  assert.equal(entryToUiMessage(entry, {}), null);
});