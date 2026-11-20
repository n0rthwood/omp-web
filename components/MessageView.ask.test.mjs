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
const { SessionOutline } = await jiti.import("./SessionOutline.tsx");

const questions = [{
  id: "database",
  question: "Choose **storage**\n\n- durable\n- shared",
  recommended: 1,
  options: [{ label: "SQLite" }, { label: "Postgres", description: "Supports **concurrency**" }],
}];

function renderAsk({ input = { questions }, details, text = "User answers:\ndatabase: Postgres", isError = false, pending = false, images = [] } = {}) {
  const message = {
    role: "assistant", provider: "test", model: "test-model",
    content: [{ type: "toolCall", toolCallId: "ask-1", toolName: "ask", input }],
  };
  const result = {
    role: "toolResult", toolCallId: "ask-1", toolName: "ask", isError,
    details, content: [{ type: "text", text }, ...images],
  };
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, { message, toolResults: pending ? new Map() : new Map([["ask-1", result]]) }),
  ));
}

test("ask transcript defaults expanded with markdown questions, descriptions and selected answers", () => {
  const html = renderAsk({ details: { results: [{ id: "database", selectedOptions: ["Postgres"], customInput: "Use the shared instance\nand keep backups" }] } });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<strong>storage<\/strong>/);
  assert.match(html, /<li>durable<\/li>/);
  assert.match(html, /<strong>concurrency<\/strong>/);
  assert.match(html, /Recommended/);
  assert.match(html, /✓ /);
  assert.match(html, /Postgres/);
  assert.match(html, /<blockquote[^>]*>Use the shared instance\nand keep backups<\/blockquote>/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("single-question top-level details show the selected option", () => {
  const html = renderAsk({ details: { question: questions[0].question, options: ["SQLite", "Postgres"], selectedOptions: ["SQLite"] } });
  assert.match(html, /✓ <\/span>SQLite/);
});

test("multiple answers align by question id rather than result order", () => {
  const html = renderAsk({
    input: { questions: [...questions, { id: "region", question: "Choose region", options: [{ label: "Europe" }] }] },
    details: { results: [{ id: "region", selectedOptions: ["Europe"] }, { id: "database", selectedOptions: ["SQLite"] }] },
  });
  const sections = html.match(/<section[\s\S]*?<\/section>/g);
  assert.equal(sections.length, 2);
  assert.match(sections[0], /✓ <\/span>SQLite/);
  assert.doesNotMatch(sections[0], /Europe/);
  assert.match(sections[1], /✓ <\/span>Europe/);
});

test("missing or malformed details fall back to markdown result text", () => {
  for (const details of [undefined, {}, { results: [null] }, { selectedOptions: [42] }]) {
    const html = renderAsk({ details, text: "User answers:\n\n**Postgres**" });
    assert.match(html, /User answers:/);
    assert.match(html, /<strong>Postgres<\/strong>/);
  }
});

test("chat redirects show the chat-about-this status", () => {
  const html = renderAsk({ details: { chatRedirect: true, questions: [questions[0].question] }, text: "not the fallback" });
  assert.match(html, /Chat about this/);
  assert.doesNotMatch(html, /not the fallback/);
});

test("pending ask displays questions and the waiting hint", () => {
  const html = renderAsk({ pending: true });
  assert.match(html, /<strong>storage<\/strong>/);
  assert.match(html, /Choose an option or provide a custom response/);
  assert.doesNotMatch(html, /✓/);
});

test("ask cancellation uses the existing red result style and preserves result images", () => {
  const html = renderAsk({ isError: true, text: "Ask input was cancelled", images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
  assert.match(html, /color:#f87171/);
  assert.match(html, /Ask input was cancelled/);
  assert.match(html, /src="data:image\/png;base64,aGVsbG8="/);
});

test("malformed question entries are ignored and header previews are bounded", () => {
  const html = renderAsk({ input: { questions: [null, 7, { question: "Valid", options: [] }] }, pending: true });
  assert.match(html, /Valid/);
  assert.doesNotMatch(html, /\[object Object\]/);
  const long = renderAsk({ input: { questions: [{ question: "a".repeat(121), options: [] }] }, pending: true });
  assert.match(long, new RegExp(">" + "a".repeat(120) + "</span>"));
});

test("ask outline rows render an answer label and accent question glyph", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SessionOutline, {
      entries: [{ entryId: "answer", role: "ask", preview: "Postgres", ordinal: 2, timestamp: "2026-01-01T00:00:00Z" }],
      loading: false, error: null, onRetryLoad() {}, readingEntryId: null, targetEntryId: null,
      navigating: false, onJump() {}, variant: "rail", onClose() {},
    }),
  ));
  assert.match(html, /Answer/);
  assert.match(html, /color:var\(--accent\)/);
  assert.match(html, />\?<\/span>/);
});
