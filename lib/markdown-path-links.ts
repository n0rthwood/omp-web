import type { Link, PhrasingContent, Root, Text } from "mdast";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";
import { resolveLocalFileHref } from "./file-links";
import { AUDIO_EXT_TO_MIME, DOCUMENT_EXT_TO_MIME, IMAGE_EXT_TO_MIME } from "./file-types";

const PATH_PATTERN = /(?:^|[\s(\[{"'`，。；：、])((?:\.{1,2}\/|~\/|\/)[^\s<>()\[\]{}"'`，。；：、]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?)/g;
const SINGLE_PATH_PATTERN = new RegExp(PATH_PATTERN.source);
const KNOWN_EXTENSIONS: Record<string, true> = Object.fromEntries([
  ...Object.keys(IMAGE_EXT_TO_MIME),
  ...Object.keys(AUDIO_EXT_TO_MIME),
  ...Object.keys(DOCUMENT_EXT_TO_MIME),
  ..."mk,md,txt,json,yml,yaml,toml,ini,cfg,conf,log,sh,bash,py,ts,tsx,js,jsx,mjs,cjs,go,rs,c,h,cpp,hpp,java,kt,sql,css,scss,html,xml,csv,lock,env,gitignore,dockerfile".split(","),
].map((extension) => [extension, true]));
const EXCLUDED_NODES: Record<string, true> = {
  link: true, linkReference: true, code: true, inlineCode: true, math: true, inlineMath: true,
};

/** Shared single-value detection for prose links and clickable inline code. */
export function resolveMarkdownPathCandidate(value: string, cwd?: string): { href: string; filePath: string } | null {
  if (value.startsWith("~/") || value.includes("://")) return null;
  // Static content URLs (/static/<machine>/<mapping>/...) are served over
  // HTTP, never as local filesystem paths. Resolve them as network links so
  // they open in the browser instead of the file sidebar.
  if (value.startsWith("/static/")) {
    const href = value.replace(/[.,;:!?)\]}'"]+$/, "");
    if (!href) return null;
    return { href, filePath: href };
  }
  const match = SINGLE_PATH_PATTERN.exec(value);
  if (!match || match.index !== 0 || match[1] !== value) return null;

  // Resolve the complete source location before removing surrounding punctuation.
  if (!resolveLocalFileHref(value, cwd)) return null;
  const href = value.replace(/[.,;:!?)\]}'"]+$/, "");
  if (!href) return null;
  const pathWithoutLine = href.replace(/:\d+(?::\d+)?$/, "");
  if (/^\d+(\.\d+)+$/.test(pathWithoutLine)) return null;
  if (!href.includes("/")) {
    const extension = pathWithoutLine.split(".").pop()?.toLowerCase();
    if (!extension || !Object.hasOwn(KNOWN_EXTENSIONS, extension)) return null;
  }
  const filePath = resolveLocalFileHref(href, cwd);
  return filePath ? { href, filePath } : null;
}

export function remarkPathLinks(options: { cwd?: string }): () => (tree: Node) => void {
  return () => (tree) => {
    // Pruning these subtrees excludes every descendant, including link text.
    visit(tree as Root, (node, index, parent) => {
      if (Object.hasOwn(EXCLUDED_NODES, node.type)) return SKIP;
      if (node.type !== "text" || index === undefined || !parent) return;
      const text = (node as Text).value;
      const replacements: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of text.matchAll(PATH_PATTERN)) {
        const candidate = match[1];
        const start = match.index + match[0].length - candidate.length;
        const end = start + candidate.length;
        // Do not turn a truncated filename/extension into a different path.
        if (/[\w/]/.test(text[end] ?? "") || /^\.[\w]/.test(text.slice(end))) continue;
        const resolved = resolveMarkdownPathCandidate(candidate, options.cwd);
        if (!resolved) continue;
        if (start > cursor) replacements.push({ type: "text", value: text.slice(cursor, start) });
        const link: Link = {
          type: "link",
          url: resolved.href,
          children: [{ type: "text", value: resolved.href }],
          data: { hProperties: { className: ["chat-path-link"] } },
        };
        replacements.push(link);
        cursor = start + resolved.href.length;
      }
      if (!replacements.length) return;
      if (cursor < text.length) replacements.push({ type: "text", value: text.slice(cursor) });
      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}
