import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AskDialogContent, buildAskDiscussion } = await jiti.import("./AskDialogContent.tsx");
const { AskDrawer } = await jiti.import("./AskDrawer.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const request = {
  type: "extension_ui_request",
  id: "ask-markdown",
  method: "ask",
  questions: [{
    id: "q1",
    header: "Implementation",
    question: "Choose **carefully**:\n\n- Preserve the existing API\n- Keep the transcript readable",
    options: [
      { label: "Recommended option", description: "Use the **existing** API.", preview: "The first preview." },
      { label: "Other option", description: "Another description.", preview: "Unselected **preview** stays visible.\n\n- Read this before choosing" },
    ],
    recommended: 0,
  }],
};

function renderContent(variant = "panel", nextRequest = request) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AskDialogContent, {
        request: nextRequest,
        variant,
        onRespond: () => {},
        onClose: () => {},
      }),
    ),
  );
}

test("ask questions and option descriptions render full markdown", () => {
  const html = renderContent();
  assert.match(html, /<strong>carefully<\/strong>/);
  assert.match(html, /<li>Preserve the existing API<\/li>/);
  assert.match(html, /<li>Keep the transcript readable<\/li>/);
  assert.match(html, /<strong>existing<\/strong>/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("unselected option previews are always visible and render markdown", () => {
  const html = renderContent();
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /Unselected <strong>preview<\/strong> stays visible\./);
  assert.match(html, /<li>Read this before choosing<\/li>/);
});

test("only the drawer variant has the Hide button", () => {
  assert.match(renderContent("drawer"), /<button[^>]*aria-label="Hide"/);
  assert.doesNotMatch(renderContent("panel"), /aria-label="Hide"/);
});

test("recommended options start selected and permit submission", () => {
  const html = renderContent();
  assert.match(html, /<div[^>]*role="radio"[^>]*tabindex="0"[^>]*aria-checked="true"/);
  assert.match(html, /Recommended option/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""/);
  assert.match(html, /<textarea rows="2"/);
  assert.doesNotMatch(html, /<button[^>]*role="radio"/);
});

test("unanswered questions do not permit submission and invalid recommendations are ignored", () => {
  const html = renderContent("panel", {
    ...request,
    questions: [{ ...request.questions[0], recommended: 20 }],
  });
  assert.doesNotMatch(html, /aria-checked="true"/);
  assert.match(html, /<button[^>]*disabled=""/);
});

test("multi-select options use checkbox roles", () => {
  const html = renderContent("panel", {
    ...request,
    questions: [{ ...request.questions[0], multi: true }],
  });
  assert.match(html, /role="group"/);
  assert.match(html, /<div[^>]*role="checkbox"[^>]*tabindex="0"[^>]*aria-checked="true"/);
});

test("the mobile drawer is bounded and non-modal, and hiding retains its content", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AskDrawer, { request, open: false, onRespond: () => {}, onClose: () => {} }),
    ),
  );
  assert.match(html, /data-testid="ask-drawer" hidden=""/);
  assert.match(html, /position:fixed/);
  assert.match(html, /bottom:0/);
  assert.match(html, /z-index:400/);
  assert.match(html, /max-height:70dvh/);
  assert.match(html, /display:none/);
  assert.match(html, /<strong>carefully<\/strong>/);
  assert.doesNotMatch(html, /aria-modal="true"|backdrop-filter|inset:0/);
});

test("chat discussion preserves trimmed Chinese rejection text without selecting the recommendation", () => {
  assert.deepEqual(buildAskDiscussion(request, {
    q1: " \n我不同意这个推荐方案。\n请先解释为什么不能保留现有接口。 \t",
  }), {
    kind: "chat",
    discussion: [{ id: "q1", text: "我不同意这个推荐方案。\n请先解释为什么不能保留现有接口。" }],
  });
});

test("empty and whitespace-only chat discussion retain the exact legacy payload", () => {
  for (const answers of [{}, { q1: "" }, { q1: " \t\r\n　" }, { unknown: "Do not send this" }]) {
    assert.deepEqual(buildAskDiscussion(request, answers), { kind: "chat" });
  }
});

test("chat discussion includes only the filled second question and ignores unknown ids", () => {
  const twoQuestions = {
    ...request,
    questions: [...request.questions, { ...request.questions[0], id: "q2" }],
  };
  assert.deepEqual(buildAskDiscussion(twoQuestions, {
    q1: " \n",
    q2: "  先讨论第二个问题  ",
    unknown: "Never include this answer",
  }), {
    kind: "chat",
    discussion: [{ id: "q2", text: "先讨论第二个问题" }],
  });
});

test("chat discussion follows question order rather than answer property order", () => {
  const twoQuestions = {
    ...request,
    questions: [...request.questions, { ...request.questions[0], id: "q2" }],
  };
  assert.deepEqual(buildAskDiscussion(twoQuestions, {
    q2: " second ",
    unknown: "ignored",
    q1: " first ",
  }), {
    kind: "chat",
    discussion: [{ id: "q1", text: "first" }, { id: "q2", text: "second" }],
  });
});
