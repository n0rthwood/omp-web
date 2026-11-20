import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { PlanReviewContent } = await jiti.import("./PlanReviewContent.tsx");
const { AskDrawer } = await jiti.import("./AskDrawer.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const request = {
  type: "extension_ui_request",
  id: "plan-markdown",
  method: "plan_review",
  title: "Rework the sorting pipeline",
  planFilePath: "/repo/docs/plans/sorting.md",
  planContent: [
    "# Migration plan",
    "",
    "Move the **existing** pipeline in stages:",
    "",
    "- Preserve the frozen wire payloads",
    "- Keep the transcript readable",
    "",
    "## Verification",
    "",
    "Run the regression suite before rollout.",
  ].join("\n"),
};

function renderContent(variant = "panel", nextRequest = request) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(PlanReviewContent, { request: nextRequest, onRespond: () => {}, variant, onClose: () => {} }),
    ),
  );
}

test("plan content renders full markdown", () => {
  const html = renderContent();
  assert.match(html, /<h1[^>]*>Migration plan<\/h1>/);
  assert.match(html, /<strong>existing<\/strong>/);
  assert.match(html, /<li>Preserve the frozen wire payloads<\/li>/);
  assert.match(html, /<li>Keep the transcript readable<\/li>/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("header shows the plan approval chip, title, and plan file path", () => {
  const html = renderContent();
  assert.match(html, /Plan approval/);
  assert.match(html, /Rework the sorting pipeline/);
  assert.match(html, /\/repo\/docs\/plans\/sorting\.md/);
});

test("refine and approve actions and the feedback textarea are present", () => {
  const html = renderContent();
  assert.match(html, /Continue planning/);
  assert.match(html, /Approve and implement/);
  assert.match(html, /<textarea[^>]*aria-label="Feedback for another planning pass \(optional\)"/);
});

test("only the drawer variant has the Hide button", () => {
  assert.match(renderContent("drawer"), /<button[^>]*aria-label="Hide"/);
  assert.doesNotMatch(renderContent("panel"), /aria-label="Hide"/);
});

test("the surface is a plain flex column, never a chat-covering overlay", () => {
  const html = renderContent();
  assert.match(html, /data-testid="plan-review-content"/);
  assert.match(html, /height:100%/);
  assert.doesNotMatch(html, /position:absolute|backdrop-filter|aria-modal="true"|inset:0/);
});

test("the mobile plan drawer is bounded and non-modal, and hiding retains its content", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AskDrawer, { request, open: false, onRespond: () => {}, onClose: () => {} }),
    ),
  );
  assert.match(html, /data-testid="plan-drawer" hidden=""/);
  assert.match(html, /position:fixed/);
  assert.match(html, /bottom:0/);
  assert.match(html, /z-index:400/);
  assert.match(html, /max-height:70dvh/);
  assert.match(html, /display:none/);
  assert.match(html, /<strong>existing<\/strong>/);
  assert.doesNotMatch(html, /aria-modal="true"|backdrop-filter|inset:0/);
});
