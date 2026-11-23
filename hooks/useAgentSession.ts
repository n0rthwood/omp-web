"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  CustomMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  SubagentSnapshot,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { stripAnsi } from "@/lib/ansi";
import { apiPath } from "@/lib/api-path";
import { apiErrorMessage, isPromptRejectedError, sendAgentCommand } from "@/lib/agent-client";
import { confirmDraft, createSubmissionTracker, rekeyDraft } from "@/lib/draft-store";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import type { ContextUsage, SessionStatsInfo, SlashCommandInfo } from "@/lib/omp-types";
import type { ModelRoleAssignment } from "@/lib/api-types";
import { planModeTransitionErrorMessage, planSlashCommandIntent, planSlashCommandOutcome, type WebPlanModeInfo } from "@/lib/plan-mode-web";
import { useWebUser } from "@/hooks/useWebUser";
import type { HistoryBoundary, HistoryPage, JournalAnchor } from "@/lib/session-history";
import { useStickToBottom } from "use-stick-to-bottom";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import type { SessionOutline, SessionOutlineEntry } from "@/lib/session-outline";
import {
  EARLIER_PAGE_SIZE,
  INITIAL_HISTORY_WINDOW,
  agentEndContinues,
  applyRefreshedWindow,
  clearHistoryCache,
  decideWindowRefresh,
  deltaContinuesWindow,
  mergeDurableWindow,
  readHistoryCache,
  refreshMayInstall,
  sameAnchor,
  upsertCompletedMessage,
  writeHistoryCache,
  type HistoryWindowSnapshot,
} from "@/lib/history-window";

export interface SessionData {
  sessionId: string;
  filePath: string;
  totalActiveMs: number;
  tree: SessionTreeNode[];
  leafId: string | null;
  contextUsage?: ContextUsage;
  planMode?: WebPlanModeInfo;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  /** Present on the bounded tail path (#99): position of the loaded window. */
  historyPage?: HistoryPage;
  /** Fresh atomic splice point when the tail route captured one for us. */
  historyBoundary?: HistoryBoundary;
}

/** Finite historic around-window shown above the live canonical state (#104). */
interface HistoryOverlaySnapshot {
  messages: AgentMessage[];
  entryIds: string[];
  targetEntryId: string;
  hasEarlier: boolean;
  headEntryId: string | null;
  anchor: JournalAnchor;
  leafId: string | null;
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  /** SDK flags mid-prompt agent_end continuations (#124). */
  willContinue?: boolean;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  /** Live generation throughput from the session host; absent on older hosts. */
  tokensPerSecond?: number | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  subagents?: SubagentSnapshot[];
  planMode?: WebPlanModeInfo | null;
  /** Mid-turn accumulated snapshot of the in-flight assistant message (#99). */
  activePartial?: { message: Partial<AgentMessage>; messageId?: string; hostSeq: number; truncated?: boolean } | null;
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}
// State refreshes contain only live SDK entries; merge terminal frames into a bounded history.
const MAX_SUBAGENT_HISTORY = 128;

function mergeSubagentSnapshots(current: SubagentSnapshot[], incoming: SubagentSnapshot[]): SubagentSnapshot[] {
  const byId = new Map(current.map((subagent) => [subagent.id, subagent]));
  for (const subagent of incoming) byId.set(subagent.id, subagent);
  const snapshots = [...byId.values()];
  const active = snapshots
    .filter((subagent) => subagent.status === "pending" || subagent.status === "running")
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  const finished = snapshots
    .filter((subagent) => subagent.status !== "pending" && subagent.status !== "running")
    .sort((left, right) => right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id));
  return [...active, ...finished].slice(0, MAX_SUBAGENT_HISTORY);
}

type ExtensionUiDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" | "plan_review" }
>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}


export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; prompt?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  /** Relayed from the server's "session_renamed" event (issue #20 auto-title) — the sidebar row and any locally-cached name must refresh without a manual reload. */
  onSessionRenamed?: (title: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const CONTEXT_USAGE_REFRESH_MS = 1000;
const BASH_STATE_RECONCILE_MS = 1_000;
// Must exceed the server-side host cold-start budget (connectToHostWithRetry,
// lib/session-host-transport.ts:437, 15 s) plus margin for SSE route overhead.
// A 5 s timeout fired before an idle-reaped host could respawn, causing the
// first message after idle to fail with EventStreamConnectionError (#122).
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 20_000;
// Pre-boundary SSE frames buffer until the journal window installs. The
// buffer is bounded; on overflow the connection is torn down and re-spliced
// (the journal holds every durable entry — nothing is silently dropped).
const MAX_LIVE_EVENT_BUFFER = 2000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
// Upward scroll keys: an upward press is immediate human intent that cancels
// auto-follow even during the library's transient resize-guard window (when a
// keyboard-induced scroll event could otherwise be ignored). Downward/space keys
// are left to the library's own scroll handling.
const UPWARD_SCROLL_KEYS: Record<string, true> = { ArrowUp: true, PageUp: true, Home: true };

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
  /** Atomic journal/live splice point carried by the connected frame (#99). */
  historyBoundary: HistoryBoundary | null;
};

type EventStreamConnectionAttempt = {
  source: EventSource;
  promise: Promise<EventStreamConnectionResult>;
  pending: boolean;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

// Unique across tabs and page lives. crypto.randomUUID needs a secure context
// and omp-web is also served over plain HTTP on the LAN, hence the fallback.
function createClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A queued steer / follow-up is acknowledged by its HTTP response alone: the
 * server awaits the queue call and no prompt_done / prompt_error follows, so
 * waiting for a turn event would leave its draft pending for good (#88). The
 * first send of a new conversation may have rekeyed the composer to the session
 * id meanwhile, so the submission is looked up under both keys.
 */
function confirmQueuedDraft(sessionId: string, draftKey: string | undefined, message: string): void {
  if (!draftKey || !message.trim()) return;
  confirmDraft(draftKey, message);
  if (sessionId !== draftKey) confirmDraft(sessionId, message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

export type RefreshErrorState = { count: number; message: string };

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: string) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface SessionUploadResult {
  files: Array<{ name: string; path: string; size: number }>;
  errors?: Array<{ name: string; error: string }>;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  roles?: ModelRoleAssignment[];
  hiddenModelCount?: number;
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onSessionRenamed,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  const { user: webUser } = useWebUser();

  const initialHistoryRef = useRef<{ sessionId: string | null; user: string | null; snapshot: HistoryWindowSnapshot | null }>({ sessionId: null, user: null, snapshot: null });
  // #99: a cached journal window renders synchronously on a warm refresh —
  // the initial view is always the most recent INITIAL_HISTORY_WINDOW durable
  // messages even when older pages are cached (those serve later clicks).
  // Scope is machine/user/session; the anchor inside versions it. The lookup
  // re-runs when the web user resolves (anonymous → named) so a named user's
  // cache is never missed and another user's window never leaks across.
  const webUsername = webUser?.username ?? null;
  if (initialHistoryRef.current.sessionId !== (session?.id ?? null) || initialHistoryRef.current.user !== webUsername) {
    initialHistoryRef.current = {
      sessionId: session?.id ?? null,
      user: webUsername,
      snapshot: session
        ? readHistoryCache(typeof localStorage === "undefined" ? null : localStorage, webUsername, session.id)
        : null,
    };
  }
  const cachedWindow = initialHistoryRef.current.snapshot;
  const cachedTail = cachedWindow
    ? {
        messages: cachedWindow.messages.slice(-INITIAL_HISTORY_WINDOW),
        entryIds: cachedWindow.entryIds.slice(-INITIAL_HISTORY_WINDOW),
      }
    : null;
  // The button must appear whenever durable entries precede the shown tail —
  // including a warm mount whose cache holds only the tail itself.
  const cachedHasEarlier = cachedWindow
    ? cachedWindow.hasEarlier || cachedWindow.anchor.entryCount > (cachedTail?.entryIds.length ?? 0)
    : false;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew && !cachedTail);
  const [error, setError] = useState<string | null>(null);
  // Non-blocking background-refresh failure indicator (#100).
  const [refreshError, setRefreshError] = useState<RefreshErrorState | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  // Transcript state (#124): ONE state object — messages = durable journal
  // window followed by the live not-yet-durable tail; entryIds is PARALLEL TO
  // THE DURABLE PREFIX ONLY, so state alone distinguishes durable from live.
  const [transcript, setTranscript] = useState<{ messages: AgentMessage[]; entryIds: string[] }>({
    messages: cachedTail?.messages ?? [],
    entryIds: cachedTail?.entryIds ?? [],
  });
  const { messages, entryIds } = transcript;
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [hiddenModelCount, setHiddenModelCount] = useState<number | undefined>(undefined);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [modelRoles, setModelRoles] = useState<ModelRoleAssignment[]>([]);
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  // TUI parity: the host's meter keeps its last reading between turns, so this
  // is only cleared by a session switch (this hook's lifetime), never on idle.
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);
  const [planMode, setPlanMode] = useState<WebPlanModeInfo | null>(null);
  const [historyHasEarlier, setHistoryHasEarlier] = useState(cachedHasEarlier);
  const [historyLoading, setHistoryLoading] = useState(false);
  // --- #104 outline + historic around-view state ---
  const [outline, setOutline] = useState<SessionOutlineEntry[]>([]);
  const [outlineUserMessages, setOutlineUserMessages] = useState(0);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  // A finite historic around-window rendered ABOVE the live canonical state.
  // While it is present the live messages/SSE/drafts keep advancing underneath
  // untouched; the shown transcript is the overlay, never a live/historic splice.
  const [historyOverlay, setHistoryOverlay] = useState<HistoryOverlaySnapshot | null>(null);
  const [historyTargetEntryId, setHistoryTargetEntryId] = useState<string | null>(null);
  const [historyNavigationLoading, setHistoryNavigationLoading] = useState(false);
  const [historyNavigationError, setHistoryNavigationError] = useState<string | null>(null);
  const historyBrowsing = historyOverlay !== null;
  // Synchronous mirrors for the latest-click-wins / scope race guards (#104).
  const entryIdsRef = useRef<string[]>(entryIds);
  entryIdsRef.current = entryIds;
  const historyOverlayRef = useRef<HistoryOverlaySnapshot | null>(null);
  historyOverlayRef.current = historyOverlay;
  const historyBrowsingRef = useRef(false);
  historyBrowsingRef.current = historyBrowsing;
  const historyNavGenRef = useRef(0);
  const outlineGenRef = useRef(0);
  const outlineInFlightRef = useRef(false);
  const outlineAnchorRef = useRef<JournalAnchor | null>(null);
  const outlineLeafRef = useRef<string | null>(null);
  const historyNavAbortRef = useRef<AbortController | null>(null);
  const outlineDirtyRef = useRef(false);
  // Set by a loader immediately before it installs a fetched earlier page; the
  // prepend layout effect consumes it on THAT commit (not on unrelated live
  // growth during the fetch await). Stable visible-entry anchor + distance fallback.
  const prependAnchorRef = useRef<{ entryId: string | null; offset: number; distance: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const eventSourceSessionIdRef = useRef<string | null>(null);
  const eventConnectionAttemptRef = useRef<EventStreamConnectionAttempt | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  // Journal window bookkeeping (#99). windowRef is the durable slice on
  // screen (cached pages included); everything past it is the live tail.
  const windowRef = useRef<HistoryWindowSnapshot | null>(cachedTail && cachedWindow
    ? {
        ...cachedWindow,
        messages: cachedTail.messages,
        entryIds: cachedTail.entryIds,
        hasEarlier: cachedHasEarlier,
        // The shown tail's head, not the full cache's — "Load earlier" pages
        // from exactly what is on screen.
        headEntryId: cachedTail.entryIds[0] ?? cachedWindow.headEntryId,
      }
    : null);
  // Tracks whether the on-screen window came from the bootstrap cache (and
  // under which user) vs a network install — lets a late-resolving web user
  // swap an anonymous cache hit for their own, never over server content.
  const cacheBootedUserRef = useRef<string | null>(cachedTail ? webUsername : null);
  const historyBoundaryRef = useRef<HistoryBoundary | null>(null);
  const liveEventBufferRef = useRef<AgentEvent[] | null>(null);
  const historyLoadGenRef = useRef(0);
  const webUsernameRef = useRef<string | null>(null);
  webUsernameRef.current = webUsername;
  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  const promptRunIdRef = useRef(0);
  const contextUsageRequestIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  // Composer submissions the server has not confirmed yet (#88). ChatInput keeps
  // each one as a pending draft. Every prompt carries a client-generated
  // promptId that the server echoes in its prompt_done / prompt_error, so only
  // the event with a submission's own id confirms or restores it: another tab's
  // prompt, a queued slash command, a stale event or an event without an id (an
  // older remote) never touches a draft that is not theirs. inFlightPromptRef
  // is this hook's main prompt, with the images the tracker does not keep, for
  // its own prompt_error to give back to the composer.
  const [submissions] = useState(createSubmissionTracker);
  const inFlightPromptRef = useRef<{ promptId: string; message: string; images?: AttachedImage[] } | null>(null);
  const modelSwitchPendingRef = useRef(false);
  // Synchronous mirrors for loadSession's failure routing (#100): a
  // turn-completion refresh can reject before React commits the rendered
  // messages/streaming state, and a stale "nothing rendered" read would wipe
  // the view. Updated during render and on every failure/success below.
  const hasRenderedContentRef = useRef(false);
  const refreshErrorRef = useRef<RefreshErrorState | null>(null);
  hasRenderedContentRef.current = data !== null || messages.length > 0 || streamState.isStreaming || agentRunning || bashRunning;
  // Single-flight latest-wins history refresh controller (#124): at most one
  // background refresh in flight; triggers arriving meanwhile coalesce into
  // exactly one trailing refresh. historyRefreshSeq counts requests;
  // historyInstalledSeq tracks the newest response already installed, so an
  // older late response can never overwrite a newer window.
  const historyRefreshInFlightRef = useRef(false);
  const historyRefreshPendingRef = useRef(false);
  const historyRefreshSeqRef = useRef(0);
  const historyInstalledSeqRef = useRef(0);

  // --- #104 follow controller: use-stick-to-bottom is the sole follow engine ---
  // ResizeObserver tracks ALL transcript growth (stream/media/tools); the
  // library cancels its own animation on any upward human scroll (wheel,
  // touch, scrollbar, and the scroll events they emit). Upward keyboard intent
  // is supplemented below for immediacy.
  // No custom acceleration/two-screen gestures; reduced motion goes instant.
  const reducedMotion = useReducedMotion();
  const followMotion = reducedMotion ? "instant" as const : "smooth" as const;
  const stick = useStickToBottom({ initial: "instant", resize: followMotion });
  // Destructure the library's stable members so callback deps stay stable (the
  // whole `stick` object is recreated each render; its members are memoized).
  const { scrollRef: scrollContainerRef, contentRef: scrollContentRef, state: stickState, stopScroll, scrollToBottom } = stick;
  // Follow mode is the library's lock state (escape-aware), not a raw geometry
  // measurement: an upward human scroll escapes the lock, returning to the
  // bottom re-locks. Explicit pause/resume drive the same lock.
  // Use the INTERNAL lock, not the returned isAtBottom (which ORs in
  // isNearBottom): otherwise pausing while parked near the bottom would read
  // as still-following and the toggle could never resume. Every lock mutation
  // also updates React state, so this re-renders reactively.
  // A detached historic overlay never claims follow, even if the library's
  // shrink-relock fires while browsing (guarded below).
  const autoFollow = !historyBrowsing && stickState.isAtBottom;
  const autoFollowRef = useRef(autoFollow);
  autoFollowRef.current = autoFollow;
  const pauseAutoFollow = useCallback(() => {
    stopScroll();
  }, [stopScroll]);
  const resumeAutoFollow = useCallback(() => {
    void scrollToBottom(followMotion);
  }, [scrollToBottom, followMotion]);
  // Toggling follow ON while browsing history returns to the live tail first.
  const handleReturnToLatestRef = useRef<(() => Promise<void>) | null>(null);
  const toggleAutoFollow = useCallback(() => {
    if (autoFollowRef.current) {
      pauseAutoFollow();
      return;
    }
    if (historyBrowsingRef.current) {
      void handleReturnToLatestRef.current?.();
      return;
    }
    resumeAutoFollow();
  }, [pauseAutoFollow, resumeAutoFollow]);
  // The transcript actually on screen: the historic overlay while browsing,
  // otherwise the live canonical window. Live state keeps advancing underneath.
  const shownMessages = historyOverlay ? historyOverlay.messages : messages;
  const shownEntryIds = historyOverlay ? historyOverlay.entryIds : entryIds;

  // The library re-locks on content/viewport shrink near the bottom. While a
  // historic overlay is shown that lock must not survive: drop it through the
  // library's own stopScroll (no second scroll writer). Lock mutations update
  // React state, so this re-runs on every relock attempt during browsing.
  useLayoutEffect(() => {
    if (historyBrowsing && stickState.isAtBottom) stopScroll();
  }, [historyBrowsing, stickState.isAtBottom, stopScroll]);

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) {
      return { ...sessionStatsOverride, totalActiveMs: data?.totalActiveMs };
    }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0 && outlineUserMessages === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages: Math.max(userMessages, outlineUserMessages),
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      totalActiveMs: data?.totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, outlineUserMessages, contextUsage, data?.filePath, data?.totalActiveMs, session?.id, session?.name]);

  const persistWindowCache = useCallback((sid: string) => {
    const windowState = windowRef.current;
    if (!windowState) return;
    writeHistoryCache(
      typeof localStorage === "undefined" ? null : localStorage,
      webUsernameRef.current,
      sid,
      windowState,
    );
  }, []);

  // Explicit installs (bootstrap, branch navigation, compaction): the fresh
  // durable window REPLACES the transcript — the old branch's live tail must
  // never leak across a scope change. Background refreshes use
  // applyRefreshedWindow instead (live tail reconciled by content key).
  const installDurableWindow = useCallback((sid: string, snapshot: HistoryWindowSnapshot) => {
    windowRef.current = snapshot;
    cacheBootedUserRef.current = null;
    setTranscript({ messages: snapshot.messages, entryIds: snapshot.entryIds });
    setHistoryHasEarlier(snapshot.hasEarlier);
    persistWindowCache(sid);
  }, [persistWindowCache]);

  // Background refresh install (#124): pure content-keyed merge inside ONE
  // functional update over the CURRENT state — durable part = the installed
  // window, live part = previously-live messages not now durable anywhere in
  // it, always after all durable ones. windowRef is recomputed from the same
  // current state so concurrent live appends can never desynchronize it.
  const applyWindowRefresh = useCallback((sid: string, snapshot: HistoryWindowSnapshot) => {
    cacheBootedUserRef.current = null;
    setTranscript((prev) => {
      const next = applyRefreshedWindow(prev.messages, prev.entryIds.length, snapshot.messages, snapshot.entryIds);
      windowRef.current = { ...snapshot, messages: next.messages.slice(0, next.entryIds.length), entryIds: next.entryIds };
      return next;
    });
    setHistoryHasEarlier(snapshot.hasEarlier);
    persistWindowCache(sid);
  }, [persistWindowCache]);

  // The web user may resolve AFTER mount (anonymous first render). When the
  // scope changes, adopt that user's cached window if nothing has loaded yet
  // — never over server-fetched content, never across users mid-view.
  const hydratedUserRef = useRef<string | null>(webUsername);
  useEffect(() => {
    if (hydratedUserRef.current === webUsername) return;
    hydratedUserRef.current = webUsername;
    const sid = sessionIdRef.current;
    if (!sid || data !== null) return;
    // A network window already landed, or the cache belongs to this same user:
    // nothing to swap. Only a cache-derived window from a DIFFERENT (anonymous)
    // scope may be replaced when the real user resolves.
    if (windowRef.current !== null && cacheBootedUserRef.current === webUsername) return;
    const snapshot = readHistoryCache(typeof localStorage === "undefined" ? null : localStorage, webUsername, sid);
    if (!snapshot) return;
    const tailMessages = snapshot.messages.slice(-INITIAL_HISTORY_WINDOW);
    const tailIds = snapshot.entryIds.slice(-INITIAL_HISTORY_WINDOW);
    const hasEarlier = snapshot.hasEarlier || snapshot.anchor.entryCount > tailIds.length;
    windowRef.current = { ...snapshot, messages: tailMessages, entryIds: tailIds, hasEarlier, headEntryId: tailIds[0] ?? snapshot.headEntryId };
    cacheBootedUserRef.current = webUsername;
    setTranscript({ messages: tailMessages, entryIds: tailIds });
    setHistoryHasEarlier(hasEarlier);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webUsername]);

  // --- #104 historic view invalidation + outline loads ---
  // Scope invalidation (session/leaf/compaction): drop the overlay AND make
  // every in-flight navigation response stale. Never touches live state.
  const clearHistoricView = useCallback(() => {
    historyNavGenRef.current += 1;
    historyNavAbortRef.current?.abort();
    historyNavAbortRef.current = null;
    setHistoryOverlay(null);
    setHistoryTargetEntryId(null);
    setHistoryNavigationLoading(false);
    setHistoryNavigationError(null);
    // Scope invalidation also frees the page-loading latch: a superseded loader's
    // gen-guarded finally would otherwise never clear it, disabling LoadEarlier.
    setHistoryLoading(false);
  }, []);

  // Human intent during a pending around-fetch: invalidate the request and
  // clear loading WITHOUT mutating the shown view, resolved target or error.
  // Late success/rejection/finalizers of the aborted request are ignored.
  const cancelHistoryNavigation = useCallback(() => {
    historyNavGenRef.current += 1;
    historyNavAbortRef.current?.abort();
    historyNavAbortRef.current = null;
    setHistoryNavigationLoading(false);
    setHistoryLoading(false);
  }, []);

  // Metadata-only outline (#104): one bounded request per durable change, never
  // per streamed token. In-flight calls coalesce into a single trailing reload.
  const loadOutline = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (outlineInFlightRef.current) {
      outlineDirtyRef.current = true;
      return;
    }
    outlineInFlightRef.current = true;
    const generation = outlineGenRef.current;
    setOutlineLoading(true);
    setOutlineError(null);
    try {
      // No anchor or leaf pin: the server derives a fresh durable position and
      // replays the CURRENT leaf (same default as the live tail). Pinning to
      // windowRef.anchor would lag mid-turn; pinning leafId to a branch-selection
      // entry would replay only to that stale leaf once the conversation continues.
      // The RESPONSE anchor/leaf are stored for around navigation.
      const params = new URLSearchParams({ outline: "1" });
      const res = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { outline?: SessionOutline };
      if (sessionIdRef.current !== sid || outlineGenRef.current !== generation) return;
      if (!d.outline) throw new Error("Malformed outline response");
      outlineAnchorRef.current = d.outline.anchor;
      outlineLeafRef.current = d.outline.leafId;
      setOutline(d.outline.entries);
      setOutlineUserMessages(d.outline.entries.filter((e) => e.role === "user" || e.role === "summary").length);
    } catch (e) {
      // Non-destructive: keep the last good outline, expose a retryable error.
      if (sessionIdRef.current === sid && outlineGenRef.current === generation) {
        setOutlineError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      outlineInFlightRef.current = false;
      if (sessionIdRef.current === sid && outlineGenRef.current === generation) {
        setOutlineLoading(false);
        if (outlineDirtyRef.current) {
          outlineDirtyRef.current = false;
          void loadOutline();
        }
      } else {
        outlineDirtyRef.current = false;
      }
    }
  }, []);

  // Bounded journal refresh (#99/#124): always `tail=5`, never a full-history
  // GET. `boundaryAnchor` is the FRESH atomic splice anchor from the connected
  // SSE frame — passed to bound the initial read. Background refreshes pass
  // none: the server captures a fresh boundary (live) or derives the file
  // anchor (dead); reuse/delta/replace is decided against the window on screen
  // and the merge is idempotent and order-independent (entry-id keyed).
  // Returns the agent state when includeState, else true on install/reuse and
  // false on failure/stale discard (callers gate settlement on truthiness).
  const loadSession = useCallback(async (
    sid: string,
    showLoading = false,
    includeState = false,
    boundaryAnchor: JournalAnchor | null = null,
    allowRetry = true,
  ): Promise<{ running: boolean; state?: AgentStateResponse } | boolean | null> => {
    const generation = historyLoadGenRef.current;
    const requestSeq = ++historyRefreshSeqRef.current;
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tail: String(INITIAL_HISTORY_WINDOW) });
      if (boundaryAnchor) params.set("anchor", JSON.stringify(boundaryAnchor));
      const res = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}?${params}`));
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setTranscript({ messages: [], entryIds: [] });
          setHistoryHasEarlier(false);
          windowRef.current = null;
          clearHistoryCache(typeof localStorage === "undefined" ? null : localStorage, webUsernameRef.current, sid);
          setError(null);
          refreshErrorRef.current = null;
          setRefreshError(null);
          clearHistoricView();
          setOutline([]);
          outlineAnchorRef.current = null;
          return false;
        }
        // A background refresh hitting a vanished session is still a failed
        // load (#100): route it through the same non-blocking indicator.
        throw new Error("HTTP 404");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid || historyLoadGenRef.current !== generation) return false;
      // Latest-wins (#124): discard a response superseded by a newer install,
      // or one whose anchor is older than the installed window. No state is
      // touched — a failed/stale refresh keeps the rendered chat intact (#100).
      const page = d.historyPage;
      if (page && !refreshMayInstall(windowRef.current?.anchor ?? null, page.anchor, requestSeq, historyInstalledSeqRef.current)) {
        return false;
      }
      setData(d);
      setContextUsage(d.contextUsage ?? null);
      setPlanMode(d.planMode ?? null);
      setActiveLeafId(d.leafId ?? null);
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setError(null);
      refreshErrorRef.current = null;
      setRefreshError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      // (page was read above, before the latest-wins guard.)
      const base = windowRef.current;
      const decision = decideWindowRefresh(base?.anchor ?? null, base?.entryIds.length ?? 0, page);
      if (decision === "reuse" && base) {
        setHistoryHasEarlier(base.hasEarlier);
      } else if (decision === "delta" && base && page) {
        // Warm refresh: fetch EVERY entry appended past the cached window in
        // bounded pages (limit 100), walking the after-cursor — never advance
        // the anchor past unfetched messages.
        const deltaMessages: AgentMessage[] = [];
        const deltaEntryIds: string[] = [];
        let afterCursor = base.anchor.lastEntryId;
        const deltaAnchor = page.anchor;
        for (;;) {
          const deltaParams = new URLSearchParams({ deferThinking: "1", deferMedia: "1", limit: "100" });
          if (afterCursor) deltaParams.set("after", afterCursor);
          deltaParams.set("anchor", JSON.stringify(deltaAnchor));
          const deltaRes = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}/context?${deltaParams}`));
          if (!deltaRes.ok) throw new Error(`HTTP ${deltaRes.status}`);
          const delta = await deltaRes.json() as {
            context: { messages: AgentMessage[]; entryIds: string[] };
            historyPage: HistoryPage;
          };
          if (sessionIdRef.current !== sid || historyLoadGenRef.current !== generation) return false;
          if (!delta.historyPage || !sameAnchor(delta.historyPage.anchor, deltaAnchor)) {
            // The journal moved under the walk (rewrite/branch): start over
            // with a fresh bounded tail — at most once, so a persistently
            // rewriting journal cannot livelock into unbounded re-entry.
            if (!allowRetry) throw new Error("Session journal changed during history refresh");
            windowRef.current = null;
            return loadSession(sid, showLoading, includeState, null, false);
          }
          // Continuity (#124): an `after` cursor no longer on the fresh active
          // branch (navigate_tree / rewrite / compaction) makes the server
          // answer with the TAIL window — never append a wrong-branch delta.
          if (!deltaContinuesWindow(
            delta.context.messages,
            delta.context.entryIds ?? [],
            afterCursor ?? "",
            base.entryIds[base.entryIds.length - 1] ?? null,
          )) {
            if (!allowRetry) throw new Error("Session branch changed during history refresh");
            windowRef.current = null;
            return loadSession(sid, showLoading, includeState, null, false);
          }
          const batchMessages = delta.context.messages;
          const batchIds = delta.context.entryIds ?? [];
          if (batchMessages.length !== batchIds.length) {
            // Malformed delta (ids not parallel): replace rather than advance
            // the anchor past unfetched/misaligned messages.
            if (!allowRetry) throw new Error("Malformed history delta during refresh");
            windowRef.current = null;
            return loadSession(sid, showLoading, includeState, null, false);
          }
          deltaMessages.push(...delta.context.messages);
          deltaEntryIds.push(...(delta.context.entryIds ?? []));
          if (delta.context.messages.length < 100 || (delta.context.entryIds ?? []).length === 0) break;
          afterCursor = deltaEntryIds[deltaEntryIds.length - 1];
        }
        const merged = mergeDurableWindow(base.messages, base.entryIds, deltaMessages, deltaEntryIds);
        if (!merged) {
          if (!allowRetry) throw new Error("Malformed history delta during refresh");
          windowRef.current = null;
          return loadSession(sid, showLoading, includeState, null, false);
        }
        // Entry-id keyed merge: durable window = base + unseen delta entries;
        // the live tail is reconciled by content key inside the functional
        // update — never a length slice of a render-synced ref.
        historyInstalledSeqRef.current = requestSeq;
        applyWindowRefresh(sid, {
          messages: merged.messages,
          entryIds: merged.entryIds,
          anchor: deltaAnchor,
          hasEarlier: base.hasEarlier,
          headEntryId: base.headEntryId,
          leafId: deltaAnchor.leafId,
        });
      } else if (page) {
        // Replace (cold/rewrite/branch): install the fresh tail; the pure
        // merge keeps streamed-but-not-yet-durable live messages whose key is
        // not now durable anywhere in the window.
        historyInstalledSeqRef.current = requestSeq;
        applyWindowRefresh(sid, {
          messages: d.context.messages,
          entryIds: d.context.entryIds ?? [],
          anchor: page.anchor,
          hasEarlier: page.hasEarlier,
          headEntryId: page.headEntryId,
          leafId: page.anchor.leafId,
        });
      } else {
        // No historyPage: the remote predates journal pagination. Rendering
        // its full context would violate the bounded window — keep the
        // current view and surface an explicit error instead.
        throw new Error("Session history pagination is not supported by this machine's omp-web version");
      }

      messagesLoaded = true;
      // Durable window changed: refresh the outline (deduped, never per token).
      void loadOutline();
      if (showLoading) setLoading(false);
      if (!includeState) return true;

      try {
        const stateRes = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}/state`));
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) return true;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.tokensPerSecond !== undefined) setTokensPerSecond(liveState.tokensPerSecond ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.planMode !== undefined) setPlanMode(liveState.planMode ?? null);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
          if (liveState.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, liveState.subagents ?? []));
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return true;
      }
    } catch (e) {
      // A late rejection for a session we already navigated away from must
      // not touch the new view (same guard as the success path).
      if (sessionIdRef.current !== sid) return false;
      const message = String(e);
      // #100: a failed refresh is fatal only while nothing is rendered. Once
      // messages/streaming are on screen it becomes a non-blocking count that
      // the next successful fetch/reconcile clears; the rendered view,
      // composer draft and scroll position are never touched by the failure.
      if (!hasRenderedContentRef.current) {
        setError(message);
      } else {
        const next = { count: (refreshErrorRef.current?.count ?? 0) + 1, message };
        refreshErrorRef.current = next;
        setRefreshError(next);
      }
      return false;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [applyWindowRefresh, loadOutline, clearHistoricView]);

  // Single-flight background refresh (#124): completion triggers (agent_end
  // final / agent_settled / prompt_done / poll fallback) collapse into one
  // refresh; triggers arriving while one is in flight coalesce into exactly
  // one trailing refresh. Explicit loads (bootstrap, branch navigation, Load
  // earlier, compaction) keep calling loadSession directly and invalidate
  // through historyLoadGenRef.
  const requestHistoryRefresh = useCallback(async (sid: string) => {
    if (historyRefreshInFlightRef.current) {
      historyRefreshPendingRef.current = true;
      return;
    }
    historyRefreshInFlightRef.current = true;
    try {
      do {
        historyRefreshPendingRef.current = false;
        if (sessionIdRef.current !== sid) break;
        await loadSession(sid);
      } while (historyRefreshPendingRef.current && sessionIdRef.current === sid);
    } finally {
      historyRefreshInFlightRef.current = false;
      historyRefreshPendingRef.current = false;
    }
  }, [loadSession]);

  // Branch navigation: bounded tail of the selected leaf (never full history).
  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    const generation = historyLoadGenRef.current;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tail: String(INITIAL_HISTORY_WINDOW) });
      if (leafId) params.set("leafId", leafId);
      const url = apiPath(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: { messages: AgentMessage[]; entryIds: string[] };
        contextUsage?: ContextUsage;
        historyPage?: HistoryPage;
      };
      if (sessionIdRef.current !== sid || historyLoadGenRef.current !== generation) return;
      refreshErrorRef.current = null;
      setRefreshError(null);
      setContextUsage(d.contextUsage ?? null);
      if (d.historyPage) {
        installDurableWindow(sid, {
          messages: d.context.messages,
          entryIds: d.context.entryIds ?? [],
          anchor: d.historyPage.anchor,
          hasEarlier: d.historyPage.hasEarlier,
          headEntryId: d.historyPage.headEntryId,
          leafId: leafId ?? d.historyPage.anchor.leafId,
        });
      } else {
        setTranscript({ messages: d.context.messages, entryIds: d.context.entryIds ?? [] });
      }
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, [installDurableWindow]);

  // Capture the visible position just before a fetched earlier page is installed.
  // Prefers a stable visible data-entry-id + offset (immune to below-viewport live
  // growth during the fetch await); falls back to distance-from-bottom.
  const capturePrependAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      prependAnchorRef.current = null;
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    let entryId: string | null = null;
    let offset = 0;
    for (const el of container.querySelectorAll<HTMLElement>("[data-entry-id]")) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > containerTop && rect.top < containerTop + container.clientHeight) {
        entryId = el.getAttribute("data-entry-id");
        offset = rect.top - containerTop;
        break;
      }
    }
    prependAnchorRef.current = {
      entryId,
      offset,
      distance: container.scrollHeight - container.scrollTop,
    };
  }, [scrollContainerRef]);

  // Explicit "Load earlier" click: one page of EARLIER_PAGE_SIZE messages
  // prepended before the window head. No scroll-triggered loading (#99).
  const loadEarlierHistory = useCallback(async () => {
    const sid = sessionIdRef.current;
    const base = windowRef.current;
    if (!sid || !base || !base.hasEarlier || !base.headEntryId || historyLoading) return;
    const generation = historyLoadGenRef.current;
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        deferThinking: "1",
        deferMedia: "1",
        before: base.headEntryId,
        limit: String(EARLIER_PAGE_SIZE),
        anchor: JSON.stringify(base.anchor),
      });
      const res = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: { messages: AgentMessage[]; entryIds: string[] };
        historyPage: HistoryPage;
      };
      if (sessionIdRef.current !== sid || historyLoadGenRef.current !== generation) return;
      const current = windowRef.current;
      if (!current) return;
      // The journal may have been rewritten/branched since the click: the
      // page anchor no longer matches the window — drop it and reload the tail.
      if (!sameAnchor(d.historyPage.anchor, current.anchor)) {
        void loadSession(sid);
        return;
      }
      const pageMessages = d.context.messages;
      const pageEntryIds = d.context.entryIds ?? [];
      if (pageMessages.length === 0) {
        windowRef.current = { ...current, hasEarlier: false };
        setHistoryHasEarlier(false);
        return;
      }
      capturePrependAnchor();
      // Prepend the earlier page INSIDE the durable prefix of the current
      // state; the live tail keeps its position after all durable entries.
      setTranscript((prev) => {
        const next = {
          messages: [...pageMessages, ...prev.messages],
          entryIds: [...pageEntryIds, ...prev.entryIds],
        };
        const durableCount = Math.min(next.entryIds.length, next.messages.length);
        windowRef.current = {
          messages: next.messages.slice(0, durableCount),
          entryIds: next.entryIds,
          anchor: current.anchor,
          hasEarlier: d.historyPage.hasEarlier,
          headEntryId: d.historyPage.headEntryId ?? pageEntryIds[0] ?? current.headEntryId,
          leafId: current.leafId,
        };
        return next;
      });
      setHistoryHasEarlier(d.historyPage.hasEarlier);
      persistWindowCache(sid);
      refreshErrorRef.current = null;
      setRefreshError(null);
    } catch (e) {
      console.error("Failed to load earlier history:", e);
      if (sessionIdRef.current === sid) {
        const next = { count: (refreshErrorRef.current?.count ?? 0) + 1, message: String(e) };
        refreshErrorRef.current = next;
        setRefreshError(next);
      }
    } finally {
      if (sessionIdRef.current === sid && historyLoadGenRef.current === generation) {
        setHistoryLoading(false);
      }
    }
  }, [historyLoading, loadSession, persistWindowCache, capturePrependAnchor]);

  // --- #104 outline jump: latest-click-wins bounded around-window ---
  // Clicking any outline target pauses follow. A target already in the shown
  // window only sets the highlight; an unloaded target fetches ONE around page
  // using the outline's anchor/leaf. The overlay is a finite historic view over
  // the ongoing live state — never a live/historic concatenation, never a write
  // to the live window/cache. Generation guards cover success, rejection and
  // finalizers; session/leaf/cancel invalidate stale responses.
  const handleJumpToEntry = useCallback(async (entryId: string): Promise<boolean> => {
    const sid = sessionIdRef.current;
    if (!sid) return false;
    pauseAutoFollow();
    const shownIds = historyBrowsingRef.current
      ? (historyOverlayRef.current?.entryIds ?? [])
      : entryIdsRef.current;
    if (shownIds.includes(entryId)) {
      // Latest click wins: a loaded target supersedes any pending around-fetch.
      historyNavGenRef.current += 1;
      historyNavAbortRef.current?.abort();
      historyNavAbortRef.current = null;
      setHistoryNavigationLoading(false);
      setHistoryTargetEntryId(entryId);
      setHistoryNavigationError(null);
      return true;
    }
    const anchor = outlineAnchorRef.current ?? windowRef.current?.anchor ?? null;
    const leafId = outlineLeafRef.current;
    const generation = ++historyNavGenRef.current;
    historyNavAbortRef.current?.abort();
    const controller = new AbortController();
    historyNavAbortRef.current = controller;
    setHistoryNavigationLoading(true);
    setHistoryNavigationError(null);
    try {
      const params = new URLSearchParams({
        around: entryId,
        limit: String(EARLIER_PAGE_SIZE),
        deferThinking: "1",
        deferMedia: "1",
      });
      if (anchor) params.set("anchor", JSON.stringify(anchor));
      if (leafId !== null) params.set("leafId", leafId);
      const res = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`), { signal: controller.signal });
      if (res.status === 404 || res.status === 409) {
        // Structured target-unavailable: keep the current view, retryable error.
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: { messages: AgentMessage[]; entryIds: string[] };
        historyPage: HistoryPage;
      };
      if (sessionIdRef.current !== sid || historyNavGenRef.current !== generation) return false;
      const pageIds = d.context.entryIds ?? [];
      if (!d.historyPage || pageIds.length !== d.context.messages.length || !pageIds.includes(entryId)) {
        throw new Error("History target unavailable");
      }
      const overlay: HistoryOverlaySnapshot = {
        messages: d.context.messages,
        entryIds: pageIds,
        targetEntryId: entryId,
        hasEarlier: d.historyPage.hasEarlier,
        headEntryId: d.historyPage.headEntryId ?? pageIds[0] ?? null,
        anchor: d.historyPage.anchor,
        leafId: d.historyPage.anchor.leafId,
      };
      historyOverlayRef.current = overlay;
      setHistoryOverlay(overlay);
      setHistoryTargetEntryId(entryId);
      setHistoryNavigationError(null);
      return true;
    } catch (e) {
      if (sessionIdRef.current !== sid || historyNavGenRef.current !== generation) return false;
      if (e instanceof DOMException && e.name === "AbortError") return false;
      setHistoryNavigationError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (sessionIdRef.current === sid && historyNavGenRef.current === generation) {
        setHistoryNavigationLoading(false);
        historyNavAbortRef.current = null;
      }
    }
  }, [pauseAutoFollow]);

  // Return to the live tail: drop the overlay (live canonical messages kept
  // advancing underneath), refresh the bounded tail only if it is missing,
  // and resume follow.
  const handleReturnToLatest = useCallback(async () => {
    const sid = sessionIdRef.current;
    historyNavGenRef.current += 1;
    historyNavAbortRef.current?.abort();
    historyNavAbortRef.current = null;
    historyOverlayRef.current = null;
    setHistoryOverlay(null);
    setHistoryTargetEntryId(null);
    setHistoryNavigationLoading(false);
    setHistoryNavigationError(null);
    if (sid && windowRef.current === null) {
      await loadSession(sid);
    }
    resumeAutoFollow();
  }, [loadSession, resumeAutoFollow]);
  handleReturnToLatestRef.current = handleReturnToLatest;

  // "Load earlier" inside the historic overlay: prepend one page using the
  // overlay's OWN anchor/head. Never touches the live window or its cache, and
  // never concatenates a disjoint window (anchor must still match).
  const loadEarlierOverlay = useCallback(async () => {
    const sid = sessionIdRef.current;
    const base = historyOverlayRef.current;
    if (!sid || !base || !base.hasEarlier || !base.headEntryId || historyLoading) return;
    const generation = historyLoadGenRef.current;
    const navGeneration = historyNavGenRef.current;
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        deferThinking: "1",
        deferMedia: "1",
        before: base.headEntryId,
        limit: String(EARLIER_PAGE_SIZE),
        anchor: JSON.stringify(base.anchor),
      });
      // Mirror the around path: an explicit branch must page ITS OWN leaf, never
      // the server-replayed default (which could prepend a different branch).
      if (base.leafId !== null) params.set("leafId", base.leafId);
      const res = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: { messages: AgentMessage[]; entryIds: string[] };
        historyPage: HistoryPage;
      };
      if (sessionIdRef.current !== sid || historyLoadGenRef.current !== generation || historyNavGenRef.current !== navGeneration) return;
      const current = historyOverlayRef.current;
      if (!current) return;
      if (!sameAnchor(d.historyPage.anchor, current.anchor)) {
        // Journal rewritten under the overlay: keep the view, retryable error.
        setHistoryNavigationError("Session journal changed; return to latest and retry");
        return;
      }
      const pageMessages = d.context.messages;
      const pageIds = d.context.entryIds ?? [];
      if (pageMessages.length === 0) {
        const next = { ...current, hasEarlier: false };
        historyOverlayRef.current = next;
        setHistoryOverlay(next);
        return;
      }
      const next: HistoryOverlaySnapshot = {
        ...current,
        messages: [...pageMessages, ...current.messages],
        entryIds: [...pageIds, ...current.entryIds],
        hasEarlier: d.historyPage.hasEarlier,
        headEntryId: d.historyPage.headEntryId ?? pageIds[0] ?? current.headEntryId,
      };
      capturePrependAnchor();
      historyOverlayRef.current = next;
      setHistoryOverlay(next);
    } catch (e) {
      if (sessionIdRef.current === sid && historyLoadGenRef.current === generation && historyNavGenRef.current === navGeneration) {
        setHistoryNavigationError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (sessionIdRef.current === sid && historyLoadGenRef.current === generation && historyNavGenRef.current === navGeneration) {
        setHistoryLoading(false);
      }
    }
  }, [historyLoading, capturePrependAnchor]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    // The composer is keyed by the session id from here on. Move its draft in the
    // store first: ChatWindow can replace the composer instead of re-keying it
    // (the first optimistic message and the settle's reload flip the layout), and
    // a replacement mounts straight under the session id, so nothing else would
    // carry a prompt restored under `new:<cwd>` by a prompt_error that beat the
    // prompt POST. A composer that survives rekeys again from its own effect; the
    // store makes that second move a no-op.
    rekeyDraft(`new:${newSessionCwd}`, sid);
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      userMessages: 0,
      assistantMessages: 0,
      toolResultMessages: 0,
      firstMessage,
      transient: true,
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch(apiPath("/api/agent/new"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      const result = await res.json().catch(() => null) as {
        sessionId?: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
        error?: string;
      } | null;
      // Read the body even on failure: the server's own `error` reason (e.g.
      // "database disk image is malformed") is what must reach the notice —
      // a bare "HTTP 500" hid the actual cause (#83). A success payload
      // without sessionId is equally unusable, so it funnels here too.
      if (!res.ok || !result?.sessionId) {
        throw new Error(apiErrorMessage(res.status, result));
      }
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset]);

  const uploadSessionFiles = useCallback(async (files: File[]): Promise<SessionUploadResult> => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) throw new Error("Unable to create a session for file upload");
    const formData = new FormData();
    for (const file of files) formData.append("files", file);
    const res = await fetch(apiPath(`/api/agent/${encodeURIComponent(sid)}/uploads`), {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => null) as (SessionUploadResult & { error?: string }) | null;
    if (res.status >= 400) throw new Error(data?.error ?? `HTTP ${res.status}`);
    if (!data) throw new Error(`HTTP ${res.status}`);
    return data;
  }, [ensureNewSession]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    eventSourceSessionIdRef.current = null;
    eventConnectionAttemptRef.current = null;
    liveEventBufferRef.current = null;
  }, []);

  // Subscribe BEFORE the anchored history load (#99): the connected frame
  // carries the atomic journal/live boundary; frames are buffered until the
  // initial window is installed, then only post-boundary frames apply.
  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    closeEvents();
    const es = new EventSource(apiPath(`/api/agent/${encodeURIComponent(sid)}/events`));
    eventSourceRef.current = es;
    eventSourceSessionIdRef.current = sid;
    liveEventBufferRef.current = [];

    const { promise, resolve } = Promise.withResolvers<EventStreamConnectionResult>();
    let settled = false;
    let boundary: HistoryBoundary | null = null;
    // True once a caller awaits this promise (mount bootstrap). An overflow
    // before any await must not self-reconnect — the awaiting caller handles
    // the closed result; self-reconnecting would race a second anchored load.
    let awaited = false;
    promise.then(() => { awaited = true; });
    const settle = (status: EventStreamConnectionStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (eventConnectionAttemptRef.current?.source === es) {
        eventConnectionAttemptRef.current.pending = false;
      }
      resolve({ status, source: es, historyBoundary: boundary });
    };
    const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") {
            const candidate = event.historyBoundary;
            boundary = candidate && typeof candidate === "object" ? candidate as HistoryBoundary : null;
            if (boundary) historyBoundaryRef.current = boundary;
            settle("connected");
            return;
          }
          if (liveEventBufferRef.current) {
            if (liveEventBufferRef.current.length >= MAX_LIVE_EVENT_BUFFER) {
              // Overflow: never drop must-deliver frames silently. Close and
              // let the reconnect path re-anchor from the journal.
              liveEventBufferRef.current = null;
              settle("closed");
              es.close();
              if (eventSourceRef.current === es) {
                eventSourceRef.current = null;
                eventSourceSessionIdRef.current = null;
                eventConnectionAttemptRef.current = null;
              }
              if (!awaited) {
                const overflowGeneration = eventStreamGraceGenerationRef.current;
                setTimeout(() => {
                  if (
                    overflowGeneration === eventStreamGraceGenerationRef.current
                    && !eventSourceRef.current
                    && sessionIdRef.current === sid
                  ) {
                    void connectEvents(sid).then((result) => {
                      if (result.status !== "connected" || sessionIdRef.current !== sid) return;
                      void loadSession(sid, false, false, result.historyBoundary?.journal ?? null).finally(() => {
                        if (eventSourceRef.current !== result.source || sessionIdRef.current !== sid) return;
                        const buffered = liveEventBufferRef.current ?? [];
                        liveEventBufferRef.current = null;
                        for (const bufferedEvent of buffered) handleAgentEventRef.current?.(bufferedEvent);
                      });
                    });
                  }
                }, 1000);
              }
              return;
            }
            liveEventBufferRef.current.push(event);
            return;
          }
          // Journal-mode stream: drop anything at/below the splice point
          // (idempotent — the journal window already holds those entries).
          const hostSeq = typeof event.hostSeq === "number" ? event.hostSeq : null;
          if (hostSeq !== null && historyBoundaryRef.current && hostSeq <= historyBoundaryRef.current.seq) return;
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions or an active idle grace window.
          settle("closed");
          if (eventSourceRef.current === es && (agentRunningRef.current || eventStreamGraceActiveRef.current)) {
            eventSourceRef.current = null;
            eventSourceSessionIdRef.current = null;
            eventConnectionAttemptRef.current = null;
            const reconnectGeneration = eventStreamGraceGenerationRef.current;
            setTimeout(() => {
              if (
                reconnectGeneration === eventStreamGraceGenerationRef.current
                && !eventSourceRef.current
                && (agentRunningRef.current || eventStreamGraceActiveRef.current)
              ) {
                void connectEvents(sid).then((result) => {
                  // A reconnect mid-view re-splices: refresh the journal
                  // window up to the new boundary, then release the buffer.
                  if (result.status !== "connected" || sessionIdRef.current !== sid) { liveEventBufferRef.current = null; return; }
                  void loadSession(sid, false, false, result.historyBoundary?.journal ?? null).finally(() => {
                    if (eventSourceRef.current !== result.source || sessionIdRef.current !== sid) return;
                    const buffered = liveEventBufferRef.current ?? [];
                    liveEventBufferRef.current = null;
                    for (const event of buffered) handleAgentEventRef.current?.(event);
                  });
                });
              }
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    eventConnectionAttemptRef.current = { source: es, promise, pending: true };
    return promise;
  }, [closeEvents, loadSession]);

  // Apply the frames buffered between subscribe and window install (#99),
  // then let the stream flow directly. Pre-boundary frames are dropped —
  // their entries are already inside the journal window.
  const releaseLiveBuffer = useCallback(() => {
    const buffered = liveEventBufferRef.current;
    if (!buffered) return;
    liveEventBufferRef.current = null;
    const boundarySeq = historyBoundaryRef.current?.seq ?? null;
    for (const event of buffered) {
      const hostSeq = typeof event.hostSeq === "number" ? event.hostSeq : null;
      if (hostSeq !== null && boundarySeq !== null && hostSeq <= boundarySeq) continue;
      handleAgentEventRef.current?.(event);
    }
  }, []);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const current = eventSourceRef.current;
    if (current && eventSourceSessionIdRef.current === sid) {
      if (current.readyState === EventSource.OPEN) return;
      const attempt = eventConnectionAttemptRef.current;
      if (attempt?.source === current && attempt.pending) {
        await attempt.promise;
        if (eventSourceRef.current === current && current.readyState === EventSource.OPEN) return;
      }
    }

    const result = await connectEvents(sid);
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) {
      // The view already exists on this path (a prompt is being sent): no
      // anchored reload is pending, so buffered frames apply right away.
      releaseLiveBuffer();
      return;
    }
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    if (eventSourceSessionIdRef.current === sid) eventSourceSessionIdRef.current = null;
    if (eventConnectionAttemptRef.current?.source === result.source) eventConnectionAttemptRef.current = null;
    liveEventBufferRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents, releaseLiveBuffer]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createClientId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);
  const appendCommandOutput = useCallback((text: string) => {
    const content = stripAnsi(text).trim();
    const message: CustomMessage = {
      role: "custom",
      customType: "command",
      content,
      display: true,
      timestamp: Date.now(),
    };
    setTranscript((prev) => ({ messages: [...prev.messages, message], entryIds: prev.entryIds }));
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
      case "ask":
      case "plan_review":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const notifyPromptStage = useCallback((runId: number) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    onAgentEnd?.();
    return true;
  }, [onAgentEnd]);

  // prompt_done: the turn of the event's `promptId` completed, so exactly that
  // submission is confirmed, under whichever draft key it lives under by now. A
  // prompt_error or an abort took the submission out of the tracker beforehand,
  // so the prompt_done that follows a failed turn confirms nothing, and neither
  // does an event for another id, a stale one, or one without an id (an older
  // remote).
  const confirmPrompt = useCallback((event: AgentEvent) => {
    const promptId = typeof event.promptId === "string" ? event.promptId : undefined;
    if (promptId && inFlightPromptRef.current?.promptId === promptId) inFlightPromptRef.current = null;
    submissions.confirm(sessionIdRef.current, promptId);
  }, [submissions]);

  // prompt_error: the server accepted the request but rejected the prompt of the
  // event's `promptId`, so it never reached the agent. Only that prompt goes back
  // to the composer: this hook's main prompt (text and images) or a queued one
  // (`streamingBehavior` set; its tracked text). An id that is not ours (another
  // tab, an extension) or none at all (an older remote) restores nothing and
  // leaves every draft alone. The target is the draft the user sees, not the key
  // the text was taken from: a first send is typed under `new:<cwd>`, and the
  // composer is keyed by the session id once that conversation is promoted. From
  // the promotion on the draft and its carried submission live under the session
  // id (promoteNewSession moved them) even while the composer's own re-key is
  // still pending, so that key is named then; before it, the composer's own key
  // (`new:<cwd>`) is the right one and none is passed.
  const restoreRejectedPrompt = useCallback((event: AgentEvent) => {
    const promptId = typeof event.promptId === "string" ? event.promptId : undefined;
    let prompt: { message: string; images?: AttachedImage[] } | null = null;
    if (typeof event.streamingBehavior === "string") {
      const submission = submissions.takeById(promptId);
      if (submission) prompt = { message: submission.text };
    } else if (promptId && inFlightPromptRef.current?.promptId === promptId) {
      prompt = inFlightPromptRef.current;
      inFlightPromptRef.current = null;
      submissions.takeById(promptId);
    }
    if (!prompt) return;
    opts.chatInputRef?.current?.restoreSubmission?.(
      prompt.message,
      prompt.images?.map(({ data, mimeType }) => ({ data, mimeType })),
      newSessionPromotedRef.current ? (sessionIdRef.current ?? undefined) : undefined,
    );
  }, [opts.chatInputRef, submissions]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const res = await fetch(apiPath(`/api/agent/${encodeURIComponent(sid)}`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        refreshErrorRef.current = null;
        setRefreshError(null);

        const state = data.state;
        setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
        const promptActive = Boolean(data.running && state && (state.isStreaming || state.isPromptRunning));
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }
        if (data.running && (state?.subagents?.length ?? 0) > 0) {
          eventStreamGraceTimerRef.current = setTimeout(
            () => void checkServerIdle(),
            CONTEXT_USAGE_REFRESH_MS,
          );
          return;
        }


        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (promptRunIdRef.current !== runId) return;
    let refreshed = false;
    try {
      if (sid) refreshed = Boolean(await loadSession(sid));
    } finally {
      if (promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      // The streaming bubble is cleared only once the refresh has merged the
      // final message_end into the journal window (#124); on a failed refresh
      // keep it — the next successful refresh/reconcile settles the stage.
      const wasRunning = refreshed ? settleUiStage() : agentRunningRef.current;
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        onAgentEnd?.();
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(apiPath(`/api/agent/${encodeURIComponent(sid)}`));
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(apiPath(`/api/agent/${encodeURIComponent(sid)}`));
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        const refreshed = await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid || !refreshed) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(apiPath(`/api/agent/${encodeURIComponent(sid)}`));
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      refreshErrorRef.current = null;
      setRefreshError(null);
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
      if (state?.tokensPerSecond !== undefined) setTokensPerSecond(state.tokensPerSecond ?? null);
      setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
      if (state?.planMode !== undefined) setPlanMode(state.planMode ?? null);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream]);
  const refreshContextUsage = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    const requestId = contextUsageRequestIdRef.current + 1;
    contextUsageRequestIdRef.current = requestId;
    try {
      const res = await fetch(apiPath(`/api/agent/${encodeURIComponent(sid)}`));
      if (!res.ok) return;
      const data = await res.json() as { state?: AgentStateResponse };
      if (
        requestId !== contextUsageRequestIdRef.current
        || sessionIdRef.current !== sid
        || promptRunIdRef.current !== runId
      ) return;
      refreshErrorRef.current = null;
      setRefreshError(null);
      if (data.state?.contextUsage !== undefined) setContextUsage(data.state.contextUsage ?? null);
      if (data.state?.tokensPerSecond !== undefined) setTokensPerSecond(data.state.tokensPerSecond ?? null);
    } catch {
      // The next refresh retries; state reconciliation owns error recovery.
    }
  }, []);

  // Context usage and generation throughput both change after each model/tool
  // turn, not only when the prompt settles. Poll the lightweight state endpoint
  // while the session is active so the context meter and the tok/s readout
  // follow those changes even if an SSE event is missed.
  useEffect(() => {
    if (!agentRunning && !isCompacting) return;
    const refresh = () => {
      const sid = sessionIdRef.current;
      if (sid) void refreshContextUsage(sid);
    };
    refresh();
    const interval = setInterval(refresh, CONTEXT_USAGE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [agentRunning, isCompacting, refreshContextUsage]);


  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // Mid-prompt agent_end (retry/recovery/compaction continuation carries
        // willContinue:true, #124): neither settle the streaming stage nor
        // refresh — the final settlement performs the single coalesced
        // completion refresh. The stream stays open until prompt_done /
        // agent_settled and the idle grace.
        if (!agentRunningRef.current || agentEndContinues(event)) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          void requestHistoryRefresh(sessionIdRef.current);
          fetch(apiPath(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`))
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.tokensPerSecond !== undefined) setTokensPerSecond(d.state.tokensPerSecond ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, d.state?.subagents ?? []));
              if (d.state?.planMode !== undefined) setPlanMode(d.state.planMode ?? null);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
            })
            .catch(() => {});
        }
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void requestHistoryRefresh(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) onAgentEnd?.();
        break;
      }
      case "prompt_done":
        {
          // A prompt queued into a running turn (slash command, steer / follow-up
          // behavior) finishing says nothing about the main turn: only its own
          // submission is settled and the UI stage is left to the main prompt.
          if (typeof event.streamingBehavior === "string") {
            confirmPrompt(event);
            break;
          }
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          // Confirms the submission of this prompt only, even when the poll
          // fallback already settled the UI (a late event must not leave the
          // draft pending) and never one dispatched under another id.
          confirmPrompt(event);
          const firstNotification = notifyPromptStage(runId);
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void requestHistoryRefresh(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        restoreRejectedPrompt(event);
        break;
      case "mode_change": {
        // Server-side transitions (toggle, /plan, plan approval) push the new
        // mode so every open browser tab follows without waiting for a poll.
        const enabled = event.mode === "plan";
        const planFilePath = typeof event.planFilePath === "string" ? event.planFilePath : undefined;
        setPlanMode((prev) => ({
          enabled,
          ...(planFilePath ? { planFilePath } : {}),
          available: prev?.available ?? true,
        }));
        break;
      }
      case "session_renamed": {
        const title = event.title as string | undefined;
        const eventSessionId = event.sessionId as string | undefined;
        if (title && (!eventSessionId || eventSessionId === sessionIdRef.current)) onSessionRenamed?.(title);
        break;
      }
      case "extension_ui_cancelled":
        if (typeof event.requestId === "string") {
          setExtensionDialog((cur) => cur?.id === event.requestId ? null : cur);
        }
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Late-event handling (#124): message_end is accepted even after the
        // run settled (frames can arrive after settlement) — the durable
        // in-place upsert makes a journaled copy idempotent instead of a
        // duplicate. Streaming start/update stay guarded below so buffered
        // frames never resurrect a ghost streaming bubble.
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. The optimistic bubble may sit
          // anywhere in the LIVE TAIL — assistant/toolResult message_end
          // events routinely land after it during a tool-heavy turn — so
          // search the whole tail and replace it IN PLACE (never move it to
          // the end). Only the optimistic bubble may be consumed this way and
          // only once: later same-text queue deliveries must still append.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          setTranscript((prev) => {
            const prevMessages = prev.messages;
            const durableCount = Math.min(prev.entryIds.length, prevMessages.length);
            const commit = (messages: AgentMessage[]) => ({ messages, entryIds: prev.entryIds });
            if (optimisticKey) {
              for (let index = prevMessages.length - 1; index >= durableCount; index -= 1) {
                const candidate = prevMessages[index];
                if (candidate.role !== "user" || userMessageKey(candidate) !== optimisticKey) continue;
                if (optimisticKey === deliveredKey) return prev;
                const next = [...prevMessages];
                next[index] = delivered;
                return commit(next);
              }
            }
            // Splice race (#99): the entry may already sit in the DURABLE
            // journal window — replace that copy in place, never append.
            // The journal stores the same SDK object the wire event emits,
            // so the raced copy carries an IDENTICAL timestamp; a later
            // same-text queued delivery (steer/follow-up set no optimistic
            // key) has a fresh timestamp and must still append. Legacy
            // deliveries without a timestamp fall back to the bounded
            // last-5 search. Identity is the normalized user key (string vs
            // array content forms match); only durable entries are searched.
            const deliveredTs = delivered.timestamp;
            const durableSearchFrom = deliveredTs != null ? 0 : Math.max(0, durableCount - 5);
            for (let index = durableCount - 1; index >= durableSearchFrom; index -= 1) {
              const candidate = prevMessages[index];
              if (candidate.role !== "user" || userMessageKey(candidate) !== deliveredKey) continue;
              if (deliveredTs != null && candidate.timestamp !== deliveredTs) continue;
              const next = [...prevMessages];
              next[index] = delivered;
              return commit(next);
            }
            return commit([...prevMessages, delivered]);
          });
        } else if (completed) {
          const normalized = normalizeToolCalls(completed);
          setTranscript((prev) => {
            const nextMessages = upsertCompletedMessage(prev.messages, prev.entryIds.length, normalized);
            return nextMessages === prev.messages ? prev : { messages: nextMessages, entryIds: prev.entryIds };
          });
        }
        const sid = sessionIdRef.current;
        if (sid) void refreshContextUsage(sid);
        // Durable completion: refresh the outline so mid-turn entries are
        // reachable before turn end (coalesced, never per streamed token).
        if (sid) void loadOutline();
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "subagent_lifecycle": {
        const payload = event.payload as {
          id?: string;
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          description?: string;
          status?: "started" | "completed" | "failed" | "aborted";
          sessionFile?: string;
          parentToolCallId?: string;
        } | undefined;
        if (!payload?.id) break;
        if (payload.status !== "started") {
          const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
            ? "failed"
            : payload.status === "aborted"
              ? "aborted"
              : "completed";
          setSubagents((current) => {
            const previous = current.find((subagent) => subagent.id === payload.id);
            const finished: SubagentSnapshot = {
              id: payload.id!,
              index: payload.index ?? previous?.index ?? 0,
              agent: payload.agent ?? previous?.agent ?? payload.id!,
              agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
              description: payload.description ?? previous?.description,
              status: terminalStatus,
              task: previous?.task,
              assignment: previous?.assignment,
              sessionFile: payload.sessionFile ?? previous?.sessionFile,
              parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
              lastUpdate: Date.now(),
              progress: previous?.progress ? { ...previous.progress, status: terminalStatus } : undefined,
            };
            return mergeSubagentSnapshots(current, [finished]);
          });
          break;
        }
        const started: SubagentSnapshot = {
          id: payload.id,
          index: payload.index ?? 0,
          agent: payload.agent ?? payload.id,
          agentSource: payload.agentSource ?? "bundled",
          description: payload.description,
          status: "running",
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [started]));
        break;
      }
      case "subagent_progress": {
        const payload = event.payload as {
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          task?: string;
          assignment?: string;
          sessionFile?: string;
          parentToolCallId?: string;
          progress?: SubagentSnapshot["progress"];
        } | undefined;
        if (!payload?.progress) break;
        const progress = payload.progress;
        const snapshot: SubagentSnapshot = {
          id: progress.id,
          index: payload.index ?? progress.index,
          agent: payload.agent ?? progress.agent,
          agentSource: payload.agentSource ?? "bundled",
          description: progress.description,
          status: progress.status,
          task: payload.task ?? progress.task,
          assignment: payload.assignment ?? progress.assignment,
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
          progress,
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [snapshot]));
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          const sid = sessionIdRef.current;
          if (sid) {
            // Compaction rewrote the transcript: the old window's pages are
            // stale (#99) and the historic overlay's target may be compacted
            // away — drop the overlay and reload the post-compaction tail.
            windowRef.current = null;
            clearHistoricView();
            void requestHistoryRefresh(sid);
            void refreshContextUsage(sid);
          }
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, cancelEventStreamGrace, clearHistoricView, confirmPrompt, handleExtensionUiRequest, loadOutline, notifyPromptStage, onAgentEnd, onSessionRenamed, refreshContextUsage, requestHistoryRefresh, restoreRejectedPrompt, scheduleEventStreamClose, settleUiStage]);
  handleAgentEventRef.current = handleAgentEvent;

  // A send path that failed before the server accepted the submission must
  // put the user's text (and attached images) back into the composer instead
  // of losing it (#83). restoreSubmission re-persists the draft synchronously
  // and merges with anything typed since — the failed text is prepended
  // above newer input, never a clobber.
  const restoreFailedSubmission = useCallback((
    label: string,
    e: unknown,
    message: string,
    images: AttachedImage[] | undefined,
    targetDraftKey?: string,
  ) => {
    console.error(label, e);
    addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    opts.chatInputRef?.current?.restoreSubmission?.(
      message,
      images?.map(({ data, mimeType }) => ({ data, mimeType })),
      targetDraftKey,
    );
  }, [addNotice, opts.chatInputRef]);

  // `draftKey` is the composer draft the text was taken from (ChatInput passes
  // it): it stays a pending draft until the turn is confirmed, and a rejected
  // send is restored into exactly that draft.
  const handleSend = useCallback(async (message: string, images?: AttachedImage[], draftKey?: string) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) {
      // ChatInput already took the text out of the composer (it stays a pending
      // draft). This send cannot start, so hand the text back rather than drop it.
      restoreFailedSubmission(
        "Failed to send message:",
        new Error(bashRunningRef.current ? "Cannot send while a shell command is running" : "Cannot send while the agent is running"),
        message,
        images,
        draftKey,
      );
      return;
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    // The server echoes this id in the prompt's prompt_done / prompt_error: it
    // is what attributes those events to this submission and to no other (#88).
    const promptId = createClientId();
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;
    // From here the text is an unconfirmed submission (#88): it stays a pending
    // draft until this prompt's own prompt_done confirms the turn.
    const submission = submissions.track(draftKey, message, promptId);
    inFlightPromptRef.current = { promptId, message, images };

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setTranscript((prev) => ({ messages: [...prev.messages, userMsg], entryIds: prev.entryIds }));
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    // Sending leaves any historic browsing view (the user engages the live tail
    // again). Follow is NOT force-resumed: if the user had scrolled up to read,
    // that intent is preserved — the library re-locks only when they return to
    // the bottom or toggle follow on.
    clearHistoricView();

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          promptRequestStarted = true;
          await sendAgentCommand(sid, {
            type: "prompt",
            promptId,
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          promoteNewSession(1, message);
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        promptRequestStarted = true;
        await sendAgentCommand(session.id, {
          type: "prompt",
          promptId,
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      const definitivelyRejected = !promptRequestStarted || isPromptRejectedError(e);
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // until server state confirms the run is idle.
      if (!definitivelyRejected && sentSessionId) {
        // Delivery is unknown: the draft stays on record, and no event (not even
        // one naming this promptId) may confirm it.
        submissions.untrack(submission);
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      rpcPromptPendingRef.current = false;
      agentRunningRef.current = false;
      closeEvents();
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setTranscript((prev) => {
          const last = prev.messages[prev.messages.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? { messages: prev.messages.slice(0, -1), entryIds: prev.entryIds }
            : prev;
        });
      }
      // The prompt never reached the agent: restore the user's text (and any
      // attached images) into the composer. Mirrors the shell-command
      // recovery in executeBash; restoreFailedSubmission also keeps the
      // error notice.
      restoreFailedSubmission(
        "Failed to send message:",
        e,
        message,
        images,
        // The draft the text came from. For a first send that is still the
        // provisional `new:<cwd>` key: the session id only becomes the
        // composer's key once promoteNewSession ran, so it is never the target.
        draftKey,
      );
      // The text is back in the composer: nothing is left unconfirmed.
      submissions.untrack(submission);
      inFlightPromptRef.current = null;
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, restoreFailedSubmission, cancelEventStreamGrace, closeEvents, submissions, clearHistoricView]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    clearHistoricView();
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session, clearHistoricView]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      // An aborted turn may never have recorded the prompt: its submission
      // leaves the tracker, so no event can confirm it, and its draft stays on record.
      const inFlight = agentRunningRef.current ? inFlightPromptRef.current : null;
      if (inFlight) {
        submissions.takeById(inFlight.promptId);
        inFlightPromptRef.current = null;
      }
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, [submissions]);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    // Explicit branch selection invalidates the historic view + outline scope.
    clearHistoricView();
    outlineGenRef.current += 1;
    // Drop the old branch's outline so the rail never shows stale entries while
    // the new branch loads; refetch once the new window is installed.
    setOutline([]);
    outlineAnchorRef.current = null;
    setActiveLeafId(entryId);
    // Branch switch invalidates the windowed pages: the bounded tail of the
    // target leaf replaces them (cache key carries the leaf, #99).
    windowRef.current = null;
    await loadContext(sid, entryId);
    void loadOutline();
  }, [loadContext, clearHistoricView, loadOutline]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    clearHistoricView();
    outlineGenRef.current += 1;
    setOutline([]);
    outlineAnchorRef.current = null;
    const sid = sessionIdRef.current;
    if (!sid) return;
    windowRef.current = null;
    await loadContext(sid, leafId);
    void loadOutline();
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext, clearHistoricView, loadOutline]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, currentModelOverride, isNew, loadSession, setNewSessionModel]);

  /**
   * Switch the session onto the model configured for one of omp's roles.
   *
   * The role is sent along, not just the model, so the transcript records which
   * role drove the change — the same thing `/model` does in the TUI, and what
   * lets omp resolve retry fallbacks for that role later.
   */
  const handleRoleModelChange = useCallback(async (role: string) => {
    const assignment = modelRoles.find((candidate) => candidate.role === role);
    const resolved = assignment?.resolved;
    if (!resolved) return;

    if (isNew) {
      const selectedModel = { provider: resolved.provider, modelId: resolved.modelId };
      const selectedThinkingLevel = resolved.thinkingLevel === "auto"
        ? null
        : resolved.thinkingLevel as Exclude<ThinkingLevelOption, "auto"> | undefined;
      // A role selector can pin a level (`provider/model:high`). Preserve that
      // pin for deferred creation so the initial AgentSession receives it.
      thinkingLevelOverrideRef.current = selectedThinkingLevel ?? null;
      setThinkingLevel(selectedThinkingLevel ?? "auto");
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
    }
    const sid = sessionIdRef.current ?? (isNew ? await ensuringNewSessionRef.current : null);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_role_model", role });
      if (!isNew) setCurrentModelOverride({ provider: resolved.provider, modelId: resolved.modelId });
    } catch (e) {
      console.error("Failed to set role model:", e);
    }
  }, [isNew, modelRoles, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      windowRef.current = null;
      clearHistoricView();
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession, clearHistoricView]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = apiPath(modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models");
    const res = await fetch(modelsUrl, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setHiddenModelCount(d.hiddenModelCount);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    setModelRoles(d.roles ?? []);
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew && !sessionIdRef.current) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  // Enter/exit plan mode through the server's ACP-semantics transition. Both
  // the composer toggle and `/plan` call this — the same path, never a prompt.
  // Returns null on success, or the (already noticed) error message: callers
  // must treat a failed transition as an error so the composer keeps the
  // unsent text (issue #68 follow-up: remote 0.5.6 lacks set_plan_mode and
  // answers HTTP 500; a "handled" success would silently clear the draft).
  const handleSetPlanMode = useCallback(async (enabled: boolean): Promise<string | null> => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      const message = "No active session";
      addNotice({ type: "error", message });
      return message;
    }
    try {
      const result = await sendAgentCommand<{ planMode?: WebPlanModeInfo }>(sid, {
        type: "set_plan_mode",
        enabled,
      });
      if (result?.planMode) setPlanMode(result.planMode);
      return null;
    } catch (e) {
      const message = planModeTransitionErrorMessage(e instanceof Error ? e.message : String(e));
      addNotice({ type: "error", message });
      return message;
    }
  }, [addNotice, ensureNewSession]);


  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          windowRef.current = null;
          clearHistoricView();
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "plan": {
          // Web-native /plan: route through the same set_plan_mode transition
          // as the composer toggle instead of falling back to a model prompt.
          const intent = planSlashCommandIntent(text, planMode?.enabled ?? false);
          if (!intent) return { handled: false };
          // A failed transition must surface as an error so ChatInput keeps
          // the composer text and dispatches nothing — only a successful
          // transition clears the input (issue #68 follow-up).
          const transitionError = await handleSetPlanMode(intent.enabled);
          return planSlashCommandOutcome(intent, transitionError);
        }

        default: {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const result = await sendAgentCommand<{
            handled: boolean;
            output?: string[];
            prompt?: string;
          }>(sid, {
            type: "execute_slash_command",
            message: text,
          });
          if (!result?.handled) return { handled: false };
          const output = result.output?.filter((line) => line.trim()).join("\n\n") ?? "";
          if (output) appendCommandOutput(output);
          if (result.prompt) return { handled: true, prompt: result.prompt };
          if (output) return { handled: true };
          return complete({ handled: true, message: "Command completed" });
        }
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, appendCommandOutput, ensureNewSession, handleSetPlanMode, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, planMode, promoteNewSession, onSessionStatsPanelOpen, clearHistoricView]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[], draftKey?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      restoreFailedSubmission("Failed to steer:", new Error("No active session"), message, images, draftKey);
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      // The queue never took the message server-side, so it must come back
      // to the composer — otherwise a failed steer silently eats the text
      // (#83). The queue panel is untouched (server state).
      restoreFailedSubmission("Failed to steer:", e, message, images, draftKey);
      return;
    }
    confirmQueuedDraft(sid, draftKey, message);
  }, [restoreFailedSubmission]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
    draftKey?: string,
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      restoreFailedSubmission("Failed to queue prompt:", new Error("No active session"), message, images, draftKey);
      return;
    }
    // Unlike a plain steer / follow-up this goes through the prompt path: its
    // outcome is its own prompt_done (confirms the draft) or prompt_error (puts
    // the text back), flagged with this id and `streamingBehavior`. Neither
    // touches the main turn that is running.
    const promptId = createClientId();
    const submission = submissions.track(draftKey, message, promptId);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        promptId,
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      submissions.untrack(submission);
      restoreFailedSubmission("Failed to queue prompt:", e, message, images, draftKey);
    }
  }, [restoreFailedSubmission, submissions]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[], draftKey?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      restoreFailedSubmission("Failed to follow up:", new Error("No active session"), message, images, draftKey);
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      restoreFailedSubmission("Failed to follow up:", e, message, images, draftKey);
      return;
    }
    confirmQueuedDraft(sid, draftKey, message);
  }, [restoreFailedSubmission]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        opts.chatInputRef?.current?.prependText(texts.join("\n\n"));
      }
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level === "auto" ? null : level;
    }
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [isNew]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);


  // Load session on mount (#99): cached window already rendered synchronously;
  // a lightweight state probe decides live vs offline. Live → subscribe SSE
  // FIRST, await the connected boundary, load the journal tail anchored to it,
  // then apply buffered post-boundary frames. Offline → bounded detail only,
  // never spawning a host just to browse history.
  useEffect(() => {
    if (!session) {
      return () => {
        bashRecoveryIdRef.current += 1;
        cancelEventStreamGrace();
        closeEvents();
      };
    }
    const sid = session.id;
    sessionIdRef.current = sid;
    historyLoadGenRef.current += 1;
    // Session scope change: invalidate outline + any historic navigation.
    outlineGenRef.current += 1;
    clearHistoricView();
    setOutline([]);
    setOutlineUserMessages(0);
    outlineAnchorRef.current = null;
    const generation = historyLoadGenRef.current;
    const current = () => sessionIdRef.current === sid && historyLoadGenRef.current === generation;

    const applyAgentState = (agentState: { running: boolean; state?: AgentStateResponse } | null) => {
      if (!agentState?.running || !current()) return;
      loadTools(sid);
      const state = agentState.state;
      if (state?.isStreaming || state?.isPromptRunning) {
        sdkAgentActiveRef.current = Boolean(state.isStreaming);
        rpcPromptPendingRef.current = Boolean(state.isPromptRunning);
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase(state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
        dispatch({ type: "start" });
        // Mid-turn attach: show the accumulated partial immediately (#99).
        if (state.activePartial?.message) {
          dispatch({ type: "update", message: normalizeToolCalls(state.activePartial.message as AgentMessage) });
        }
        if (!state.isStreaming && state.isPromptRunning) {
          void waitForPromptSettlement(sid);
        }
      }
      if (state?.isBashRunning) {
        bashRunningRef.current = true;
        setBashRunning(true);
        void waitForBashSettlement(sid);
      }
      if (state) {
        if (state.isCompacting !== undefined) setIsCompacting(state.isCompacting);
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.tokensPerSecond !== undefined) setTokensPerSecond(state.tokensPerSecond ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.thinkingLevel !== undefined) setThinkingLevel((state.thinkingLevel as ThinkingLevelOption) ?? "auto");
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
        if (state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(state.queuedMessages));
        if (state.subagents !== undefined) setSubagents((currentSnapshots) => mergeSubagentSnapshots(currentSnapshots, state.subagents ?? []));
        if (state.planMode !== undefined) setPlanMode(state.planMode ?? null);
      }
    };

    const bootstrap = async () => {
      let agentState: { running: boolean; state?: AgentStateResponse } | null = null;
      try {
        const stateRes = await fetch(apiPath(`/api/sessions/${encodeURIComponent(sid)}/state`));
        if (stateRes.ok) agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
      } catch {
        // State probe failed: fall through to the bounded detail load.
      }
      if (!current()) return;

      if (agentState?.running) {
        // Subscribe before the anchored history load; frames buffer until the
        // window is installed. A dead stream must not block browsing.
        const connection = connectEvents(sid);
        applyAgentState(agentState);
        const result = await connection;
        if (!current()) return;
        await loadSession(sid, windowRef.current === null, false, result.historyBoundary?.journal ?? null);
        if (!current()) return;
        releaseLiveBuffer();
        if (result.status !== "connected" && result.source.readyState !== EventSource.OPEN) {
          result.source.close();
        }
        return;
      }

      const loaded = await loadSession(sid, windowRef.current === null, true);
      if (!current()) return;
      const loadedState = loaded && typeof loaded === "object" ? loaded : null;
      applyAgentState(loadedState);
      if (loadedState?.running) {
        const connection = await connectEvents(sid);
        if (!current()) return;
        releaseLiveBuffer();
        if (connection.status !== "connected" && connection.source.readyState !== EventSource.OPEN) {
          connection.source.close();
        }
      }
    };
    void bootstrap();
    return () => {
      bashRecoveryIdRef.current += 1;
      historyLoadGenRef.current += 1;
      outlineGenRef.current += 1;
      clearHistoricView();
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  // Immediate upward keyboard intent cancels follow even before the browser
  // emits the resulting scroll event (the library handles wheel/touch/scrollbar
  // and the scroll event itself). Editable targets are excluded so typing in the
  // composer never pauses the transcript.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!UPWARD_SCROLL_KEYS[event.key]) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      pauseAutoFollow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pauseAutoFollow]);

  // Prepending an earlier page must not move the viewport (#99/#104): the library
  // does not compensate scroll anchoring while follow is escaped. Restore on the
  // actual prepend commit (the loader sets prependAnchorRef right before install),
  // never on unrelated live growth during the await. Follow stays paused.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (anchor === null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    prependAnchorRef.current = null;
    let top: number | null = null;
    if (anchor.entryId) {
      const el = container.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(anchor.entryId)}"]`);
      if (el) {
        top = container.scrollTop + (el.getBoundingClientRect().top - container.getBoundingClientRect().top) - anchor.offset;
      }
    }
    if (top === null) top = container.scrollHeight - anchor.distance;
    // Write through the library's scrollTop setter so the resulting scroll event is
    // ignored (ignoreScrollToTop) — a direct write could re-lock follow when paused
    // near the bottom, yanking the viewport on LoadEarlier.
    stickState.scrollTop = Math.max(0, top);
  }, [shownMessages.length, scrollContainerRef, stickState]);

  // Explicit "Load earlier": one bounded page prepended before the shown head.
  // While browsing history it pages the OVERLAY (own anchor/head/leaf, never the
  // live window/cache); otherwise it pages the live journal window. No scroll autoload.
  const handleLoadEarlier = useCallback(async () => {
    pauseAutoFollow();
    if (historyBrowsingRef.current) {
      await loadEarlierOverlay();
    } else {
      await loadEarlierHistory();
    }
  }, [loadEarlierHistory, loadEarlierOverlay, pauseAutoFollow]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, refreshError, activeLeafId, messages: shownMessages, entryIds: shownEntryIds, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, hiddenModelCount, modelThinkingLevels, modelThinkingLevelMaps, modelRoles, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, tokensPerSecond, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, subagents, planMode,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    historyHasEarlier: historyBrowsing ? (historyOverlay?.hasEarlier ?? false) : historyHasEarlier,
    historyLoading, handleLoadEarlier,
    // #104 follow controller + outline + historic navigation
    autoFollow, pauseAutoFollow, resumeAutoFollow, toggleAutoFollow,
    outline, outlineLoading, outlineError, loadOutline,
    historyBrowsing, historyTargetEntryId, historyNavigationLoading, historyNavigationError,
    handleJumpToEntry, handleReturnToLatest, cancelHistoryNavigation,
    // Refs
    sessionIdRef, eventSourceRef, scrollContainerRef, scrollContentRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleRoleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand, handleSetPlanMode,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData,
    uploadSessionFiles,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
