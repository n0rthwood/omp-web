import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ExtensionDialog } = await jiti.import("./ChatWindow.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderDialog(request, onRespond = () => {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionDialog, { request, onRespond }),
    ),
  );
}

// Captured verbatim from the real incident (session 01a0f779 on joysort202):
// AgentSession#confirmCodexAutoRedeem sends {label, description} option objects.
const codexResetRequest = {
  type: "extension_ui_request",
  id: "select-codex-reset",
  method: "select",
  title: "Spend a saved Codex rate-limit reset?",
  options: [
    { label: "Yes", description: "Redeem now and remember yes for future eligible Codex resets." },
    { label: "No", description: "Do not auto-redeem saved Codex resets." },
  ],
};

test("renders select options that carry label/description objects without throwing", () => {
  const html = renderDialog(codexResetRequest);
  assert.match(html, />Yes</);
  assert.match(html, /Redeem now and remember yes for future eligible Codex resets\./);
  assert.match(html, />No</);
  assert.match(html, /Do not auto-redeem saved Codex resets\./);
});

test("still renders plain-string select options", () => {
  const html = renderDialog({
    type: "extension_ui_request",
    id: "select-plain",
    method: "select",
    title: "Pick one",
    options: ["Alpha", "Beta"],
  });
  assert.match(html, />Alpha</);
  assert.match(html, />Beta</);
});
