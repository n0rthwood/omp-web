// #143: localized tool-call names.
//
// The transcript header, the running-tool hint and the outline preview all
// render the raw SDK tool id (`write`, `task`, `mcp__srv_read`, …). This module
// maps a tool id to its `toolName.<id>` message and falls back to the original
// id when no entry exists, so plugin/MCP tools keep their own names.
//
// Browser-safe and builtin-free: the transcript card, ChatWindow and the
// outline all import it.

import type { TranslationParams } from "./i18n/types";

/** Translate function shape shared by `useI18n().t` and server-side callers. */
export type Translate = (key: string, params?: TranslationParams) => string;

/**
 * Tool ids that carry a `toolName.*` entry. Mirrors the SDK's
 * `BUILTIN_TOOL_NAMES` (pi-coding-agent/src/tools/builtin-names.ts) plus the
 * hidden `yield`/`goal`/`think` tools; `lib/tool-name-i18n.test.mjs` asserts the
 * SDK list stays covered.
 */
export const LOCALIZED_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "ida",
  "eval",
  "github",
  "glob",
  "grep",
  "find",
  "lsp",
  "checkpoint",
  "rewind",
  "context_notes",
  "new_context",
  "security_scan",
  "task",
  "wait",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
  "yield",
  "goal",
  "think",
] as const;

const LOCALIZED_TOOL_NAME_TABLE: Record<string, true> = Object.fromEntries(
  LOCALIZED_TOOL_NAMES.map((name) => [name, true]),
);

/** i18n key for a canonical tool id, or null when the id has no entry. */
export function toolNameKey(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized || LOCALIZED_TOOL_NAME_TABLE[normalized] !== true) return null;
  return `toolName.${normalized}`;
}

/**
 * Localize a tool id for display. Unknown ids (plugin tools, MCP tools with no
 * matching entry, malformed input) fall back to the original string.
 *
 * Namespaced ids resolve through their trailing segment (`plugin.write`,
 * `mcp__server_read`), and the ` (local)` marker the bash tool appends is
 * ignored, so both variants read as the localized base name.
 */
export function localizedToolName(raw: string, t: Translate): string {
  if (typeof raw !== "string" || !raw.trim()) return raw;
  const normalized = raw.trim().toLowerCase();
  const unscoped = normalized.replace(/\s*\(local\)$/, "");
  const candidates = [normalized, unscoped];
  const lastDot = unscoped.lastIndexOf(".");
  if (lastDot > 0 && lastDot < unscoped.length - 1) candidates.push(unscoped.slice(lastDot + 1));
  const lastDoubleUnderscore = unscoped.lastIndexOf("__");
  if (lastDoubleUnderscore > 0 && lastDoubleUnderscore < unscoped.length - 2) {
    // `mcp__server_read` → `server_read` → `read`; the server segment is not a
    // tool id, so the trailing segment is the useful candidate.
    candidates.push(unscoped.slice(lastDoubleUnderscore + 2));
    const lastUnderscore = unscoped.lastIndexOf("_");
    if (lastUnderscore > lastDoubleUnderscore + 1 && lastUnderscore < unscoped.length - 1) {
      candidates.push(unscoped.slice(lastUnderscore + 1));
    }
  }
  for (const candidate of candidates) {
    const key = toolNameKey(candidate);
    if (!key) continue;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return raw;
}

/**
 * Localize a comma-joined outline preview of tool ids. The outline metadata is
 * built server-side (`lib/session-history.ts` toolNameLabels) and truncated
 * with `+N more` / `… more` markers, so each token is mapped independently and
 * unknown tokens stay verbatim.
 */
export function localizedToolPreview(preview: string, t: Translate): string {
  if (typeof preview !== "string" || !preview) return preview;
  return preview
    .split(", ")
    .map((token) => {
      const overflow = token.match(/^\+(\d+) more$/);
      if (overflow) return t("toolName.moreCount", { count: Number(overflow[1]) });
      if (token === "… more") return t("toolName.more");
      return localizedToolName(token, t);
    })
    .join(", ");
}

/**
 * #146: whether a preview is nothing but tool ids (`task`, `todo, task`,
 * `read, +3 more`). Outline rows that reach the panel without their
 * `toolNames` list — a journal rebuild, an older payload — still carry such a
 * preview, and only those may be run through `localizedToolPreview`; prose
 * that merely contains the word `read` must stay verbatim.
 */
export function isLocalizedToolPreview(preview: string): boolean {
  if (typeof preview !== "string" || !preview.trim()) return false;
  const tokens = preview.split(", ");
  return tokens.length > 0 && tokens.every((token) =>
    /^\+(\d+) more$/.test(token)
    || token === "… more"
    || toolNameKey(token) !== null);
}