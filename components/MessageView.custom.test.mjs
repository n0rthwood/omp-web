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

const GEAR_PATH_D = "M5.1 1.2h1.8l.3 1.4a3.5 3.5 0 0 1 1.2.7l1.4-.5.9 1.6-1.1 1a3.5 3.5 0 0 1 0 1.4l1.1 1-.9 1.6-1.4-.5a3.5 3.5 0 0 1-1.2.7l-.3 1.4H5.1l-.3-1.4a3.5 3.5 0 0 1-1.2-.7l-1.4.5-.9-1.6 1.1-1a3.5 3.5 0 0 1 0-1.4l-1.1-1 .9-1.6 1.4.5a3.5 3.5 0 0 1 1.2-.7l.3-1.4Z";

function renderCustom({ customType, display, text = "injected system content", details }) {
  const message = {
    role: "custom",
    customType,
    display,
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, { message }),
  ));
}

test("eager-task-prelude renders the teal system gear and teal title identity", () => {
  const html = renderCustom({ customType: "eager-task-prelude", display: false });
  assert.match(html, /<svg[^>]*stroke="#0d9488"[^>]*aria-hidden="true"/);
  assert.ok(html.includes(`d="${GEAR_PATH_D}"`));
  assert.match(html, /<circle cx="6" cy="6" r="1.6"/);
  assert.match(html, />Eager task-delegation prelude</);
  assert.match(html, /color:#0d9488/);
  assert.ok(html.includes("color-mix(in srgb, #0d9488 35%, var(--border))"));
  assert.match(html, /hidden extension message/);
});

test("mid-run-todo-nudge keeps the plain hidden-extension rendering without teal marker", () => {
  const html = renderCustom({ customType: "mid-run-todo-nudge", display: false });
  assert.doesNotMatch(html, /#0d9488/);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, />Todo progress nudge</);
  assert.match(html, /hidden extension message/);
  assert.match(html, /border:1px solid var\(--border\)/);
});

test("async-result keeps prior rendering with no gear and default expanded content", () => {
  const html = renderCustom({ customType: "async-result", text: "Subagent finished the task" });
  assert.doesNotMatch(html, /#0d9488/);
  assert.ok(!html.includes(GEAR_PATH_D));
  assert.match(html, />Background job result</);
  assert.match(html, /Subagent finished the task/);
  assert.match(html, /border:1px solid var\(--border\)/);
});

test("unknown and empty custom types fall back to the raw id and the extension label", () => {
  const unknown = renderCustom({ customType: "my-plugin-notice", display: false });
  assert.match(unknown, />my-plugin-notice</);
  const empty = renderCustom({ customType: "", display: false });
  assert.match(empty, />Extension</);
});

const IRC_BODY = [
  "<irc>",
  "Incoming IRC message from agent `scout` (reply to web-01):",
  "",
  "Found the root cause in `lib/session-history.ts`.",
  "",
  "If response expected, reply via `write`.",
  "</irc>",
].join("\n");

test("irc:incoming renders a structured card without the literal envelope", () => {
  const html = renderCustom({ customType: "irc:incoming", display: true, text: IRC_BODY });
  assert.match(html, />IRC message</);
  assert.match(html, /from scout/);
  assert.match(html, /reply to web-01/);
  assert.doesNotMatch(html, /<\/?irc>/i);
  assert.match(html, /Found the root cause in/);
});

test("irc:incoming collapsed preview never shows the <irc> marker", () => {
  const html = renderCustom({ customType: "irc:incoming", display: false, text: IRC_BODY });
  assert.doesNotMatch(html, /<\/?irc>/i);
  assert.match(html, />IRC message</);
  assert.match(html, /from scout/);
  assert.match(html, /Found the root cause in/);
});

test("irc:incoming without an envelope keeps the source label and plain body", () => {
  const html = renderCustom({ customType: "irc:incoming", display: true, text: "plain body without envelope" });
  assert.match(html, />IRC message</);
  assert.doesNotMatch(html, /from scout/);
  assert.match(html, /plain body without envelope/);
});