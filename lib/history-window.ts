// Journal-backed chat window helpers (issue #99).
//
// Pure client-side logic for the windowed history UI: the localStorage cache
// (machine/user/session scoped, anchor-versioned, byte-bounded), the
// journal/live reconciliation keyed by entry id / content (wire messageIds
// are process-scoped, never journal entry ids), and the
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

/**
 * True when `fresh` could be a pure append past `cached` (#124): the journal
 * grew (entryCount and sizeBytes non-decreasing, not identical). The active
 * leafId advances on EVERY append, so it is NOT a branch-identity signal —
 * continuity is validated by the delta walk, which falls back to replace
 * when the cached cursor no longer sits on the fresh active branch.
 */
export function anchorIsAppend(cached: JournalAnchor, fresh: JournalAnchor): boolean {
  if (cached.entryCount === 0 || cached.lastEntryId === null) return false;
  return fresh.entryCount >= cached.entryCount
    && fresh.sizeBytes >= cached.sizeBytes
    && !sameAnchor(cached, fresh);
}

export type WindowRefreshDecision = "reuse" | "delta" | "replace";

/**
 * How a bounded tail response relates to the window already on screen:
 * unchanged anchor → keep every cached page; grown journal → fetch only the
 * delta after the cached last durable entry (the walk validates branch
 * continuity); anything else (cold start, rewrite, shrink) → replace with
 * the fresh tail.
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
 * Continuity gate for a delta walk (#124). readSessionHistory answers an
 * unknown `after` cursor — the cached entry rewritten away or off the fresh
 * active branch after navigate_tree/compaction — with the TAIL window, not
 * the strict-after slice. A genuine continuation strictly follows the cursor
 * (never contains it) and extends past the OLD tail entry; anything else
 * means the walk relocated and the caller must replace, never append a
 * wrong-branch delta.
 */
export function deltaContinuesWindow(
  batchMessages: AgentMessage[],
  batchEntryIds: string[],
  cursorEntryId: string,
  previousTailEntryId: string | null,
): boolean {
  if (batchMessages.length !== batchEntryIds.length) return false;
  if (batchEntryIds.length === 0) return true;
  if (batchEntryIds.includes(cursorEntryId)) return false;
  const tailAt = previousTailEntryId === null ? -1 : batchEntryIds.indexOf(previousTailEntryId);
  return tailAt < batchEntryIds.length - 1;
}

/**
 * Transcript model (#124): `messages` is the durable journal window followed
 * by the live not-yet-durable tail. Durable identity lives in the PARALLEL
 * entryIds state (parallel to the durable PREFIX, never to live messages),
 * so state alone distinguishes durable from live without per-message tags.
 * A refresh installs the durable window wholesale and keeps only live
 * messages whose content is not now durable ANYWHERE in the installed
 * window; live messages always render after all durable ones.
 */
export function applyRefreshedWindow(
  prevMessages: AgentMessage[],
  prevDurableCount: number,
  windowMessages: AgentMessage[],
  windowEntryIds: string[],
): { messages: AgentMessage[]; entryIds: string[] } {
  const durableCount = Math.min(prevDurableCount, prevMessages.length);
  const live = prevMessages.slice(durableCount);
  // Multiplicity-aware promotion: one durable copy retires exactly one live
  // copy, so a second identical live message survives a one-copy delta.
  const durableCounts = new Map<string, number>();
  for (const message of windowMessages) {
    const key = messageContentKey(message);
    durableCounts.set(key, (durableCounts.get(key) ?? 0) + 1);
  }
  const kept: AgentMessage[] = [];
  for (const message of live) {
    // Local-only command output bubbles drop as a full reload always did.
    if (message.role === "custom" && message.customType === "command") continue;
    const key = messageContentKey(message);
    const count = durableCounts.get(key) ?? 0;
    if (count > 0) {
      durableCounts.set(key, count - 1);
      continue;
    }
    kept.push(message);
  }
  return { messages: [...windowMessages, ...kept], entryIds: [...windowEntryIds] };
}

/** Latest-wins guard (#124): true when a refresh response may install. */
export function refreshMayInstall(
  installedAnchor: JournalAnchor | null | undefined,
  responseAnchor: JournalAnchor | null | undefined,
  responseSeq: number,
  installedSeq: number,
): boolean {
  if (!responseAnchor) return false;
  // A newer response already installed: this one is superseded.
  if (responseSeq < installedSeq) return false;
  // An older journal position must never overwrite a newer installed window
  // (concurrent unordered responses; entryCount only grows on append).
  if (installedAnchor && responseAnchor.entryCount < installedAnchor.entryCount) return false;
  return true;
}

/**
 * One logical prompt can emit multiple agent_end events mid-turn (retry,
 * recovery, compaction continuation — the SDK flags them willContinue:true).
 * Only a terminal agent_end settles the streaming stage and triggers the
 * coalesced completion refresh (#124). Exported decision seam for tests.
 */
export function agentEndContinues(event: { willContinue?: unknown }): boolean {
  return event.willContinue === true;
}

/**
 * Idempotent live upsert (#99 splice race, #124): a message_end whose entry
 * is already durable ANYWHERE in the window replaces the newest durable copy
 * in place instead of appending a duplicate. Live (not-yet-durable) messages
 * are never replaced — an identical older live copy is a distinct message.
 */
export function upsertCompletedMessage(
  messages: AgentMessage[],
  durableCount: number,
  completed: AgentMessage,
): AgentMessage[] {
  const key = messageContentKey(completed);
  const searchTo = Math.min(durableCount, messages.length);
  for (let index = searchTo - 1; index >= 0; index -= 1) {
    if (messageContentKey(messages[index]) === key) {
      if (messages[index] === completed) return messages;
      const next = [...messages];
      next[index] = completed;
      return next;
    }
  }
  return [...messages, completed];
}