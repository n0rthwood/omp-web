// Journal-backed chat window helpers (issue #99).
//
// Pure client-side logic for the windowed history UI: the localStorage cache
// (machine/user/session scoped, anchor-versioned, byte-bounded), the
// journal/live splice reconciliation (content/position upserts — wire
// messageIds are process-scoped, never journal entry ids), and the
// reuse/delta/replace refresh decision. No React, no fs: the hook composes
// these with the bounded tail/before/after routes.

import type { AgentMessage } from "./types";
import type { HistoryPage, JournalAnchor } from "./session-history";
import { machineStorageKey } from "./api-path";

/** Initial durable window: the most recent 5 messages (owner decision). */
export const INITIAL_HISTORY_WINDOW = 5;
/** One explicit "Load earlier" click prepends 20 messages (owner decision). */
export const EARLIER_PAGE_SIZE = 20;

export const HISTORY_CACHE_VERSION = 1;
const CACHE_PREFIX = "omp-web:history-window:v1:";
/** One session's cached window may not exceed ~1MB of serialized JSON. */
const MAX_CACHE_ENTRY_CHARS = 1_000_000;
/** All cached windows together stay under ~8MB; oldest evicted first. */
const MAX_CACHE_TOTAL_CHARS = 8_000_000;
const ANONYMOUS_USER = "__anonymous";

/** The durable journal window a session renders (live tail excluded). */
export interface HistoryWindowSnapshot {
  messages: AgentMessage[];
  entryIds: string[];
  anchor: JournalAnchor;
  hasEarlier: boolean;
  headEntryId: string | null;
  leafId: string | null;
}

interface CacheRecord extends HistoryWindowSnapshot {
  v: number;
  updatedAt: number;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function historyCacheKey(user: string | null, sessionId: string, machineId?: string): string {
  const userScope = user ? encodeURIComponent(user) : ANONYMOUS_USER;
  return machineStorageKey(`${CACHE_PREFIX}${userScope}:${encodeURIComponent(sessionId)}`, machineId);
}

function isJournalAnchor(value: unknown): value is JournalAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Record<string, unknown>;
  return (anchor.lastEntryId === null || typeof anchor.lastEntryId === "string")
    && (anchor.leafId === null || typeof anchor.leafId === "string")
    && typeof anchor.entryCount === "number"
    && typeof anchor.sizeBytes === "number"
    && typeof anchor.mtimeMs === "number";
}

function parseRecord(raw: string | null): CacheRecord | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as CacheRecord;
    if (!record || record.v !== HISTORY_CACHE_VERSION) return null;
    if (!Array.isArray(record.messages) || !Array.isArray(record.entryIds)) return null;
    if (record.messages.length !== record.entryIds.length) return null;
    if (!isJournalAnchor(record.anchor)) return null;
    if (typeof record.hasEarlier !== "boolean") return null;
    if (record.headEntryId !== null && typeof record.headEntryId !== "string") return null;
    if (record.leafId !== null && typeof record.leafId !== "string") return null;
    if (typeof record.updatedAt !== "number") return null;
    return record;
  } catch {
    return null;
  }
}

/** Synchronous cache bootstrap: the cached window renders before any fetch. */
export function readHistoryCache(
  storage: StorageLike | null | undefined,
  user: string | null,
  sessionId: string,
  machineId?: string,
): HistoryWindowSnapshot | null {
  if (!storage) return null;
  try {
    const record = parseRecord(storage.getItem(historyCacheKey(user, sessionId, machineId)));
    if (!record) return null;
    return {
      messages: record.messages,
      entryIds: record.entryIds,
      anchor: record.anchor,
      hasEarlier: record.hasEarlier,
      headEntryId: record.headEntryId,
      leafId: record.leafId,
    };
  } catch {
    return null;
  }
}

/**
 * Persist the durable window. Entries over the per-session cap are dropped
 * (never truncated mid-message); the total budget evicts oldest records.
 * Quota/serialization failures are silent — the cache is an optimization.
 */
export function writeHistoryCache(
  storage: StorageLike | null | undefined,
  user: string | null,
  sessionId: string,
  snapshot: HistoryWindowSnapshot,
  machineId?: string,
): void {
  if (!storage) return;
  const key = historyCacheKey(user, sessionId, machineId);
  try {
    if (snapshot.messages.length === 0) {
      storage.removeItem(key);
      return;
    }
    const record: CacheRecord = { ...snapshot, v: HISTORY_CACHE_VERSION, updatedAt: Date.now() };
    const raw = JSON.stringify(record);
    if (raw.length > MAX_CACHE_ENTRY_CHARS) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, raw);
    evictOverBudget(storage, machineId);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage unavailable: nothing to clean up.
    }
  }
}

export function clearHistoryCache(
  storage: StorageLike | null | undefined,
  user: string | null,
  sessionId: string,
  machineId?: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(historyCacheKey(user, sessionId, machineId));
  } catch {
    // Ignore.
  }
}

function evictOverBudget(storage: StorageLike, machineId?: string): void {
  const prefix = machineStorageKey(CACHE_PREFIX, machineId);
  const entries: Array<{ key: string; updatedAt: number; chars: number }> = [];
  let total = 0;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const record = parseRecord(raw);
    entries.push({ key, updatedAt: record?.updatedAt ?? 0, chars: raw.length });
    total += raw.length;
  }
  if (total <= MAX_CACHE_TOTAL_CHARS) return;
  entries.sort((left, right) => left.updatedAt - right.updatedAt);
  for (const entry of entries) {
    if (total <= MAX_CACHE_TOTAL_CHARS) break;
    try {
      storage.removeItem(entry.key);
      total -= entry.chars;
    } catch {
      // Keep trying the rest.
    }
  }
}

/** Exact anchor identity: all five version fields (mtime/size/count/leaf/id). */
export function sameAnchor(left: JournalAnchor | null | undefined, right: JournalAnchor | null | undefined): boolean {
  if (!left || !right) return false;
  return left.lastEntryId === right.lastEntryId
    && left.leafId === right.leafId
    && left.entryCount === right.entryCount
    && left.sizeBytes === right.sizeBytes
    && left.mtimeMs === right.mtimeMs;
}

/** True when `fresh` is a pure append past `cached` on the same branch. */
export function anchorIsAppend(cached: JournalAnchor, fresh: JournalAnchor): boolean {
  return cached.leafId === fresh.leafId
    && fresh.entryCount >= cached.entryCount
    && fresh.sizeBytes >= cached.sizeBytes;
}

export type WindowRefreshDecision = "reuse" | "delta" | "replace";

/**
 * How a bounded tail response relates to the window already on screen:
 * unchanged anchor → keep every cached page; pure append → fetch only the
 * delta after the cached last durable entry; anything else (cold start,
 * rewrite, branch switch, shrink) → replace with the fresh tail.
 */
export function decideWindowRefresh(
  cachedAnchor: JournalAnchor | null,
  cachedEntryCount: number,
  freshPage: HistoryPage | null | undefined,
): WindowRefreshDecision {
  if (!freshPage) return "replace";
  if (!cachedAnchor || cachedEntryCount === 0) return "replace";
  if (sameAnchor(cachedAnchor, freshPage.anchor)) return "reuse";
  if (anchorIsAppend(cachedAnchor, freshPage.anchor)) return "delta";
  return "replace";
}

/**
 * Content identity for journal/live reconciliation. Wire messageIds are
 * process-scoped (never journal entry ids), and deferred reads replace
 * thinking/image bodies with placeholders — so identity uses only the
 * non-deferred substance of a message, per role.
 */
export function messageContentKey(message: Partial<AgentMessage>): string {
  const msg = message as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : "";
  if (role === "toolResult") {
    return JSON.stringify(["toolResult", msg.toolCallId ?? null, msg.isError ?? false]);
  }
  if (role === "bashExecution") {
    return JSON.stringify(["bashExecution", msg.command ?? "", msg.excludeFromContext ?? false]);
  }
  if (role === "assistant") {
    const blocks = Array.isArray(msg.content)
      ? (msg.content as Array<Record<string, unknown>>)
        .filter((block) => block && (block.type === "text" || block.type === "toolCall"))
        .map((block) => block.type === "text"
          ? ["text", block.text ?? ""]
          : ["toolCall", block.id ?? null, block.name ?? "", block.arguments ?? null])
      : [];
    return JSON.stringify(["assistant", msg.timestamp ?? null, blocks]);
  }
  return JSON.stringify([role, msg.content ?? null, msg.customType ?? null]);
}

/**
 * Append a delta page, skipping entries already present (idempotent). The
 * server guarantees entryIds parallel to messages; a malformed delta (missing
 * id or length mismatch) returns null so the caller falls back to a fresh
 * bounded tail instead of silently misaligning the window.
 */
export function mergeDurableWindow(
  prevMessages: AgentMessage[],
  prevEntryIds: string[],
  deltaMessages: AgentMessage[],
  deltaEntryIds: string[],
): { messages: AgentMessage[]; entryIds: string[] } | null {
  if (deltaMessages.length !== deltaEntryIds.length) return null;
  const known = new Set(prevEntryIds);
  const messages = [...prevMessages];
  const entryIds = [...prevEntryIds];
  for (let index = 0; index < deltaMessages.length; index += 1) {
    const id = deltaEntryIds[index];
    if (typeof id !== "string") return null;
    if (known.has(id)) continue;
    messages.push(deltaMessages[index]);
    entryIds.push(id);
    known.add(id);
  }
  return { messages, entryIds };
}

/**
 * The live suffix (messages past the durable window) after a refresh:
 * entries the delta just made durable leave the suffix (no duplicates),
 * and local-only command output bubbles drop as a full reload always did.
 */
export function reconcileLiveSuffix(suffix: AgentMessage[], deltaMessages: AgentMessage[]): AgentMessage[] {
  const promotedCounts = new Map<string, number>();
  for (const delta of deltaMessages) {
    const key = messageContentKey(delta);
    promotedCounts.set(key, (promotedCounts.get(key) ?? 0) + 1);
  }
  return suffix.filter((message) => {
    const localCommand = message.role === "custom" && message.customType === "command";
    if (localCommand) return false;
    const key = messageContentKey(message);
    const count = promotedCounts.get(key) ?? 0;
    if (count > 0) {
      promotedCounts.set(key, count - 1);
      return false;
    }
    return true;
  });
}

/**
 * Idempotent live upsert (#99 splice race): a message_end whose entry is
 * already inside the journal window replaces it in place instead of
 * appending a duplicate. Only the window tail is searched — the raced entry
 * is the newest durable one, and identical older messages must survive.
 */
export function upsertCompletedMessage(messages: AgentMessage[], completed: AgentMessage): AgentMessage[] {
  const key = messageContentKey(completed);
  const searchFrom = Math.max(0, messages.length - 5);
  for (let index = messages.length - 1; index >= searchFrom; index -= 1) {
    if (messageContentKey(messages[index]) === key) {
      if (messages[index] === completed) return messages;
      const next = [...messages];
      next[index] = completed;
      return next;
    }
  }
  return [...messages, completed];
}