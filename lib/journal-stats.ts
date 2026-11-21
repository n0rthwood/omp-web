// Role-tagged, whole-journal message statistics.
//
// Why this exists: the SDK's session listing (`session-listing.ts`) does NOT
// parse a journal. It reads a 4 KB head window plus a 32 KB tail and counts
// `"type":"message"` markers inside those byte slices, so every message that
// lives in the middle of the file is invisible to `messageCount` and
// `firstMessage`. Since plan mode injects a ~7 KB `plan-mode-context` record at
// the head of every web journal, real first user messages start around byte
// 8000 — outside that window — and sessions with hundreds of turns report 0.
//
// Every journal message record carries an explicit `message.role` tag, so the
// correct numbers need no inference: read the whole file, tag each record, and
// tally. That is all this module does.

import { readFile } from "fs/promises";
import { statSync } from "fs";

export interface JournalMessageStats {
  /** Every `type:"message"` record, all roles. */
  messageCount: number;
  /** `message.role === "user"` */
  userMessages: number;
  /** `message.role === "assistant"` */
  assistantMessages: number;
  /** `message.role === "toolResult"` */
  toolResultMessages: number;
  /** First user message text; "" when the journal contains no user message. */
  firstUserMessage: string;
}

declare global {
  var __ompJournalStatsCache:
    | Map<string, { mtimeMs: number; size: number; stats: JournalMessageStats }>
    | undefined;
}

/** Cap on memo entries; the store grows monotonically and each entry is cheap to rebuild. */
const MAX_CACHED_JOURNALS = 2000;

/** The SDK appends `type` as the first key of every record; gate parsing on it. */
const MESSAGE_LINE_PREFIX = '{"type":"message"';

/** Bounded per-message text so a giant first prompt cannot bloat the list payload. */
const FIRST_MESSAGE_CAP = 2000;

/**
 * Message text of one record: a string content is used as-is, otherwise the
 * text blocks are joined with a space. An image-only message yields "[image]",
 * the same placeholder the journal reader uses for image-only previews
 * (lib/session-history.ts outlinePreview) — without it an image prompt would
 * look like a message-less session.
 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let hasImage = false;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if (!("type" in block)) continue;
    if (block.type === "image") hasImage = true;
    if (block.type !== "text") continue;
    if ("text" in block && typeof block.text === "string") parts.push(block.text);
  }
  const text = parts.join(" ").trim();
  if (text) return text;
  return hasImage ? "[image]" : "";
}

function tallyLine(line: string, stats: JournalMessageStats): void {
  if (!line.startsWith(MESSAGE_LINE_PREFIX)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // partial/duff record — never counted
  }
  if (typeof parsed !== "object" || parsed === null || !("message" in parsed)) return;
  const message = parsed.message;
  if (typeof message !== "object" || message === null || !("role" in message)) return;

  stats.messageCount += 1;
  if (message.role === "user") {
    stats.userMessages += 1;
    if (!stats.firstUserMessage) {
      const text = "content" in message ? messageText(message.content) : "";
      if (text) stats.firstUserMessage = text.slice(0, FIRST_MESSAGE_CAP);
    }
  } else if (message.role === "assistant") {
    stats.assistantMessages += 1;
  } else if (message.role === "toolResult") {
    stats.toolResultMessages += 1;
  }
}

/**
 * Read one whole journal and tally its message records by `message.role`.
 * Returns undefined when the file cannot be opened or read — callers keep
 * whatever number their previous source produced.
 */
export async function readJournalMessageStats(filePath: string): Promise<JournalMessageStats | undefined> {
  const stats: JournalMessageStats = {
    messageCount: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolResultMessages: 0,
    firstUserMessage: "",
  };
  let text: string;
  try {
    // Whole-file read, not a stream: the largest journal on this fleet is a few
    // MB, and Bun's ReadStream machinery across many concurrently-scanned
    // journals is far more fragile than one buffer per file.
    text = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  // A trailing line without its newline is an in-flight append; the SDK loader
  // ignores it too, and the next append changes mtime/size.
  for (const line of text.split("\n")) tallyLine(line, stats);
  return stats;
}

/**
 * `readJournalMessageStats` memoized on the file's (mtimeMs, size) identity, so
 * a 30 s list refresh only rescans journals that actually changed. A stat
 * failure returns undefined (unreadable file) rather than throwing.
 */
export async function readJournalMessageStatsCached(
  filePath: string,
): Promise<JournalMessageStats | undefined> {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }
  if (!globalThis.__ompJournalStatsCache) globalThis.__ompJournalStatsCache = new Map();
  const cache = globalThis.__ompJournalStatsCache;
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.stats;

  const stats = await readJournalMessageStats(filePath);
  if (!stats) return undefined;

  cache.delete(filePath);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, stats });
  while (cache.size > MAX_CACHED_JOURNALS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === filePath) break;
    cache.delete(oldest);
  }
  return stats;
}