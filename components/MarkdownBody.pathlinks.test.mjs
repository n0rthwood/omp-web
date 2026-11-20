import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function render(markdown, props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MarkdownBody, {
      cwd: "/work/project",
      onOpenFile: () => {},
      ...props,
      children: markdown,
    }),
  ));
}

test("whole inline-code paths are keyboard-accessible file links", () => {
  const html = render("`./a.mk` and `src/x.ts:3`");
  assert.equal((html.match(/role="link"/g) ?? []).length, 2);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 2);
  assert.match(html, /class="markdown-inline-code chat-path-link"[^>]*>\.\/a\.mk<\/code>/);
});

test("inline code keeps commands, URLs, versions and home paths unchanged", () => {
  const html = render("`npm install` `1.2.3` `example.com` `http://x/y.ts` `~/x` `./a.mk b.jpg`");
  assert.doesNotMatch(html, /role="link"|chat-path-link/);
});

test("inline-code paths require an opener and relative paths require cwd", () => {
  assert.doesNotMatch(render("`./a.mk`", { onOpenFile: undefined }), /role="link"/);
  const html = render("`./a.mk` `/etc/hosts`", { cwd: undefined });
  assert.equal((html.match(/role="link"/g) ?? []).length, 1);
  assert.match(html, /role="link"[^>]*>\/etc\/hosts<\/code>/);
});

test("prose path styling survives sanitization while HTTP URLs remain external", () => {
  const html = render("./a.mk b.jpg https://example.com/x.ts 1.2.3");
  assert.match(html, /<a href="\.\/a\.mk" class="chat-path-link">\.\/a\.mk<\/a>/);
  assert.match(html, /<a href="b\.jpg" class="chat-path-link">b\.jpg<\/a>/);
  assert.match(html, /href="https:\/\/example.com\/x.ts" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="1\.2/);
});

test("block code remains a code block, not a path control", () => {
  const html = render("```txt\n./a.mk\n```");
  assert.doesNotMatch(html, /role="link"|chat-path-link/);
});

test("path class allowlist preserves GFM footnote backrefs and strips arbitrary classes", () => {
  const html = render('./a.mk note[^n]\n\n[^n]: detail\n\n<a href="./a.mk" class="untrusted">raw</a>');
  assert.match(html, /class="chat-path-link"/);
  assert.match(html, /class="data-footnote-backref"/);
  assert.doesNotMatch(html, /class="untrusted"/);
});
