import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import { remarkPathLinks, resolveMarkdownPathCandidate } from "./markdown-path-links.ts";

function parse(markdown, cwd = "/work/project") {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkPathLinks({ cwd }));
  return processor.runSync(processor.parse(markdown));
}

function links(tree) {
  const found = [];
  visit(tree, "link", (node) => { found.push(node); });
  return found;
}

function textContent(tree) {
  let value = "";
  visit(tree, "text", (node) => { value += node.value; });
  return value;
}

test("links relative, absolute, source-location and bare-image paths", () => {
  const source = "Edit ./a.mk and src/x.ts:12, inspect /etc/hosts and b.jpg";
  const tree = parse(source);
  const found = links(tree);
  assert.deepEqual(found.map((node) => node.url), ["./a.mk", "src/x.ts:12", "/etc/hosts", "b.jpg"]);
  assert.ok(found.every((node) => node.data.hProperties.className.includes("chat-path-link")));
  assert.equal(textContent(tree), source);
});

test("keeps trailing punctuation outside links without losing line or column suffixes", () => {
  const source = "See (./a.mk:12:34), /etc/hosts.; then b.jpg!";
  const tree = parse(source);
  assert.deepEqual(links(tree).map((node) => node.url), ["./a.mk:12:34", "/etc/hosts", "b.jpg"]);
  assert.equal(textContent(tree), source);
  assert.deepEqual(resolveMarkdownPathCandidate("./a.mk:12:34,", "/work/project"), {
    href: "./a.mk:12:34", filePath: "/work/project/a.mk",
  });
});

test("ignores versions, unknown bare extensions, home shortcuts and remote URLs", () => {
  const tree = parse("1.2.3 example.com http://x/y.ts https://host/z.jpg ~/x ~/a.ts");
  const found = links(tree);
  assert.equal(found.length, 2);
  assert.ok(found.every((node) => /^https?:/.test(node.url)));
  assert.ok(found.every((node) => !node.data?.hProperties?.className));
});

test("does not repeat links or scan inline code, code blocks, math or link references", () => {
  const tree = parse("[./inside.ts](./a.mk) [./ref.ts][r] `./code.ts` $./math.ts$\n\n```txt\n./block.ts\n```\n\n[r]: ./reference.ts");
  assert.deepEqual(links(tree).map((node) => node.url), ["./a.mk"]);
  assert.equal(links(tree)[0].data?.hProperties?.className, undefined);
});

test("supports media/document/code extensions but not partial unknown filenames", () => {
  const tree = parse("sound.mp3 report.pdf data.yaml src/data.unusual foo.ts.bak");
  assert.deepEqual(links(tree).map((node) => node.url), ["sound.mp3", "report.pdf", "data.yaml", "src/data.unusual"]);
});

test("without cwd, only absolute paths link", () => {
  const processor = unified().use(remarkParse).use(remarkPathLinks({}));
  const tree = processor.runSync(processor.parse("./a.mk src/x.ts:12 b.jpg /etc/hosts"));
  assert.deepEqual(links(tree).map((node) => node.url), ["/etc/hosts"]);
});

test("retains resolver root and internal-endpoint guards", () => {
  assert.deepEqual(links(parse("../outside.ts /api/secret /_next/chunk.js //host/file.ts")), []);
});

test("whole-value resolution rejects prose and returns normalized source paths", () => {
  assert.equal(resolveMarkdownPathCandidate("npm install", "/work/project"), null);
  assert.equal(resolveMarkdownPathCandidate("./a.mk and b.jpg", "/work/project"), null);
  assert.deepEqual(resolveMarkdownPathCandidate("src/x.ts:12:3", "/work/project"), {
    href: "src/x.ts:12:3", filePath: "/work/project/src/x.ts",
  });
});
