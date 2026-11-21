// Journal-backed history windows (issue #99).
//
// History for the web chat comes from the durable session .jsonl — the same
// source the export renders — never from realtime ring replay. This module
// provides:
//   * the frozen splice types shared with the host bridge and the window UI
//     (JournalAnchor / HistoryBoundary / HistoryPage),
//   * readSessionHistory(): bounded tail/before/after/around pages with
//     transcript semantics identical to buildSessionContext (compaction
//     elision, branch parent chain, entryIds parallel to messages),
//   * readSessionOutline(): metadata-only transcript outline (#104) —
//     no entry bodies are parsed for modern journals,
//   * a metadata spine + byte-offset index per journal file so a warm refresh
//     reads only O(window) bytes instead of re-parsing every entry body.
//
// The spine stores metadata only (ids, parents, types, byte offsets, small
// message fields, capped previews). Branch walking, compaction elision and
// pagination all run over metadata; entry bodies are parsed lazily, only for
// the sliced window (plus the context-usage tail), and cached per (file
// version, offset). Appends extend the spine incrementally; rewrites (title
// rename, discard, migrations) and partial trailing lines invalidate it.

import {
  isEmptyErrorTurn,
  migrateToCurrentVersion,
  resolveBlobRefsInEntriesSync,
  type SessionEntry as OmpSessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { AgentMessage as OmpAgentMessage } from "@oh-my-pi/pi-agent-core";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { calculatePromptTokens, hasContextTokenUsage } from "@oh-my-pi/pi-agent-core/compaction";
import { getBlobsDir } from "@oh-my-pi/pi-utils/dirs";
import { closeSync, fstatSync, openSync, readSync } from "fs";
import { normalize as normalizePath } from "path";
import type { ContextUsage } from "./omp-types";
import { getOmpRuntime } from "./omp-runtime";
import { buildSessionContext, entryToUiMessage, parseDefaultModel } from "./session-reader";
import { computeSessionTotalActiveMs } from "./session-timing";
import type { SessionOutline, SessionOutlineEntry } from "./session-outline";
import type {
  AgentMessage,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from "./types";

/** Durable journal position captured atomically with the host's ring seq. */
export interface JournalAnchor {
  /** Id of the last durable entry at capture time (null for an empty journal). */
  lastEntryId: string | null;
  /** Active branch leaf at capture time (null when no branch is selected). */
  leafId: string | null;
  /** Durable entry count (title slot / header excluded). */
  entryCount: number;
  /** Journal byte size at capture time; bounds every anchored read. */
  sizeBytes: number;
  /** Journal mtime in ms at capture time. */
  mtimeMs: number;
}

/** Host attach splice point: journal ≤ anchor, live frames > seq. */
export interface HistoryBoundary {
  seq: number;
  journal: JournalAnchor;
}

/** One bounded history page's position within the journal. */
export interface HistoryPage {
  /** Anchor bounding this read (the anchor passed in, or freshly derived). */
  anchor: JournalAnchor;
  /** True when displayable entries exist before this page's head. */
  hasEarlier: boolean;
  /** Entry id of the page's first message; pass as `before` for the previous page. */
  headEntryId: string | null;
  /**
   * True when displayable entries exist after this page's last message (#104).
   * Optional for legacy producers; window reads always populate it.
   */
  hasLater?: boolean;
  /** Entry id of the transcript's last rendered message at the anchor (null when empty). */
  tailEntryId?: string | null;
}

export interface ReadSessionHistoryOptions {
  /** Page size. Default 5 (initial window); UI pages use 20; hard cap 100. */
  limit?: number;
  /** Return up to `limit` messages strictly before this entry id. */
  before?: string;
  /** Warm delta: messages strictly after this entry id, up to the anchor. */
  after?: string;
  /**
   * Inclusive window centered on this entry id (#104): up to `limit`
   * messages containing the target, edge-clamped. Missing/non-visible
   * targets raise HistoryTargetUnavailableError — never a tail fallback.
   */
  around?: string;
  /** Branch leaf; undefined = replayed leaf, null = no active branch. */
  leafId?: string | null;
  /** Bound the read to this durable position; later appends are excluded. */
  anchor?: JournalAnchor;
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
}

export interface SessionHistoryResult {
  context: SessionContext;
  page: HistoryPage;
  tree?: SessionTreeNode[];
  contextUsage?: ContextUsage;
  totalActiveMs?: number;
  /** Bounded header/title-slot metadata parsed during indexing (no extra scan). */
  header?: SessionHeader;
}

/** Why an `around` target could not be included in a window (#104). */
export type HistoryTargetUnavailableReason = "not_found" | "not_visible" | "stale_anchor";

/**
 * Structured failure for outline/around navigation: the route maps this to
 * 409 (stale anchor — journal rewritten under the caller's snapshot) or 404
 * (target absent or not on the visible branch), code
 * `history_target_unavailable`. Never degrade these into a tail window.
 */
export class HistoryTargetUnavailableError extends Error {
  readonly reason: HistoryTargetUnavailableReason;
  constructor(reason: HistoryTargetUnavailableReason) {
    super(`history target unavailable: ${reason}`);
    this.name = "HistoryTargetUnavailableError";
    this.reason = reason;
  }
}

export const DEFAULT_HISTORY_LIMIT = 5;
export const HISTORY_PAGE_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

/** Validate an untrusted anchor (route query input). Returns null when malformed. */
export function parseJournalAnchor(value: unknown): JournalAnchor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const lastEntryId = record.lastEntryId;
  const leafId = record.leafId;
  const { entryCount, sizeBytes, mtimeMs } = record;
  if (lastEntryId !== null && typeof lastEntryId !== "string") return null;
  if (leafId !== null && typeof leafId !== "string") return null;
  if (typeof entryCount !== "number" || !Number.isInteger(entryCount) || entryCount < 0) return null;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) return null;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
  return { lastEntryId, leafId, entryCount, sizeBytes, mtimeMs };
}

/** Clamp a requested page size into [1, MAX_HISTORY_LIMIT]. */
export function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.floor(limit)));
}

// ============================================================================
// Journal metadata spine + byte-offset index
// ============================================================================

const tokenizer = new Tokenizer();

const PREVIEW_CAP = 200;

/** Tool-name labels kept per message record for tool-only outline previews. */
const TOOL_NAME_LABEL_CAP = 8;
/** Per-name character bound so pathological names cannot bloat the spine. */
const TOOL_NAME_CHAR_CAP = 48;
/** Tool-name scan bound; beyond it the total is unknown ("… more"). */
const TOOL_NAME_SCAN_CAP = 64;

/**
 * One durable journal record: metadata only. `end` is the byte offset just
 * past the record's terminating newline, so [offset, end) re-reads exactly
 * this record — even when the record is tens of megabytes.
 */
interface JournalRecordMeta {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  offset: number;
  end: number;
  /** message entries only: cheap fields for settings/usage/preview. */
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  /** assistant usage object when present (context usage anchor). */
  usage?: unknown;
  contextPromptTokens?: number;
  hasImage?: boolean;
  preview?: string;
  /** ask toolResult only: included as an answer in the outline. */
  isAskResult?: boolean;
  askError?: boolean;
  /** custom_message only. */
  customType?: string;
  /** custom_message only: content is string/array (renders) vs other (null). */
  contentRenderable?: boolean;
  /** branch_summary only. */
  hasSummary?: boolean;
  /** compaction only. */
  firstKeptEntryId?: string;
  /** message entries only: toolCall names in block order (bounded count, outline). */
  toolNames?: string[];
  /** label only. */
  targetId?: string;
  label?: string | null;
  /** model_usage only: undefined selects itself, null clears, string captures a leaf. */
  activeLeafId?: string | null;
  /** model_change only. */
  modelSelector?: string;
  modelRole?: string;
  /** mode_change only: active mode + small state record (planFilePath). */
  mode?: string;
  modeData?: Record<string, unknown>;
  /** thinking_level_change only. */
  thinkingLevel?: string;
}

interface JournalIndex {
  filePath: string;
  /** Byte offset where the unindexed tail starts (after last complete record). */
  scannedTo: number;
  sizeBytes: number;
  mtimeMs: number;
  /** Durable records in file order (header/title slot/malformed excluded). */
  records: JournalRecordMeta[];
  byId: Map<string, JournalRecordMeta>;
  /** Parsed entry bodies, keyed by record offset; bounded LRU. */
  bodies: Map<number, SessionEntry>;
  /** Header version seen in the file (undefined = no session header yet). */
  version: number | undefined;
  /** Cached metadata spine tree; rebuilt when the record count changes. */
  treeCache: { count: number; tree: SessionTreeNode[] } | undefined;
  /** Fingerprint of the file head (title slot + header) for rewrite detection. */
  headFingerprint: string;
  /** Session header captured during the spine scan (title slot folded in). */
  header: SessionHeader | undefined;
  /** Fixed-width title slot title, when present (overrides header.title). */
  slotTitle: string | undefined;
  /**
   * Legacy (version < 3) migrated views, keyed by scanned byte extent,
   * newest last, bounded LRU. The v1 migration assigns fresh random ids, so
   * each extent must migrate ONCE and stay retained: re-migrating per page
   * (or after an append) would renumber ids and break navigation targets.
   */
  legacyViews: LegacyCache[];
  /**
   * Bounded byte fingerprint at the legacy spine's scan boundary, captured
   * when the extent grows. Detects overwrites near an appended prefix's old
   * boundary; it does NOT see arbitrary middle-of-prefix rewrites (those are
   * caught fail-closed by the rebuild signal + invalidated extents).
   * `start`/`end` are BYTE offsets (the text is decoded; .length is not bytes).
   */
  legacyBoundaryProbe: { start: number; end: number; text: string } | undefined;
  /**
   * Extents whose retained legacy view was LRU-evicted or wiped by a rebuild
   * (rewrite signal). Anchored navigation on these extents fails stale even
   * when the rewrite shares the snapshot's mtime millisecond. Bounded.
   */
  legacyEvictedExtents: number[];
}


interface LegacyCache {
  scanEnd: number;
  entries: SessionEntry[];
  entriesById: Map<string, SessionEntry>;
  metas: JournalRecordMeta[];
  byId: Map<string, JournalRecordMeta>;
  tree: SessionTreeNode[];
  /** Bounded bytes at scanEnd when the view was built (rewrite detection). */
  tailProbe: string;
}
const MAX_CACHED_JOURNALS = 8;
const MAX_CACHED_BODIES_PER_JOURNAL = 400;
const MAX_LEGACY_VIEWS_PER_JOURNAL = 4;
/** Byte budget for idless-spine boundary probes (same-size rewrite detection). */
const LEGACY_PROBE_BYTES = 256;

declare global {
  var __ompJournalIndexCache: Map<string, JournalIndex> | undefined;
}

function journalCache(): Map<string, JournalIndex> {
  if (!globalThis.__ompJournalIndexCache) globalThis.__ompJournalIndexCache = new Map();
  return globalThis.__ompJournalIndexCache;
}

/** Drop a journal's cached spine (session deleted / explicit invalidation). */
export function invalidateJournalIndex(filePath: string): void {
  journalCache().delete(normalizePath(filePath));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRange(fd: number, start: number, end: number): Buffer {
  const length = end - start;
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

function appendPreview(current: string, value: unknown): string {
  if (typeof value !== "string" || current.length >= PREVIEW_CAP) return current;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return current;
  const joined = current ? `${current} ${normalized}` : normalized;
  return joined.length > PREVIEW_CAP ? joined.slice(0, PREVIEW_CAP) : joined;
}

/**
 * ToolCall labels for the outline: normalized toolName/name (matching
 * normalizeToolCalls), file order, bounded count with an overflow marker so
 * even a thousands-of-calls turn keeps metadata O(record). Names themselves
 * are capped defensively; the joined preview is PREVIEW_CAP-bounded anyway.
 */
function toolNameLabels(content: unknown[]): string[] {
  const labels: string[] = [];
  let seen = 0;
  for (const block of content) {
    if (!isPlainRecord(block) || block.type !== "toolCall") continue;
    seen++;
    if (labels.length < TOOL_NAME_LABEL_CAP) {
      const name = typeof block.toolName === "string" ? block.toolName
        : typeof block.name === "string" ? block.name
          : "";
      labels.push(name.slice(0, TOOL_NAME_CHAR_CAP));
    }
    if (seen > TOOL_NAME_SCAN_CAP) break;
  }
  if (seen > TOOL_NAME_LABEL_CAP) {
    labels.push(seen > TOOL_NAME_SCAN_CAP ? "… more" : `+${seen - TOOL_NAME_LABEL_CAP} more`);
  }
  return labels;
}

function askResultPreview(details: unknown): string | null {
  if (!isPlainRecord(details)) return null;
  if (details.chatRedirect === true) {
    let preview = "";
    if (Array.isArray(details.discussion)) {
      for (const item of details.discussion) {
        if (!isPlainRecord(item) || typeof item.id !== "string" || typeof item.text !== "string" || !item.text.trim()) continue;
        preview = appendPreview("", `${preview}${preview ? "; " : "Chat about this: "}${item.text}`);
        if (preview.length >= PREVIEW_CAP) break;
      }
    }
    return preview || "Chat about this";
  }
  const answers = Array.isArray(details.results) ? details.results : [details];
  if (answers.length === 0 || !answers.every((answer) =>
    isPlainRecord(answer)
    && Array.isArray(answer.selectedOptions)
    && answer.selectedOptions.every((label) => typeof label === "string")
    && (answer.customInput === undefined || typeof answer.customInput === "string")
  )) return null;
  let preview = "";
  for (const answer of answers) {
    let answerPreview = "";
    for (const label of answer.selectedOptions as string[]) {
      answerPreview = appendPreview("", `${answerPreview}${answerPreview ? ", " : ""}${label}`);
      if (answerPreview.length >= PREVIEW_CAP) break;
    }
    if (typeof answer.customInput === "string") {
      answerPreview = appendPreview("", `${answerPreview}${answerPreview ? " " : ""}(custom: ${answer.customInput})`);
    }
    preview = appendPreview("", `${preview}${preview ? "; " : ""}${answerPreview}`);
    if (preview.length >= PREVIEW_CAP) break;
  }
  return preview;
}

function metaFromEntry(entry: Record<string, unknown>, offset: number, end: number): JournalRecordMeta | null {
  const id = entry.id;
  const type = entry.type;
  if (typeof id !== "string" || typeof type !== "string" || type === "session" || type === "title") return null;
  const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
  const meta: JournalRecordMeta = {
    id,
    parentId,
    type,
    timestamp,
    offset,
    end,
  };
  if (type === "message" && isPlainRecord(entry.message)) {
    const message = entry.message;
    meta.role = typeof message.role === "string" ? message.role : undefined;
    meta.provider = typeof message.provider === "string" ? message.provider : undefined;
    meta.model = typeof message.model === "string" ? message.model : undefined;
    meta.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (message.usage !== undefined) meta.usage = message.usage;
    if (isPlainRecord(message.contextSnapshot) && typeof message.contextSnapshot.promptTokens === "number") {
      meta.contextPromptTokens = message.contextSnapshot.promptTokens;
    }
    let preview = "";
    const content = message.content;
    if (typeof content === "string") {
      preview = appendPreview(preview, content);
    } else if (Array.isArray(content)) {
      // Tool labels are collected independently of the text-preview cap so
      // tool-only assistants (and huge-text turns) still get outline labels.
      const toolNames = toolNameLabels(content);
      if (toolNames.length > 0) meta.toolNames = toolNames;
      for (const block of content) {
        if (!isPlainRecord(block)) continue;
        if (block.type === "image") meta.hasImage = true;
        if (block.type === "text") preview = appendPreview(preview, block.text);
        if (preview.length >= PREVIEW_CAP) break;
      }
    }
    if (message.role === "toolResult" && message.toolName === "ask") {
      meta.isAskResult = true;
      meta.askError = message.isError === true;
      if (!meta.askError) preview = askResultPreview(message.details) ?? preview;
    }
    if (preview) meta.preview = preview;
  } else if (type === "custom_message") {
    meta.customType = typeof entry.customType === "string" ? entry.customType : undefined;
    // entryToUiMessage renders every custom_message regardless of content
    // shape; keep pagination parity with the web conversion.
    meta.contentRenderable = true;
    let preview = "";
    const content = entry.content;
    if (typeof content === "string") {
      preview = appendPreview(preview, content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isPlainRecord(block) && block.type === "text") preview = appendPreview(preview, block.text);
        if (preview.length >= PREVIEW_CAP) break;
      }
    }
    if (preview) meta.preview = preview;
  } else if (type === "branch_summary") {
    meta.hasSummary = typeof entry.summary === "string" && entry.summary.length > 0;
    if (typeof entry.summary === "string") meta.preview = appendPreview("", entry.summary);
  } else if (type === "compaction") {
    meta.firstKeptEntryId = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : "";
    if (typeof entry.summary === "string") {
      const preview = appendPreview("", entry.summary);
      if (preview) meta.preview = preview;
    }
  } else if (type === "label") {
    meta.targetId = typeof entry.targetId === "string" ? entry.targetId : undefined;
    meta.label = typeof entry.label === "string" ? entry.label : null;
  } else if (type === "model_usage") {
    if (entry.activeLeafId === null || typeof entry.activeLeafId === "string") {
      meta.activeLeafId = entry.activeLeafId;
    }
  } else if (type === "model_change") {
    if (typeof entry.model === "string") {
      meta.modelSelector = entry.model;
      meta.modelRole = typeof entry.role === "string" ? entry.role : "default";
    } else if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
      meta.modelSelector = `${entry.provider}/${entry.modelId}`;
      meta.modelRole = "default";
    }
  } else if (type === "thinking_level_change") {
    meta.thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "off";
  } else if (type === "mode_change") {
    meta.mode = typeof entry.mode === "string" ? entry.mode : "none";
    if (isPlainRecord(entry.data)) meta.modeData = entry.data;
  }
  return meta;
}

/**
 * Extend the metadata spine over [index.scannedTo, bound). Records are split
 * on newline bytes; each complete line is JSON-parsed once, at append time,
 * to extract cheap metadata. A trailing line without its newline is an
 * in-flight append: it stays unindexed and is retried on the next read.
 * Malformed complete lines are skipped, matching the SDK loader. A warm read
 * over an unchanged or slightly-grown journal never re-parses old bodies.
 */
function scanForward(fd: number, index: JournalIndex, bound: number): void {
  const CHUNK = 1024 * 1024;
  let position = index.scannedTo;
  let lineStart = position;
  let pending: Buffer = Buffer.alloc(0);
  while (position < bound) {
    const chunk = readRange(fd, position, Math.min(position + CHUNK, bound));
    if (chunk.length === 0) break;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    // `newline`/`consumed` are relative to this chunk's pending buffer; the
    // buffer's absolute file start is fixed for the whole inner loop.
    const bufferStart = lineStart;
    let consumed = 0;
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      const line = pending.subarray(consumed, newline);
      const recordEnd = bufferStart + newline + 1;
      indexRecordLine(index, line, bufferStart + consumed, recordEnd);
      lineStart = recordEnd;
      consumed = newline + 1;
      newline = pending.indexOf(0x0a, consumed);
    }
    pending = consumed > 0 ? pending.subarray(consumed) : pending;
    position += chunk.length;
  }
  index.scannedTo = lineStart;
}

function indexRecordLine(index: JournalIndex, line: Buffer, offset: number, end: number): void {
  if (line.length === 0) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line.toString("utf8"));
  } catch {
    return; // malformed record — the SDK loader skips it too
  }
  if (!isPlainRecord(entry)) return;
  if (entry.type === "title") {
    if (typeof entry.title === "string" && entry.title.length > 0) index.slotTitle = entry.title;
    return;
  }
  if (entry.type === "session") {
    index.version = typeof entry.version === "number" ? entry.version : 1;
    if (typeof entry.id === "string") {
      index.header = {
        type: "session",
        version: index.version,
        id: entry.id,
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
        cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        ...(typeof entry.parentSession === "string" ? { parentSession: entry.parentSession } : {}),
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
      };
    }
    return;
  }
  const meta = metaFromEntry(entry, offset, end);
  if (!meta) return;
  const previous = index.byId.get(meta.id);
  if (previous) {
    // Duplicate id (rewrite we failed to detect, or corrupt file): keep the last.
    const at = index.records.indexOf(previous);
    if (at >= 0) index.records.splice(at, 1);
    index.bodies.delete(previous.offset);
  }
  index.records.push(meta);
  index.byId.set(meta.id, meta);
}

/**
 * Verify the cached spine still matches the file and extend it. A rewrite
 * (rename rewrites the title slot; discard/branch rewrite bodies) changes
 * bytes inside the already-scanned region — detected by re-checking the last
 * indexed record's id against its recorded bytes. Cheap: one record re-read,
 * not a full-file scan. On mismatch the spine is rebuilt from byte zero.
 * Idless legacy spines have no record ids; their rewrites are detected by
 * bounded byte probes at view/scan boundaries (legacyView).
 */
function ensureIndex(fd: number, index: JournalIndex, fileSize: number, mtimeMs: number, bound: number): void {
  const scanBound = Math.min(bound, fileSize);
  if (
    fileSize === index.sizeBytes
    && mtimeMs === index.mtimeMs
    && index.scannedTo >= scanBound
  ) {
    return;
  }
  if (
    fileSize < index.scannedTo
    || (fileSize === index.sizeBytes && mtimeMs !== index.mtimeMs)
    || !verifyTailRecord(fd, index, fileSize)
    || !verifyHead(fd, index, fileSize)
  ) {
    index.records = [];
    index.byId = new Map();
    index.bodies = new Map();
    index.treeCache = undefined;
    index.scannedTo = 0;
    index.version = undefined;
    index.headFingerprint = "";
    index.header = undefined;
    index.slotTitle = undefined;
    // A rebuild is a rewrite signal (same-size mtime change, shrink, head or
    // tail-record mismatch). Record every wiped view's extent as invalidated
    // so anchored legacy navigation fails stale even when the rewrite lands
    // in the SAME millisecond as the snapshot's mtime — the bounded byte
    // probes alone cannot see an arbitrary middle-of-prefix rewrite.
    for (const view of index.legacyViews) index.legacyEvictedExtents.push(view.scanEnd);
    while (index.legacyEvictedExtents.length > MAX_LEGACY_VIEWS_PER_JOURNAL * 2) index.legacyEvictedExtents.shift();
    index.legacyViews = [];
    index.legacyBoundaryProbe = undefined;
  }
  scanForward(fd, index, scanBound);
  if (index.version !== undefined && index.version < 3 && index.scannedTo > 0) {
    // Legacy spine: remember the bytes at the new scan boundary so a later
    // anchored read can detect an overwrite near the old boundary after an
    // append (idless v1 spines have no record ids for verifyTailRecord).
    const start = Math.max(0, index.scannedTo - LEGACY_PROBE_BYTES);
    index.legacyBoundaryProbe = { start, end: index.scannedTo, text: readRange(fd, start, index.scannedTo).toString("utf8") };
  }
  index.sizeBytes = fileSize;
  index.mtimeMs = mtimeMs;
}

function verifyTailRecord(fd: number, index: JournalIndex, fileSize: number): boolean {
  const last = index.records[index.records.length - 1];
  if (!last) return true; // idless spine: rewrites detected via boundary probes
  // An offset-shifting rewrite moves the record's terminating newline; the
  // byte at end-1 must still be a newline and the id must still sit at offset.
  if (last.end > fileSize) return false;
  const tailByte = readRange(fd, last.end - 1, last.end);
  if (tailByte.length !== 1 || tailByte[0] !== 0x0a) return false;
  const head = readRange(fd, last.offset, Math.min(last.offset + 512, last.end)).toString("utf8");
  return head.includes(`"id":"${last.id}"`) || head.includes(`"id": "${last.id}"`);
}

/**
 * The fixed-width title slot and session header occupy the file head; a
 * rename rewrites the slot in place without touching any record. Compare a
 * bounded head fingerprint so such rewrites invalidate cached bodies/anchors.
 */
function verifyHead(fd: number, index: JournalIndex, fileSize: number): boolean {
  const head = readRange(fd, 0, Math.min(1024, fileSize)).toString("utf8");
  if (index.headFingerprint === "") {
    index.headFingerprint = head;
    return true;
  }
  // Compare only the captured prefix: an append grows the head window, and
  // treating that growth as a rewrite would rebuild the spine (and wipe
  // retained legacy views) on every append to a sub-1024B journal.
  if (head.length >= index.headFingerprint.length && head.slice(0, index.headFingerprint.length) === index.headFingerprint) {
    index.headFingerprint = head;
    return true;
  }
  index.headFingerprint = head;
  return false;
}

interface LoadedJournal {
  fd: number;
  index: JournalIndex;
  fileSize: number;
  mtimeMs: number;
}

function loadIndex(filePath: string): LoadedJournal {
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    const cache = journalCache();
    let index = cache.get(filePath);
    if (!index) {
      index = {
        filePath,
        scannedTo: 0,
        sizeBytes: 0,
        mtimeMs: 0,
        records: [],
        byId: new Map(),
        bodies: new Map(),
        version: undefined,
        treeCache: undefined,
        headFingerprint: "",
        header: undefined,
        slotTitle: undefined,
        legacyViews: [],
        legacyBoundaryProbe: undefined,
        legacyEvictedExtents: [],
      };
      cache.set(filePath, index);
      while (cache.size > MAX_CACHED_JOURNALS) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined || oldest === filePath) break;
        cache.delete(oldest);
      }
    } else {
      // Refresh LRU position.
      cache.delete(filePath);
      cache.set(filePath, index);
    }
    return { fd, index, fileSize: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

let blobStore: BlobStore | undefined;
function getBlobStore(): BlobStore {
  if (!blobStore) blobStore = new BlobStore(getBlobsDir());
  return blobStore;
}

/**
 * Parsed body for one record, cached per offset within the journal version.
 * Blob-externalized image refs are hydrated exactly like the SDK loader so
 * rendered content matches the export. Cached bodies are never mutated in
 * place by callers (deferred-thinking conversion copies).
 */
function bodyAt(fd: number, index: JournalIndex, meta: JournalRecordMeta): SessionEntry | null {
  const cached = index.bodies.get(meta.offset);
  if (cached) return cached;
  const line = readRange(fd, meta.offset, meta.end).toString("utf8").trimEnd();
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainRecord(entry) || entry.id !== meta.id) return null;
  const body = entry as unknown as SessionEntry;
  resolveBlobRefsInEntriesSync([body as unknown as OmpSessionEntry], getBlobStore());
  if (index.bodies.size >= MAX_CACHED_BODIES_PER_JOURNAL) {
    const oldest = index.bodies.keys().next().value;
    if (oldest !== undefined) index.bodies.delete(oldest);
  }
  index.bodies.set(meta.offset, body);
  return body;
}

/** Resolve the active leaf from metadata alone (mirrors resolveSessionLeafId). */
function resolveLeafFromMeta(records: JournalRecordMeta[], byId: Map<string, JournalRecordMeta>): string | null {
  const last = records[records.length - 1];
  if (!last) return null;
  const leafId = last.type === "model_usage" && last.activeLeafId !== undefined ? last.activeLeafId : last.id;
  if (leafId === null || leafId === last.id || byId.has(leafId)) return leafId;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const selects = record.type === "model_usage" && record.activeLeafId !== undefined ? record.activeLeafId : record.id;
    if (selects === record.id) return record.id;
  }
  return null;
}

/** Branch path root-first over metadata; corrupt cycles stop at first repeat. */
function branchMetaPath(byId: Map<string, JournalRecordMeta>, leafId: string | null): JournalRecordMeta[] {
  if (leafId === null) return [];
  const path: JournalRecordMeta[] = [];
  const seen = new Set<string>();
  let meta = byId.get(leafId);
  while (meta && !seen.has(meta.id)) {
    seen.add(meta.id);
    path.push(meta);
    meta = meta.parentId ? byId.get(meta.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * Displayable transcript records, identical to session-reader's
 * collectDisplayEntries: the latest compaction on the path elides everything
 * before firstKeptEntryId, the summary renders at its chronological point,
 * and everything kept or newer follows. Metadata only — no bodies.
 */
function displayMetaPath(path: JournalRecordMeta[]): JournalRecordMeta[] {
  let compactionIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].type === "compaction") {
      compactionIdx = i;
      break;
    }
  }
  if (compactionIdx === -1) return path;
  const compaction = path[compactionIdx];
  const kept: JournalRecordMeta[] = [];
  let foundFirstKept = false;
  for (let i = 0; i < compactionIdx; i++) {
    if (path[i].id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) kept.push(path[i]);
  }
  return [...kept, compaction, ...path.slice(compactionIdx + 1)];
}

/**
 * Whether a display record renders a chat message, from metadata alone —
 * mirrors entryToUiMessage's null cases (only branch_summary without a
 * summary and custom_message with non-string/array content render nothing).
 */
function rendersMessage(meta: JournalRecordMeta): boolean {
  switch (meta.type) {
    case "message":
    case "compaction":
      return true;
    case "branch_summary":
      return meta.hasSummary === true;
    case "custom_message":
      // entryToUiMessage renders any custom_message whose content the SDK
      // accepts (string/array); the web conversion never returns null here.
      return meta.contentRenderable === true;
    default:
      return false;
  }
}

/**
 * Outline role for a rendered display record, or null when the record is a
 * rendered message that the outline does not list (non-ask toolResult/
 * bashExecution/custom_message). Such positions still count toward ordinals so outline
 * ordinals match the window readers' rendered-message positions exactly.
 */
function outlineRole(meta: JournalRecordMeta): SessionOutlineEntry["role"] | null {
  if (meta.type === "message") {
    if (meta.role === "user") return "user";
    if (meta.role === "assistant") return "assistant";
    if (meta.role === "toolResult" && meta.isAskResult) return "ask";
    return null;
  }
  if (meta.type === "compaction") return "summary";
  if (meta.type === "branch_summary") return "summary";
  return null;
}

/**
 * Deterministic bounded plain preview from spine metadata only. Text wins;
 * tool-only assistants fall back to their toolCall labels, image-only turns
 * to "[image]". Whitespace is collapsed by appendPreview at index time.
 */
function outlinePreview(meta: JournalRecordMeta): string {
  if (meta.preview) return meta.preview;
  if (meta.toolNames && meta.toolNames.length > 0) {
    const joined = meta.toolNames.join(", ");
    return joined.length > PREVIEW_CAP ? joined.slice(0, PREVIEW_CAP) : joined;
  }
  return meta.hasImage ? "[image]" : "";
}

/** Rendered display positions (metadata only), shared by windows + outline. */
function renderedPositions(display: JournalRecordMeta[]): number[] {
  const positions: number[] = [];
  for (let i = 0; i < display.length; i++) {
    if (rendersMessage(display[i])) positions.push(i);
  }
  return positions;
}

/**
 * Inclusive around window over rendered positions (#104): centered on the
 * target, clamped at the transcript edges, at most `limit` positions. The
 * caller guarantees the target position exists.
 */
function aroundRange(at: number, total: number, limit: number): { start: number; end: number } {
  let start = Math.max(0, at - Math.floor((limit - 1) / 2));
  const end = Math.min(start + limit, total);
  start = Math.max(0, end - limit);
  return { start, end };
}

/** Settings from metadata (thinking level + default model), no bodies needed. */
function settingsFromMeta(path: JournalRecordMeta[]): { thinkingLevel: string; model: { provider: string; modelId: string } | null } {
  let thinkingLevel = "off";
  const models: Record<string, string> = {};
  let hasExplicitDefault = false;
  for (const meta of path) {
    if (meta.type === "thinking_level_change") {
      thinkingLevel = meta.thinkingLevel ?? "off";
    } else if (meta.type === "model_change" && meta.modelSelector) {
      models[meta.modelRole ?? "default"] = meta.modelSelector;
      if ((meta.modelRole ?? "default") === "default") hasExplicitDefault = true;
    } else if (meta.type === "message" && meta.role === "assistant" && !hasExplicitDefault && meta.provider && meta.model) {
      models.default = `${meta.provider}/${meta.model}`;
    }
  }
  return { thinkingLevel, model: parseDefaultModel(models) };
}

/**
 * Metadata spine tree: stub entries carrying id/type/parent/timestamp plus
 * the small fields the navigation UI reads (role, capped preview text).
 * Bodies are never parsed for the tree — O(n) metadata, cached per version.
 * Mirrors SessionEntryIndex.tree adjacency, ordering and label resolution.
 */
function spineStubEntry(meta: JournalRecordMeta): SessionEntry {
  const stub: Record<string, unknown> = {
    id: meta.id,
    parentId: meta.parentId,
    type: meta.type,
    timestamp: meta.timestamp,
  };
  if (meta.type === "message") {
    stub.message = {
      role: meta.role ?? "user",
      content: meta.preview ?? (meta.hasImage ? "[image]" : ""),
    };
  } else if (meta.type === "custom_message") {
    stub.customType = meta.customType ?? "";
    stub.content = meta.preview ?? "";
    stub.display = true;
  } else if (meta.type === "branch_summary") {
    stub.summary = meta.preview ?? "";
  } else if (meta.type === "compaction") {
    stub.firstKeptEntryId = meta.firstKeptEntryId ?? "";
  } else if (meta.type === "label") {
    stub.targetId = meta.targetId ?? "";
    stub.label = meta.label ?? undefined;
  } else if (meta.type === "model_change" && meta.modelSelector) {
    stub.model = meta.modelSelector;
    if (meta.modelRole && meta.modelRole !== "default") stub.role = meta.modelRole;
  } else if (meta.type === "thinking_level_change") {
    stub.thinkingLevel = meta.thinkingLevel ?? "off";
  } else if (meta.type === "mode_change") {
    stub.mode = meta.mode ?? "none";
    if (meta.modeData) stub.data = meta.modeData;
  }
  return stub as unknown as SessionEntry;
}

function buildSpineTree(records: JournalRecordMeta[], cache: JournalIndex["treeCache"]): SessionTreeNode[] {
  if (cache && cache.count === records.length) {
    return cache.tree;
  }
  const labels = new Map<string, string>();
  for (const meta of records) {
    if (meta.type === "label" && meta.targetId) {
      if (meta.label) labels.set(meta.targetId, meta.label);
      else labels.delete(meta.targetId);
    }
  }
  const nodes = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const meta of records) {
    const label = labels.get(meta.id);
    nodes.set(meta.id, { entry: spineStubEntry(meta), children: [], ...(label ? { label } : {}) });
  }
  for (const meta of records) {
    const node = nodes.get(meta.id)!;
    if (meta.parentId === null || meta.parentId === meta.id) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(meta.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
    stack.push(...node.children);
  }
  return roots;
}

/**
 * Context usage from the latest usable assistant anchor on the branch.
 * Anchor selection runs over metadata; only the anchor body and the tail
 * after it are parsed. Mirrors getHistoricalContextUsage's model-context
 * semantics (aborted/error/usage-less turns skipped, post-compaction only).
 */
async function contextUsageFromBranch(
  path: JournalRecordMeta[],
  model: { provider: string; modelId: string } | null,
  resolveBody: (meta: JournalRecordMeta) => SessionEntry | null,
): Promise<ContextUsage | undefined> {
  if (!model) return undefined;

  // Select the anchor from metadata first: sessions without a usable
  // assistant response never touch the runtime registry (no I/O on refresh).
  let compactionIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].type === "compaction") {
      compactionIdx = i;
      break;
    }
  }
  let anchorIdx = -1;
  for (let i = path.length - 1; i > compactionIdx; i--) {
    const meta = path[i];
    if (meta.type !== "message" || meta.role !== "assistant") continue;
    const usage = meta.usage as Parameters<typeof hasContextTokenUsage>[0] | undefined;
    const hasSnapshot = typeof meta.contextPromptTokens === "number" && Number.isFinite(meta.contextPromptTokens);
    if (
      meta.stopReason === "aborted"
      || meta.stopReason === "error"
      || !usage
      || (!hasSnapshot && !hasContextTokenUsage(usage))
    ) {
      continue;
    }
    anchorIdx = i;
    break;
  }
  if (anchorIdx < 0) return undefined;

  let contextWindow: number | undefined;
  try {
    const { modelRegistry } = await getOmpRuntime();
    contextWindow = modelRegistry.find(model.provider, model.modelId)?.contextWindow ?? undefined;
  } catch {
    return undefined;
  }
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const anchorMeta = path[anchorIdx];
  const promptTokens = typeof anchorMeta.contextPromptTokens === "number" && Number.isFinite(anchorMeta.contextPromptTokens)
    ? anchorMeta.contextPromptTokens
    : calculatePromptTokens(anchorMeta.usage as Parameters<typeof calculatePromptTokens>[0]);
  if (!Number.isFinite(promptTokens) || promptTokens < 0) return undefined;

  // Tokenize only messages appended after the anchor, in model-context
  // order: retry-recovery/empty-error assistant turns and prewalk/vibe
  // custom messages are excluded there, matching getHistoricalContextUsage.
  let tailTokens = 0;
  for (let i = anchorIdx + 1; i < path.length; i++) {
    const meta = path[i];
    if (meta.type !== "message" && meta.type !== "custom_message" && meta.type !== "branch_summary") continue;
    if (!rendersMessage(meta)) continue;
    const body = resolveBody(meta);
    if (!body) continue;
    if (body.type === "message" && body.message.role === "assistant") {
      const message = body.message as unknown as Extract<OmpAgentMessage, { role: "assistant" }> & { retryRecovery?: boolean };
      if (message.retryRecovery || isEmptyErrorTurn(message)) continue;
    }
    if (body.type === "custom_message" && (body.customType === "prewalk-plan" || body.customType === "vibe-mode-context")) continue;
    const message = entryToUiMessage(body, {});
    if (message) tailTokens += tokenizer.countMessage(message as unknown as OmpAgentMessage);
  }
  const tokens = Math.max(0, promptTokens + tailTokens);
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

/** Total active ms from the durable record spine (metadata timestamps/roles). */
function totalActiveMsFromMeta(records: JournalRecordMeta[]): number {
  return computeSessionTotalActiveMs(records.map((meta) => ({
    type: meta.type,
    timestamp: meta.timestamp,
    ...(meta.role ? { message: { role: meta.role } } : {}),
  })));
}

// ============================================================================
// Anchors
// ============================================================================

const EMPTY_ANCHOR: JournalAnchor = { lastEntryId: null, leafId: null, entryCount: 0, sizeBytes: 0, mtimeMs: 0 };

/** Derive the current durable anchor of a journal file (dead-session path). */
export async function readJournalAnchor(filePath: string): Promise<JournalAnchor> {
  const normalized = normalizePath(filePath);
  let loaded: LoadedJournal;
  try {
    loaded = loadIndex(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ...EMPTY_ANCHOR };
    throw error;
  }
  const { fd, index, fileSize, mtimeMs } = loaded;
  try {
    ensureIndex(fd, index, fileSize, mtimeMs, fileSize);
    return anchorFromIndex(index, fileSize, mtimeMs);
  } finally {
    closeSync(fd);
  }
}

/**
 * Bounded session title for dead-session detail: reads only the file head
 * (fixed-width title slot + session header), never entry bodies. The slot
 * title wins over header.title, matching the SDK loader's fold. Returns
 * undefined when the file has no title yet (or does not exist).
 */
export async function readJournalTitle(filePath: string): Promise<string | undefined> {
  const normalized = normalizePath(filePath);
  let fd: number;
  try {
    fd = openSync(normalized, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const head = readRange(fd, 0, Math.min(64 * 1024, stat.size)).toString("utf8");
    let slotTitle: string | undefined;
    let headerTitle: string | undefined;
    let position = 0;
    // The slot is the physical first line; the header follows it (or leads
    // in legacy files). Stop once both are seen or the head budget runs out.
    while (position < head.length) {
      const newline = head.indexOf("\n", position);
      if (newline === -1) break;
      const line = head.slice(position, newline).trim();
      position = newline + 1;
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "title" && typeof entry.title === "string" && entry.title.length > 0) {
          slotTitle = entry.title;
        } else if (entry.type === "session") {
          if (typeof entry.title === "string" && entry.title.length > 0) headerTitle = entry.title;
          break;
        }
      } catch {
        // unparseable leading line — keep scanning within the head budget
      }
    }
    return slotTitle ?? headerTitle;
  } finally {
    closeSync(fd);
  }
}

function anchorFromIndex(index: JournalIndex, fileSize: number, mtimeMs: number): JournalAnchor {
  return {
    lastEntryId: index.records[index.records.length - 1]?.id ?? null,
    leafId: resolveLeafFromMeta(index.records, index.byId),
    entryCount: index.records.length,
    sizeBytes: fileSize,
    mtimeMs,
  };
}

/**
 * Validate an anchor against the indexed spine. Returns the anchor when it
 * still describes a durable prefix, else null (rewrite/shrink/stale) —
 * callers then derive a fresh anchor. Later appends beyond the anchor are
 * fine: reads are capped at the anchor's last record, never past it.
 */
function bindAnchor(index: JournalIndex, anchor: JournalAnchor | undefined, fileSize: number): JournalAnchor | null {
  if (!anchor) return null;
  if (anchor.sizeBytes > fileSize) return null;
  if (anchor.lastEntryId === null) {
    return anchor.entryCount === 0 ? anchor : null;
  }
  const meta = index.byId.get(anchor.lastEntryId);
  if (!meta || meta.end > anchor.sizeBytes) return null;
  const at = index.records.indexOf(meta);
  if (at + 1 !== anchor.entryCount) return null;
  return anchor;
}

// ============================================================================
// readSessionHistory
// ============================================================================

export async function readSessionHistory(
  filePath: string,
  options: ReadSessionHistoryOptions = {},
): Promise<SessionHistoryResult> {
  const limit = clampHistoryLimit(options.limit);
  const deferOptions = {
    deferThinking: options.deferThinking,
    deferToolResultImages: options.deferToolResultImages,
  };
  const normalized = normalizePath(filePath);

  let loaded: LoadedJournal;
  try {
    loaded = loadIndex(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      if (options.around !== undefined) throw new HistoryTargetUnavailableError("not_found");
      return {
        context: { messages: [], entryIds: [], thinkingLevel: "off", model: null },
        page: { anchor: { ...EMPTY_ANCHOR }, hasEarlier: false, headEntryId: null, hasLater: false, tailEntryId: null },
      };
    }
    throw error;
  }
  const { fd, index, fileSize, mtimeMs } = loaded;
  try {
    // Scan the whole durable file once per version; anchored reads never
    // parse bodies beyond the anchor — the cap is applied to the record set.
    ensureIndex(fd, index, fileSize, mtimeMs, fileSize);

    const boundAnchor = bindAnchor(index, options.anchor, fileSize);
    // around/outline navigation must never silently relocate: a stale anchor
    // (rewrite/shrink under the caller's snapshot) is a structured failure.
    if (options.around !== undefined && options.anchor && !boundAnchor) {
      throw new HistoryTargetUnavailableError("stale_anchor");
    }
    let visible = index.records;
    if (boundAnchor) {
      visible = boundAnchor.lastEntryId === null
        ? []
        : index.records.slice(0, boundAnchor.entryCount);
    }
    const visibleById = boundAnchor ? new Map(visible.map((record) => [record.id, record])) : index.byId;
    const anchor = boundAnchor ?? anchorFromIndex(index, fileSize, mtimeMs);
    const replayedLeaf = resolveLeafFromMeta(visible, visibleById);
    const leafId = options.leafId === null
      ? null
      : options.leafId !== undefined && visibleById.has(options.leafId)
        ? options.leafId
        : replayedLeaf;

    if (index.version !== undefined && index.version < 3) {
      return legacyRead(fd, index, legacyScanExtent(index, visible, boundAnchor), options.leafId, limit, options, anchor, deferOptions);
    }

    const path = branchMetaPath(visibleById, leafId);
    const display = displayMetaPath(path);
    const settings = settingsFromMeta(path);

    // Display positions that render a message — metadata only.
    const renderPositions = renderedPositions(display);

    // Select the window over positions; parse bodies only for the slice.
    let start: number;
    let end: number;
    let hasEarlier: boolean;
    let hasLater: boolean;
    if (options.around !== undefined) {
      const at = renderPositions.findIndex((pos) => display[pos].id === options.around);
      if (at < 0) {
        // Missing, compacted-away or other-branch target: structured failure,
        // NEVER a tail fallback that would silently relocate the reader.
        throw new HistoryTargetUnavailableError(
          visibleById.has(options.around) ? "not_visible" : "not_found",
        );
      }
      ({ start, end } = aroundRange(at, renderPositions.length, limit));
      hasEarlier = start > 0;
      hasLater = end < renderPositions.length;
    } else if (options.after !== undefined) {
      const at = renderPositions.findIndex((pos) => display[pos].id === options.after);
      if (at >= 0) {
        start = at + 1;
        end = options.limit !== undefined ? Math.min(start + limit, renderPositions.length) : renderPositions.length;
      } else {
        // Unknown `after` (rewritten away): fall back to the tail window so
        // the client re-syncs instead of silently seeing nothing.
        start = Math.max(0, renderPositions.length - limit);
        end = renderPositions.length;
      }
      hasEarlier = start > 0;
      hasLater = end < renderPositions.length;
    } else if (options.before !== undefined) {
      const at = renderPositions.findIndex((pos) => display[pos].id === options.before);
      end = at >= 0 ? at : renderPositions.length;
      start = Math.max(0, end - limit);
      hasEarlier = start > 0;
      hasLater = end < renderPositions.length;
    } else {
      end = renderPositions.length;
      start = Math.max(0, end - limit);
      hasEarlier = start > 0;
      hasLater = end < renderPositions.length;
    }

    const messages: AgentMessage[] = [];
    const entryIds: string[] = [];
    for (let i = start; i < end; i++) {
      const meta = display[renderPositions[i]];
      const body = bodyAt(fd, index, meta);
      if (!body) continue;
      let message: AgentMessage | null;
      try {
        message = entryToUiMessage(body, deferOptions);
      } catch (error) {
        // A malformed around TARGET must fail structured, not 500; other
        // entries keep the existing skip-on-bad-body behavior.
        if (meta.id === options.around) throw new HistoryTargetUnavailableError("not_found");
        throw error;
      }
      if (!message) continue;
      messages.push(message);
      entryIds.push(meta.id);
    }

    // Frozen contract: an around window MUST include its target. A body that
    // cannot be read/converted inside the slice is a structured failure, not
    // a silently relocated page.
    if (options.around !== undefined && !entryIds.includes(options.around)) {
      throw new HistoryTargetUnavailableError("not_found");
    }

    const context: SessionContext = {
      messages,
      entryIds,
      thinkingLevel: settings.thinkingLevel,
      model: settings.model,
    };
    const page: HistoryPage = {
      anchor,
      hasEarlier,
      headEntryId: entryIds[0] ?? null,
      hasLater,
      tailEntryId: renderPositions.length > 0 ? display[renderPositions[renderPositions.length - 1]].id : null,
    };
    const tree = buildSpineTree(visible, index.treeCache);
    if (!boundAnchor) index.treeCache = { count: visible.length, tree };
    // around reads stay body-bounded to the selected slice: usage would parse
    // the assistant anchor + every later body, so it is skipped for around.
    const contextUsage = options.around !== undefined
      ? undefined
      : await contextUsageFromBranch(path, settings.model, (meta) => bodyAt(fd, index, meta));
    return {
      context,
      page,
      tree,
      ...(contextUsage ? { contextUsage } : {}),
      totalActiveMs: totalActiveMsFromMeta(visible),
      ...(index.header ? { header: foldSlotTitle(index.header, index.slotTitle) } : {}),
    };
  } finally {
    closeSync(fd);
  }
}

export interface ReadSessionOutlineOptions {
  /** Branch leaf; undefined = replayed leaf, null = no active branch. */
  leafId?: string | null;
  /** Bound the outline to this durable position; stale anchors throw. */
  anchor?: JournalAnchor;
}

/**
 * Metadata-only transcript outline (#104): one entry per durable
 * user/assistant/summary message on the visible branch, with a bounded
 * deterministic preview and the rendered-message ordinal. Modern journals
 * never parse entry bodies here — the spine scan (once per file version)
 * carries ids, roles, timestamps and capped previews/tool labels. Legacy
 * journals reuse the cached migrated view; ids match the window readers'.
 * Stale anchors raise HistoryTargetUnavailableError instead of silently
 * re-deriving, so an outline can never relocate a navigation snapshot.
 */
export async function readSessionOutline(
  filePath: string,
  options: ReadSessionOutlineOptions = {},
): Promise<SessionOutline> {
  const normalized = normalizePath(filePath);
  let loaded: LoadedJournal;
  try {
    loaded = loadIndex(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // A valid EMPTY anchor (fresh all-zero boundary of a transient live
      // session) describes "nothing durable yet": empty outline, not stale.
      // A non-empty anchor against a missing file is a real stale snapshot.
      if (options.anchor && (options.anchor.entryCount !== 0 || options.anchor.lastEntryId !== null)) {
        throw new HistoryTargetUnavailableError("stale_anchor");
      }
      return { anchor: options.anchor ?? { ...EMPTY_ANCHOR }, leafId: null, entries: [] };
    }
    throw error;
  }
  const { fd, index, fileSize, mtimeMs } = loaded;
  try {
    ensureIndex(fd, index, fileSize, mtimeMs, fileSize);
    const boundAnchor = bindAnchor(index, options.anchor, fileSize);
    if (options.anchor && !boundAnchor) throw new HistoryTargetUnavailableError("stale_anchor");
    const visible = boundAnchor
      ? boundAnchor.lastEntryId === null ? [] : index.records.slice(0, boundAnchor.entryCount)
      : index.records;
    const visibleById = boundAnchor ? new Map(visible.map((record) => [record.id, record])) : index.byId;
    const anchor = boundAnchor ?? anchorFromIndex(index, fileSize, mtimeMs);

    if (index.version !== undefined && index.version < 3) {
      const scanEnd = legacyScanExtent(index, visible, boundAnchor);
      // Anchored snapshots must never silently re-migrate (fresh random ids).
      // Decide stale BEFORE any migration so a failed check cannot heal the
      // cache with a wrong-id view: detected prefix rewrite, or no retained
      // view while the file changed since the snapshot (rewrite/eviction).
      // Matching mtime with no view = never-read extent, legitimately migrates.
      if (boundAnchor) {
        if (invalidateRewrittenLegacyViews(fd, index, scanEnd)) {
          throw new HistoryTargetUnavailableError("stale_anchor");
        }
        const retained = index.legacyViews.some((view) => view.scanEnd === scanEnd);
        if (!retained && (
          boundAnchor.mtimeMs !== index.mtimeMs
          || index.legacyEvictedExtents.includes(scanEnd)
        )) {
          throw new HistoryTargetUnavailableError("stale_anchor");
        }
      }
      const legacy = legacyView(fd, index, scanEnd);
      // Same leaf contract as legacyRead: null clears, unknown replays.
      const resolvedLeaf = options.leafId === null
        ? null
        : options.leafId !== undefined && legacy.byId.has(options.leafId)
          ? options.leafId
          : undefined;
      const full = buildSessionContext(legacy.entries, resolvedLeaf, {});
      const entries: SessionOutlineEntry[] = [];
      for (let ordinal = 0; ordinal < full.entryIds.length; ordinal++) {
        const meta = legacy.byId.get(full.entryIds[ordinal]);
        if (!meta) continue;
        const role = outlineRole(meta);
        if (!role) continue;
        entries.push({ entryId: meta.id, role, preview: outlinePreview(meta), timestamp: meta.timestamp, ordinal });
      }
      const leafId = resolvedLeaf === undefined ? resolveLeafFromMeta(legacy.metas, legacy.byId) : resolvedLeaf;
      return { anchor, leafId, entries };
    }

    const replayedLeaf = resolveLeafFromMeta(visible, visibleById);
    const leafId = options.leafId === null
      ? null
      : options.leafId !== undefined && visibleById.has(options.leafId)
        ? options.leafId
        : replayedLeaf;
    const display = displayMetaPath(branchMetaPath(visibleById, leafId));
    const positions = renderedPositions(display);
    const entries: SessionOutlineEntry[] = [];
    for (let ordinal = 0; ordinal < positions.length; ordinal++) {
      const meta = display[positions[ordinal]];
      const role = outlineRole(meta);
      if (!role) continue;
      entries.push({ entryId: meta.id, role, preview: outlinePreview(meta), timestamp: meta.timestamp, ordinal });
    }
    return { anchor, leafId, entries };
  } finally {
    closeSync(fd);
  }
}

/** The fixed title slot is authoritative over the header's inline title. */
function foldSlotTitle(header: SessionHeader, slotTitle: string | undefined): SessionHeader {
  if (slotTitle === undefined) return header;
  return { ...header, title: slotTitle };
}

/**
 * Byte extent a legacy read must cover. With records, the last visible
 * record's end bounds it. With an EMPTY visible set under an anchor (idless
 * v1 spines, or a header-only empty snapshot), the anchor's byte size bounds
 * it — never the current scanned extent, which would leak post-anchor
 * appends into the snapshot. Unanchored reads use the full scanned extent.
 */
function legacyScanExtent(index: JournalIndex, visible: JournalRecordMeta[], boundAnchor: JournalAnchor | null): number {
  if (visible.length > 0) return visible[visible.length - 1].end;
  if (boundAnchor) return Math.min(boundAnchor.sizeBytes, index.scannedTo);
  return index.scannedTo;
}

/**
 * Cache lookup of a retained legacy view with the same bounded rewrite
 * probes legacyView applies (no migration). Returns undefined on miss or
 * detected rewrite (views dropped); callers then build a fresh view.
 * Anchored navigation reuses its snapshot's view so migrated target ids
 * stay stable across later appends.
 */
function retainedLegacyView(fd: number, index: JournalIndex, scanEnd: number): LegacyCache | undefined {
  invalidateRewrittenLegacyViews(fd, index, scanEnd);
  const probeStart = Math.max(0, scanEnd - LEGACY_PROBE_BYTES);
  const probe = readRange(fd, probeStart, scanEnd).toString("utf8");
  const at = index.legacyViews.findIndex((view) => view.scanEnd === scanEnd);
  if (at < 0) return undefined;
  const [view] = index.legacyViews.splice(at, 1);
  if (view.tailProbe !== probe) {
    index.legacyViews = [];
    return undefined;
  }
  index.legacyViews.push(view); // refresh LRU position
  return view;
}

/**
 * Legacy rewrite probe: when the scan boundary moved past a requested extent
 * (append), the bytes captured at the old boundary must still sit at the same
 * offsets; a mismatch means the prefix was rewritten — drop every retained
 * view before any cache hit. Returns true when a rewrite was detected.
 */
function invalidateRewrittenLegacyViews(fd: number, index: JournalIndex, scanEnd: number): boolean {
  if (index.version === undefined || index.version >= 3) return false;
  if (
    index.legacyBoundaryProbe
    && index.legacyBoundaryProbe.end > scanEnd
  ) {
    const p = index.legacyBoundaryProbe;
    const expected = readRange(fd, p.start, p.end).toString("utf8");
    if (expected !== p.text) {
      index.legacyViews = [];
      return true;
    }
  }
  return false;
}

/**
 * Legacy journals (header version < 3) need SDK migrations that renumber ids
 * and rewire parents, so metadata offsets cannot address entries directly.
 * Load all visible bodies once, migrate, and reuse the SDK-backed conversion;
 * pagination semantics stay identical. Modern journals never take this path.
 */
async function legacyRead(
  fd: number,
  index: JournalIndex,
  scanEnd: number,
  leafId: string | null | undefined,
  limit: number,
  options: ReadSessionHistoryOptions,
  anchor: JournalAnchor,
  deferOptions: { deferThinking?: boolean; deferToolResultImages?: boolean },
): Promise<SessionHistoryResult> {
  // Navigation-only strictness (tail/before/after keep re-deriving): decide
  // stale BEFORE migration so a failed check never re-inserts a wrong-id view.
  if (options.around !== undefined && options.anchor) {
    if (invalidateRewrittenLegacyViews(fd, index, scanEnd)) {
      throw new HistoryTargetUnavailableError("stale_anchor");
    }
    const retained = index.legacyViews.some((view) => view.scanEnd === scanEnd);
    if (!retained && (
      options.anchor.mtimeMs !== index.mtimeMs
      || index.legacyEvictedExtents.includes(scanEnd)
    )) {
      throw new HistoryTargetUnavailableError("stale_anchor");
    }
  }
  const legacy = legacyView(fd, index, scanEnd);
  const { entries, metas, byId } = legacy;
  // Explicit migrated leaf honored when it exists; otherwise replay the
  // migrated leaf (undefined lets the SDK resolve it, null clears it).
  const resolvedLeaf = leafId === null
    ? null
    : leafId !== undefined && byId.has(leafId)
      ? leafId
      : undefined;
  // Target-only conversion pre-check: a malformed around TARGET must fail
  // structured, not 500. Unrelated malformed entries keep prior behavior
  // (buildSessionContext below is intentionally NOT wrapped).
  if (options.around !== undefined) {
    const targetEntry = legacy.entriesById.get(options.around);
    if (targetEntry) {
      try {
        entryToUiMessage(targetEntry, deferOptions);
      } catch {
        throw new HistoryTargetUnavailableError("not_found");
      }
    }
  }
  const full = buildSessionContext(entries, resolvedLeaf, deferOptions);
  // around windows skip usage: it tokenizes the assistant anchor + tail, and
  // around responses stay bounded to the selected slice (legacy bodies are
  // already migrated in full by legacyView, the compatibility path).
  const contextUsage = options.around !== undefined
    ? undefined
    : await contextUsageFromBranch(
      branchMetaPath(byId, resolvedLeaf === undefined ? resolveLeafFromMeta(metas, byId) : resolvedLeaf),
      full.model,
      (meta) => legacy.entriesById.get(meta.id) ?? null,
    );
  const rendered = full.messages.map((message, i) => ({ id: full.entryIds[i], message }));
  let windowEntries: typeof rendered;
  let hasEarlier: boolean;
  let hasLater: boolean;
  if (options.around !== undefined) {
    const at = rendered.findIndex((item) => item.id === options.around);
    if (at < 0) {
      // Same structured contract as the modern path — never a tail fallback.
      // The pre-migration guard already rejected stale anchored snapshots,
      // so an absent id here is provably not on the visible branch.
      throw new HistoryTargetUnavailableError(byId.has(options.around) ? "not_visible" : "not_found");
    }
    const { start, end } = aroundRange(at, rendered.length, limit);
    windowEntries = rendered.slice(start, end);
    hasEarlier = start > 0;
    hasLater = end < rendered.length;
  } else if (options.after !== undefined) {
    const afterIdx = rendered.findIndex((item) => item.id === options.after);
    windowEntries = afterIdx >= 0 ? rendered.slice(afterIdx + 1) : rendered.slice(-limit);
    if (options.limit !== undefined) windowEntries = windowEntries.slice(0, limit);
    hasEarlier = (afterIdx >= 0 ? afterIdx + 1 : rendered.length - windowEntries.length) > 0;
    hasLater = afterIdx >= 0
      ? afterIdx + 1 + windowEntries.length < rendered.length
      : false;
  } else if (options.before !== undefined) {
    const beforeIdx = rendered.findIndex((item) => item.id === options.before);
    const end = beforeIdx >= 0 ? beforeIdx : rendered.length;
    windowEntries = rendered.slice(Math.max(0, end - limit), end);
    hasEarlier = end - windowEntries.length > 0;
    hasLater = end < rendered.length;
  } else {
    windowEntries = rendered.slice(-limit);
    hasEarlier = rendered.length > windowEntries.length;
    hasLater = false;
  }
  return {
    context: {
      messages: windowEntries.map((item) => item.message),
      entryIds: windowEntries.map((item) => item.id),
      thinkingLevel: full.thinkingLevel,
      model: full.model,
    },
    page: {
      anchor,
      hasEarlier,
      headEntryId: windowEntries[0]?.id ?? null,
      hasLater,
      tailEntryId: rendered[rendered.length - 1]?.id ?? null,
    },
    tree: legacy.tree,
    ...(contextUsage ? { contextUsage } : {}),
    totalActiveMs: computeSessionTotalActiveMs(entries),
    ...(index.header ? { header: foldSlotTitle(index.header, index.slotTitle) } : {}),
  };
}

/**
 * Migrated legacy view for one byte extent, retained in a bounded per-journal
 * LRU. v1 ids are assigned randomly by the migration itself, so each extent
 * migrates ONCE and its view stays cached: an anchored navigation snapshot
 * keeps its migrated target ids even after later appends grow the file (the
 * prefix extent's cached view is reused, never re-migrated). Views drop only
 * on LRU eviction or a detected rewrite (spine invalidation).
 */
function legacyView(fd: number, index: JournalIndex, scanEnd: number): LegacyCache {
  const retained = retainedLegacyView(fd, index, scanEnd);
  if (retained) return retained;
  const probeStart = Math.max(0, scanEnd - LEGACY_PROBE_BYTES);
  const probe = readRange(fd, probeStart, scanEnd).toString("utf8");

  const raw: Record<string, unknown>[] = [];
  let pending = "";
  for (let position = 0; position < scanEnd;) {
    const chunk = readRange(fd, position, Math.min(position + 1024 * 1024, scanEnd));
    if (chunk.length === 0) break;
    position += chunk.length;
    pending += chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (isPlainRecord(entry) && entry.type !== "session" && entry.type !== "title") raw.push(entry);
      } catch {
        // malformed record — skipped like the SDK loader
      }
    }
  }
  // Migrations expect the header in the list; synthesize one from the spine.
  const withHeader = [{ type: "session", version: index.version ?? 1 }, ...raw];
  migrateToCurrentVersion(withHeader as unknown as OmpSessionEntry[]);
  const entries = withHeader.slice(1) as unknown as SessionEntry[];
  resolveBlobRefsInEntriesSync(entries as unknown as OmpSessionEntry[], getBlobStore());

  // Metadata over the migrated entries: real ids/parents plus the same cheap
  // fields the modern spine extracts, so tree/leaf/settings helpers reuse.
  const metas: JournalRecordMeta[] = [];
  const byId = new Map<string, JournalRecordMeta>();
  const entriesById = new Map<string, SessionEntry>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as unknown as Record<string, unknown>;
    const meta = metaFromEntry(entry, i, i + 1);
    if (!meta) continue;
    metas.push(meta);
    byId.set(meta.id, meta);
    entriesById.set(meta.id, entries[i]);
  }
  const cache: LegacyCache = {
    scanEnd,
    entries,
    entriesById,
    metas,
    byId,
    tree: buildSpineTree(metas, undefined),
    tailProbe: probe,
  };
  index.legacyViews.push(cache);
  while (index.legacyViews.length > MAX_LEGACY_VIEWS_PER_JOURNAL) {
    const evicted = index.legacyViews.shift();
    if (evicted) {
      index.legacyEvictedExtents.push(evicted.scanEnd);
      if (index.legacyEvictedExtents.length > MAX_LEGACY_VIEWS_PER_JOURNAL * 2) index.legacyEvictedExtents.shift();
    }
  }
  return cache;
}
