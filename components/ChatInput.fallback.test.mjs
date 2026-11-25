import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ChatInput, FallbackBanner } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const APPLIED = {
  from: "anthropic/claude-fable-5",
  to: "zhipu-coding-plan/glm-5.3",
  role: "fallback",
  reason: "credential rejected",
  succeeded: false,
  runId: 1,
};

function renderBanner(info) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(FallbackBanner, { info })),
  );
}

function renderInput(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelList: [],
        modelNames: {},
        ...props,
      }),
    ),
  );
}

test("the degrade banner names both models, the role and the reason", () => {
  const html = renderBanner(APPLIED);
  assert.match(html, /data-testid="fallback-banner"/);
  assert.match(html, /anthropic\/claude-fable-5/);
  assert.match(html, /zhipu-coding-plan\/glm-5\.3/);
  assert.match(html, /fallback/);
  assert.match(html, /credential rejected/);
});

test("a succeeded fallback reads as answered, not as a pending degrade", () => {
  const html = renderBanner({ ...APPLIED, succeeded: true });
  assert.match(html, /zhipu-coding-plan\/glm-5\.3/);
  assert.doesNotMatch(html, /→/);
});

test("a missed applied frame degrades to a single-model line", () => {
  const html = renderBanner({ from: "", to: "zhipu-coding-plan/glm-5.3", role: "fallback", succeeded: false, runId: 2 });
  assert.match(html, /zhipu-coding-plan\/glm-5\.3/);
  assert.doesNotMatch(html, /→/);
});

test("the composer renders the shelf only while a fallback is in flight", () => {
  assert.doesNotMatch(renderInput({}), /data-testid="fallback-banner"/);
  assert.match(renderInput({ fallbackInfo: APPLIED }), /data-testid="fallback-banner"/);
});

test("the same-model auto-retry banner is unchanged and coexists with the shelf", () => {
  const retryOnly = renderInput({ retryInfo: { attempt: 2, maxAttempts: 5, errorMessage: "429" } });
  assert.match(retryOnly, /Retrying \(2\/5\)/);
  assert.doesNotMatch(retryOnly, /data-testid="fallback-banner"/);

  const both = renderInput({ retryInfo: { attempt: 1, maxAttempts: 3 }, fallbackInfo: APPLIED });
  assert.match(both, /Retrying \(1\/3\)/);
  assert.match(both, /data-testid="fallback-banner"/);
});