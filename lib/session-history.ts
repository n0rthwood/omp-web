// Journal-backed history windows (issue #99).
//
// History for the web chat comes from the durable session .jsonl — the same
// source the export renders — never from realtime ring replay. This module
// provides:
//   * the frozen splice types shared with the host bridge and the window UI
//     (JournalAnchor / HistoryBoundary / HistoryPage),
//   * readSessionHistory(): bounded tail/before/after pages with transcript
//     semantics identical to buildSessionContext (compaction elision, branch
//     parent chain, entryIds parallel to messages),
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
}

export interface ReadSessionHistoryOptions {
  /** Page size. Default 5 (initial window); UI pages use 20; hard cap 100. */
  limit?: number;
  /** Return up to `limit` messages strictly before this entry id. */
  before?: string;
  /** Warm delta: messages strictly after this entry id, up to the anchor. */
  after?: string;
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
  /** custom_message only. */
  customType?: string;
  /** custom_message only: content is string/array (renders) vs other (null). */
  contentRenderable?: boolean;
  /** branch_summary only. */
  hasSummary?: boolean;
  /** compaction only. */
  firstKeptEntryId?: string;
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
   * Legacy (version < 3) migrated view, keyed by scanned byte extent. The
   * v1 migration assigns fresh ids, so it must run ONCE per file version —
   * re-migrating per page would make before/after cursors unstable.
   */
  legacyCache: LegacyCache | undefined;
}


interface LegacyCache {
  scanEnd: number;
  entries: SessionEntry[];
  entriesById: Map<string, SessionEntry>;
  metas: JournalRecordMeta[];
  byId: Map<string, JournalRecordMeta>;
  tree: SessionTreeNode[];
}
const MAX_CACHED_JOURNALS = 8;
const MAX_CACHED_BODIES_PER_JOURNAL = 400;

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
      for (const block of content) {
        if (!isPlainRecord(block)) continue;
        if (block.type === "image") meta.hasImage = true;
        if (block.type === "text") preview = appendPreview(preview, block.text);
        if (preview.length >= PREVIEW_CAP) break;
      }
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
    index.legacyCache = undefined;
  }
  scanForward(fd, index, scanBound);
  index.sizeBytes = fileSize;
  index.mtimeMs = mtimeMs;
}

function verifyTailRecord(fd: number, index: JournalIndex, fileSize: number): boolean {
  const last = index.records[index.records.length - 1];
  if (!last) return index.scannedTo === 0;
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
  if (head === index.headFingerprint) return true;
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
        legacyCache: undefined,
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
      return {
        context: { messages: [], entryIds: [], thinkingLevel: "off", model: null },
        page: { anchor: { ...EMPTY_ANCHOR }, hasEarlier: false, headEntryId: null },
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
      return legacyRead(fd, index, visible, options.leafId, limit, options, anchor, deferOptions);
    }

    const path = branchMetaPath(visibleById, leafId);
    const display = displayMetaPath(path);
    const settings = settingsFromMeta(path);

    // Display positions that render a message — metadata only.
    const renderPositions: number[] = [];
    for (let i = 0; i < display.length; i++) {
      if (rendersMessage(display[i])) renderPositions.push(i);
    }

    // Select the window over positions; parse bodies only for the slice.
    let start: number;
    let end: number;
    let hasEarlier: boolean;
    if (options.after !== undefined) {
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
    } else if (options.before !== undefined) {
      const at = renderPositions.findIndex((pos) => display[pos].id === options.before);
      end = at >= 0 ? at : renderPositions.length;
      start = Math.max(0, end - limit);
      hasEarlier = start > 0;
    } else {
      end = renderPositions.length;
      start = Math.max(0, end - limit);
      hasEarlier = start > 0;
    }

    const messages: AgentMessage[] = [];
    const entryIds: string[] = [];
    for (let i = start; i < end; i++) {
      const meta = display[renderPositions[i]];
      const body = bodyAt(fd, index, meta);
      if (!body) continue;
      const message = entryToUiMessage(body, deferOptions);
      if (!message) continue;
      messages.push(message);
      entryIds.push(meta.id);
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
    };
    const tree = buildSpineTree(visible, index.treeCache);
    if (!boundAnchor) index.treeCache = { count: visible.length, tree };
    const contextUsage = await contextUsageFromBranch(path, settings.model, (meta) => bodyAt(fd, index, meta));
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

/** The fixed title slot is authoritative over the header's inline title. */
function foldSlotTitle(header: SessionHeader, slotTitle: string | undefined): SessionHeader {
  if (slotTitle === undefined) return header;
  return { ...header, title: slotTitle };
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
  visible: JournalRecordMeta[],
  leafId: string | null | undefined,
  limit: number,
  options: ReadSessionHistoryOptions,
  anchor: JournalAnchor,
  deferOptions: { deferThinking?: boolean; deferToolResultImages?: boolean },
): Promise<SessionHistoryResult> {
  const legacy = legacyView(fd, index, visible);
  const { entries, metas, byId } = legacy;
  // Explicit migrated leaf honored when it exists; otherwise replay the
  // migrated leaf (undefined lets the SDK resolve it, null clears it).
  const resolvedLeaf = leafId === null
    ? null
    : leafId !== undefined && byId.has(leafId)
      ? leafId
      : undefined;
  const full = buildSessionContext(entries, resolvedLeaf, deferOptions);
  const contextUsage = await contextUsageFromBranch(
    branchMetaPath(byId, resolvedLeaf === undefined ? resolveLeafFromMeta(metas, byId) : resolvedLeaf),
    full.model,
    (meta) => legacy.entriesById.get(meta.id) ?? null,
  );
  const rendered = full.messages.map((message, i) => ({ id: full.entryIds[i], message }));
  let windowEntries: typeof rendered;
  let hasEarlier: boolean;
  if (options.after !== undefined) {
    const afterIdx = rendered.findIndex((item) => item.id === options.after);
    windowEntries = afterIdx >= 0 ? rendered.slice(afterIdx + 1) : rendered.slice(-limit);
    if (options.limit !== undefined) windowEntries = windowEntries.slice(0, limit);
    hasEarlier = (afterIdx >= 0 ? afterIdx + 1 : rendered.length - windowEntries.length) > 0;
  } else if (options.before !== undefined) {
    const beforeIdx = rendered.findIndex((item) => item.id === options.before);
    const end = beforeIdx >= 0 ? beforeIdx : rendered.length;
    windowEntries = rendered.slice(Math.max(0, end - limit), end);
    hasEarlier = end - windowEntries.length > 0;
  } else {
    windowEntries = rendered.slice(-limit);
    hasEarlier = rendered.length > windowEntries.length;
  }
  return {
    context: {
      messages: windowEntries.map((item) => item.message),
      entryIds: windowEntries.map((item) => item.id),
      thinkingLevel: full.thinkingLevel,
      model: full.model,
    },
    page: { anchor, hasEarlier, headEntryId: windowEntries[0]?.id ?? null },
    tree: legacy.tree,
    ...(contextUsage ? { contextUsage } : {}),
    totalActiveMs: computeSessionTotalActiveMs(entries),
    ...(index.header ? { header: foldSlotTitle(index.header, index.slotTitle) } : {}),
  };
}

/**
 * Migrated legacy view, cached per scanned byte extent. v1 ids are assigned
 * by the migration itself, so re-running it per page would renumber ids and
 * break before/after cursors; one migration per file version keeps them
 * stable. Invalidated with the spine on any rewrite/append.
 */
function legacyView(fd: number, index: JournalIndex, visible: JournalRecordMeta[]): LegacyCache {
  // v1 records have no ids, so the spine may be empty even though the file
  // has content: fall back to the scanned byte extent when unanchored.
  const scanEnd = visible.length > 0 ? visible[visible.length - 1].end : index.scannedTo;
  if (index.legacyCache && index.legacyCache.scanEnd === scanEnd) return index.legacyCache;

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
  };
  index.legacyCache = cache;
  return cache;
}
