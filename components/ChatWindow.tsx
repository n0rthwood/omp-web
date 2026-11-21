"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  BashExecutionMessage,
  BlockingExtensionUiRequest,
  CustomMessage,
  ExtensionUiRequest,
  SessionInfo,
  SessionTreeNode,
  SubagentSnapshot,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, findStoppedAnswerIndices, getAssistantErrorMessage, getDisplayableAssistantBlocks, hasFinalAnswerBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { MessageView } from "./MessageView";
import { SessionOutline } from "./SessionOutline";
import type { SidePanelDialogRequest, SidePanelDialogResponder } from "./AskDialogContent";
import { ChatInput, resolveImageMimeType, type ChatInputHandle } from "./ChatInput";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { OmpWordmark } from "./OmpWordmark";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import type { SessionStatsInfo } from "@/lib/omp-types";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  onSessionRenamed?: (title: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onSideDialogChange?: (request: SidePanelDialogRequest | null) => void;
  onRespondSideDialog?: (respond: SidePanelDialogResponder | null) => void;
  onRevealSideDialog?: () => void;
  onSubagentsChange?: (subagents: SubagentSnapshot[]) => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

// Matches SessionSidebar.tsx's project-group label convention: last path
// segment, trailing slashes trimmed, falling back to the full path.
export function projectBasename(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments.at(-1) || path;
}

const CHAT_COLUMN_PADDING = 16;

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    const candidate = messages[candidateIdx];
    if (candidate.role === "assistant" && hasFinalAnswerBlocks(candidate)) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, omp drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, defaultExpanded = false, expandSignal = null, children, t }: { messageCount: number; toolCallCount: number; defaultExpanded?: boolean; expandSignal?: { id: string; epoch: number } | null; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // #104: an outline jump into a folded process group must reveal its target
  // before the UI scrolls to it. The signal carries the RESOLVED target id +
  // seek epoch and is only passed to the group actually containing that
  // anchored entry — unrelated pending clicks never re-open old groups, while
  // a same-id re-click after manual collapse bumps the epoch and re-expands.
  const hasExpandSignal = expandSignal !== null;
  const expandEpoch = expandSignal?.epoch ?? 0;
  useEffect(() => {
    if (hasExpandSignal) setExpanded(true);
  }, [hasExpandSignal, expandEpoch]);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, newSessionCwd, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onSessionRenamed, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onSubagentsChange, onOpenFile, onSideDialogChange, onRespondSideDialog, onRevealSideDialog, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const {
    loading, error, refreshError, data, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, hiddenModelCount, modelThinkingLevels, modelThinkingLevelMaps, modelRoles, toolPreset, thinkingLevel,
    retryInfo, contextUsage, tokensPerSecond, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, subagents, planMode,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    historyHasEarlier, historyLoading, handleLoadEarlier,
    sessionIdRef, scrollContainerRef, scrollContentRef,
    autoFollow, toggleAutoFollow,
    outline, outlineLoading, outlineError, loadOutline,
    historyBrowsing, historyTargetEntryId, historyNavigationLoading, historyNavigationError,
    handleJumpToEntry, handleReturnToLatest, cancelHistoryNavigation,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleRoleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand, handleSetPlanMode,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, uploadSessionFiles,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, onSessionRenamed,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });

  useEffect(() => {
    onSideDialogChange?.(extensionDialog?.method === "ask" || extensionDialog?.method === "plan_review" ? extensionDialog : null);
    return () => onSideDialogChange?.(null);
  }, [extensionDialog, onSideDialogChange]);

  useEffect(() => {
    onRespondSideDialog?.(respondToExtensionUi);
    return () => onRespondSideDialog?.(null);
  }, [respondToExtensionUi, onRespondSideDialog]);
  const sessionBusy = agentRunning || bashRunning;

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  // --- #104 outline / scroll UI state (hook owns follow + history navigation) ---
  const chatRegionRef = useRef<HTMLDivElement | null>(null);
  const [regionWidth, setRegionWidth] = useState(0);
  // Rail needs room for the transcript column AND the outline: below this
  // container width (also true when a side panel eats width on a wide screen)
  // the outline becomes a drawer instead.
  const outlineRailSpace = regionWidth >= 1000;
  const [railCollapsed, setRailCollapsed] = useState(false);
  const outlineRail = outlineRailSpace && !railCollapsed;
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [readingEntryId, setReadingEntryId] = useState<string | null>(null);
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(null);
  const [followJustPaused, setFollowJustPaused] = useState(false);
  const prevAutoFollowRef = useRef(autoFollow);
  const jumpSeqRef = useRef(0);
  const seekFrameRef = useRef<number | null>(null);
  // Re-clicking the same outline row (or retrying a failed jump) must still
  // scroll: the hook's target id may not change, so bump a local epoch.
  const [jumpEpoch, setJumpEpoch] = useState(0);
  const lastJumpRequestRef = useRef<string | null>(null);
  // Expansion signal published only once a seek's target is resolved — never
  // on an unrelated pending request.
  const [groupExpand, setGroupExpand] = useState<{ id: string; epoch: number } | null>(null);

  const closeOutline = useCallback(() => setOutlineOpen(false), []);
  const handleOutlineRetry = useCallback(() => { void loadOutline(); }, [loadOutline]);
  const handleOutlineJump = useCallback((entryId: string) => {
    if (!outlineRailSpace) setOutlineOpen(false);
    lastJumpRequestRef.current = entryId;
    setJumpEpoch((n) => n + 1);
    void handleJumpToEntry(entryId);
  }, [outlineRailSpace, handleJumpToEntry]);
  const handleReturnLatest = useCallback(() => {
    lastJumpRequestRef.current = null;
    void handleReturnToLatest();
  }, [handleReturnToLatest]);

  // Session switch invalidates any stale jump request (failed-jump guard must
  // not suppress seeks in the new session).
  useEffect(() => {
    lastJumpRequestRef.current = null;
    setGroupExpand(null);
  }, [session?.id]);
  const handleOutlineTrigger = useCallback(() => {
    if (outlineRailSpace) setRailCollapsed((v) => !v);
    else setOutlineOpen((v) => !v);
  }, [outlineRailSpace]);

  // Growing back to rail width dismisses any open drawer (the rail takes over).
  useEffect(() => {
    if (outlineRailSpace) setOutlineOpen(false);
  }, [outlineRailSpace]);

  // Container-based responsiveness (not viewport): the side panel shrinking
  // the chat must demote the rail to a drawer too.
  useEffect(() => {
    const el = chatRegionRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setRegionWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setRegionWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [loading, isEmptyNew, error]);

  // Brief emphasis when following pauses (static under reduced motion).
  useEffect(() => {
    const was = prevAutoFollowRef.current;
    prevAutoFollowRef.current = autoFollow;
    if (was && !autoFollow) {
      setFollowJustPaused(true);
      const id = window.setTimeout(() => setFollowJustPaused(false), 1200);
      return () => window.clearTimeout(id);
    }
    setFollowJustPaused(false);
    return undefined;
  }, [autoFollow]);

  // Current-reading indication: the entry block spanning a probe line near
  // the top of the viewport (falls back to the first visible block, and to
  // the last block when scrolled to the bottom). Pure measurement — never
  // writes the transcript scroll position.
  useEffect(() => {
    // Nothing consumes readingEntryId while the outline is hidden — skip all
    // per-frame measurement cost in that case.
    if (!outlineRail && !outlineOpen) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const blocks = container.querySelectorAll<HTMLElement>("[data-entry-id]");
      const containerRect = container.getBoundingClientRect();
      const probe = containerRect.top + Math.min(120, containerRect.height / 3);
      let current: string | null = null;
      let firstVisible: string | null = null;
      let last: string | null = null;
      for (const block of blocks) {
        const id = block.dataset.entryId;
        if (!id) continue;
        last = id;
        const rect = block.getBoundingClientRect();
        if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) continue;
        if (firstVisible === null) firstVisible = id;
        if (rect.top <= probe && rect.bottom > probe) current = id;
      }
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      setReadingEntryId(current ?? firstVisible ?? (atBottom ? last : null));
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(measure);
    };
    container.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(container);
    const content = scrollContentRef.current;
    if (content) observer?.observe(content);
    // Folded-group expansion / overlay swaps can add anchors without changing
    // content height — watch childList too so reading indication stays fresh.
    const mutations = typeof MutationObserver !== "undefined" && content ? new MutationObserver(schedule) : null;
    if (content) mutations?.observe(content, { childList: true, subtree: true });
    schedule();
    return () => {
      container.removeEventListener("scroll", schedule);
      mutations?.disconnect();
      observer?.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [loading, isEmptyNew, outlineRail, outlineOpen, entryIds, historyBrowsing, historyTargetEntryId, scrollContainerRef, scrollContentRef]);

  // Position the transcript at a resolved history target ONCE, instantly,
  // after its block has mounted (folded process groups auto-expand first).
  // The stick-to-bottom library remains the only follow animator — no bespoke
  // seek tween. A short rAF retry covers React commit latency; latest click
  // wins, and pointer/wheel/touch/scroll-key intent cancels the pending seek
  // and highlight before commit. Highlight is brief, static in reduced motion.
  useEffect(() => {
    const target = historyTargetEntryId;
    if (seekFrameRef.current !== null) {
      window.cancelAnimationFrame(seekFrameRef.current);
      seekFrameRef.current = null;
    }
    // Every seek start clears the previous highlight.
    setHighlightedEntryId(null);
    if (!target || historyNavigationLoading || historyNavigationError) return;
    // An epoch bump from a NEW outline click whose around-fetch is still in
    // flight must not re-seek the OLD resolved target — wait for the hook to
    // publish the clicked id (the target-change run handles it then).
    if (lastJumpRequestRef.current !== null && lastJumpRequestRef.current !== target) return;
    const seq = ++jumpSeqRef.current;
    // Target resolved: publish the expansion signal so ONLY the group whose
    // anchored entries contain this id re-opens (epoch covers same-id re-click).
    setGroupExpand({ id: target, epoch: jumpEpoch });
    const container = scrollContainerRef.current;
    if (!container) return;
    let attempts = 0;
    let highlightTimer = 0;
    const cancelOnIntent = () => {
      if (jumpSeqRef.current !== seq) return;
      jumpSeqRef.current += 1;
      if (seekFrameRef.current !== null) {
        window.cancelAnimationFrame(seekFrameRef.current);
        seekFrameRef.current = null;
      }
      if (highlightTimer) {
        window.clearTimeout(highlightTimer);
        highlightTimer = 0;
      }
      setHighlightedEntryId(null);
    };
    const cancelOnScrollKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || (event.target as HTMLElement | null)?.isContentEditable) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelOnIntent();
    };
    container.addEventListener("pointerdown", cancelOnIntent);
    container.addEventListener("wheel", cancelOnIntent, { passive: true });
    container.addEventListener("touchstart", cancelOnIntent, { passive: true });
    container.addEventListener("keydown", cancelOnScrollKey);
    const trySeek = () => {
      seekFrameRef.current = null;
      if (jumpSeqRef.current !== seq) return;
      const el = container.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(target)}"]`);
      if (!el) {
        attempts += 1;
        if (attempts < 30) {
          seekFrameRef.current = window.requestAnimationFrame(trySeek);
        } else {
          // Exhausted: target never mounted — drop stale highlight/request.
          setHighlightedEntryId(null);
          lastJumpRequestRef.current = null;
        }
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const desiredTop = container.scrollTop + elRect.top - containerRect.top - Math.min(96, containerRect.height / 5);
      const maxTop = container.scrollHeight - container.clientHeight;
      container.scrollTop = Math.max(0, Math.min(desiredTop, maxTop));
      if (jumpSeqRef.current !== seq) return;
      // Seek committed — the stale-request guard has served its purpose.
      lastJumpRequestRef.current = null;
      setHighlightedEntryId(target);
      highlightTimer = window.setTimeout(() => {
        if (jumpSeqRef.current === seq) setHighlightedEntryId(null);
      }, 1600);
    };
    seekFrameRef.current = window.requestAnimationFrame(trySeek);
    return () => {
      if (seekFrameRef.current !== null) {
        window.cancelAnimationFrame(seekFrameRef.current);
        seekFrameRef.current = null;
      }
      if (highlightTimer) window.clearTimeout(highlightTimer);
      container.removeEventListener("pointerdown", cancelOnIntent);
      container.removeEventListener("wheel", cancelOnIntent);
      container.removeEventListener("touchstart", cancelOnIntent);
      container.removeEventListener("keydown", cancelOnScrollKey);
    };
  }, [historyTargetEntryId, historyNavigationLoading, historyNavigationError, jumpEpoch, scrollContainerRef]);

  // Human scroll intent DURING a pending around-fetch cancels the navigation
  // itself (hook invalidates/aborts and clears loading without mutating the
  // shown view) — not merely the late scroll positioning.
  useEffect(() => {
    if (!historyNavigationLoading) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    // Named wrapper: never leak the DOM Event into the hook fn, and keep one
    // stable identity across all add/remove sites (callback identity matters).
    const cancelNav = () => cancelHistoryNavigation();
    const cancelNavOnKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || el?.isContentEditable) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelNav();
    };
    container.addEventListener("pointerdown", cancelNav);
    container.addEventListener("wheel", cancelNav, { passive: true });
    container.addEventListener("touchstart", cancelNav, { passive: true });
    container.addEventListener("keydown", cancelNavOnKey);
    return () => {
      container.removeEventListener("pointerdown", cancelNav);
      container.removeEventListener("wheel", cancelNav);
      container.removeEventListener("touchstart", cancelNav);
      container.removeEventListener("keydown", cancelNavOnKey);
    };
  }, [historyNavigationLoading, cancelHistoryNavigation, scrollContainerRef]);


  useEffect(() => {
    if (!extensionDialog || soundedExtensionDialogIdRef.current === extensionDialog.id) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);
  useEffect(() => {
    onSubagentsChange?.(subagents);
  }, [onSubagentsChange, subagents]);
  useEffect(() => () => { onSubagentsChange?.([]); }, [onSubagentsChange]);


  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    // `type` can be empty for images from some file managers; route on the same
    // rule the composer uses so they never land on the text-upload path (#69).
    const images = files.filter((f) => resolveImageMimeType(f) !== null);
    const others = files.filter((f) => resolveImageMimeType(f) === null);
    if (images.length) chatInputRef?.current?.addImages(images);
    if (others.length) chatInputRef?.current?.addFiles(others);
  }, [sessionBusy, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);


  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      hiddenModelCount={hiddenModelCount}
      onModelChange={handleModelChange}
      modelRoles={modelRoles}
      onRoleModelChange={handleRoleModelChange}
      modelSwitching={modelSwitching}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      contextUsage={contextUsage}
      tokensPerSecond={tokensPerSecond}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      planMode={planMode}
      onSetPlanMode={handleSetPlanMode}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
      onUploadFiles={uploadSessionFiles}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  // #100: the full-screen error is reserved for an initial load with nothing
  // rendered. Once the session view exists (loaded data — even an empty
  // session — messages, or streaming), a failed background refresh only
  // raises the non-blocking indicator below — never replaces the chat.
  if (error && data === null && messages.length === 0 && !streamState.isStreaming && !agentRunning && !bashRunning) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !sessionBusy && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {extensionDialog && extensionDialog.method !== "ask" && extensionDialog.method !== "plan_review" && (
        <ExtensionDialog
          request={extensionDialog}
          onRespond={respondToExtensionUi}
        />
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            {messageCwd && (
              <div
                title={messageCwd}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginLeft: 16,
                  marginRight: 52,
                  marginBottom: 6,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--text-muted)",
                  minWidth: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                  <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" />
                </svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {projectBasename(messageCwd)}
                </span>
              </div>
            )}
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
                <OmpWordmark />
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  omp <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_OMP_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      <div ref={chatRegionRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          data-testid="chat-scroll-header"
          className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5"
          style={{ background: "var(--bg)" }}
        >
          <button
            type="button"
            data-testid="auto-follow-toggle"
            aria-pressed={autoFollow}
            title={autoFollow ? t("outline.followOnTitle") : t("outline.followOffTitle")}
            onClick={toggleAutoFollow}
            className={`flex h-6 flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors ${autoFollow ? "border-border text-text-muted hover:text-text" : "border-[var(--accent)] text-[var(--accent)] hover:brightness-110"} ${followJustPaused && !autoFollow ? "follow-pause-emphasis" : ""}`}
            style={{ background: autoFollow ? "transparent" : "color-mix(in srgb, var(--accent) 10%, transparent)" }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {autoFollow
                ? <path d="M6 1.5v8M2.8 6.5 6 9.7l3.2-3.2" />
                : <path d="M3.5 2.5v7M8.5 2.5v7" />}
            </svg>
            <span className="whitespace-nowrap">{autoFollow ? t("outline.followOn") : t("outline.followOff")}</span>
          </button>
          {historyBrowsing && (
            <span
              data-testid="history-browsing-status"
              role="status"
              className="flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]"
              style={{ background: "color-mix(in srgb, #d97706 12%, transparent)", color: "#d97706" }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="6" cy="6" r="4.5" />
                <path d="M6 3.5V6l1.8 1.2" />
              </svg>
              <span className="whitespace-nowrap">{t("outline.historyBrowsing")}</span>
            </span>
          )}
          {/* Live blocks are hidden from the historical body, so the header
              keeps an accurate global activity indicator while browsing. */}
          {historyBrowsing && (sessionBusy || isCompacting || streamState.isStreaming) && (
            <span
              data-testid="history-live-activity"
              role="status"
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted"
            >
              <span className="inline-block h-2 w-2 flex-shrink-0 animate-[pulse_1.5s_infinite] rounded-full" style={{ background: "var(--accent)" }} aria-hidden="true" />
              <span className="max-w-[260px] truncate">
                {isCompacting ? t("chat.compacting") : (phaseLabel(agentPhase, t) ?? t("outline.liveActivity"))}
              </span>
            </span>
          )}
          {historyNavigationLoading && (
            <span role="status" data-testid="history-nav-loading" className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <span className="inline-block h-3 w-3 animate-[spin_1s_linear_infinite] rounded-full border-[1.5px] border-border border-t-[var(--accent)]" aria-hidden="true" />
              <span className="whitespace-nowrap">{t("outline.historyLoading")}</span>
            </span>
          )}
          {historyNavigationError && (
            <span
              role="alert"
              data-testid="history-nav-error"
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-[#ef4444]"
              title={historyNavigationError}
            >
              <span className="max-w-[220px] truncate">{t("outline.historyFailed")}</span>
              {(lastJumpRequestRef.current ?? historyTargetEntryId) && (
                <button
                  type="button"
                  data-testid="history-nav-retry"
                  onClick={() => handleOutlineJump(lastJumpRequestRef.current ?? historyTargetEntryId!)}
                  className="flex-shrink-0 rounded-full border border-border px-2 py-0.5 text-text-muted transition-colors hover:text-text"
                >
                  {t("outline.retry")}
                </button>
              )}
            </span>
          )}
          <span className="min-w-2 flex-1" aria-hidden="true" />
          {historyBrowsing && (
            <button
              type="button"
              data-testid="return-to-latest"
              onClick={handleReturnLatest}
              className="flex h-6 flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-[filter] hover:brightness-110"
              style={{ background: "var(--accent)", color: "#fff" }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 10.5v-8M2.8 5.5 6 2.3l3.2 3.2" />
              </svg>
              <span className="whitespace-nowrap">{t("outline.returnLatest")}</span>
            </button>
          )}
          <button
            type="button"
            ref={outlineTriggerRef}
            data-testid="outline-toggle"
            aria-expanded={outlineRail || outlineOpen}
            aria-controls="session-outline-panel"
            aria-haspopup={outlineRailSpace ? undefined : "dialog"}
            onClick={handleOutlineTrigger}
            className="flex h-6 flex-shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-text-muted transition-colors hover:text-text"
            style={outlineRail ? { color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))" } : undefined}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M1.5 2.5h9M1.5 6h6M1.5 9.5h7.5" />
            </svg>
            <span className="whitespace-nowrap">{t("outline.trigger")}</span>
            {outline.length > 0 && <span className="tabular-nums text-text-dim">{outline.length}</span>}
          </button>
        </div>
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: 0,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        {refreshError && (
          <div
            data-testid="session-refresh-error"
            role="status"
            style={{
              position: "absolute",
              bottom: 8,
              left: 0,
              right: 0,
              zIndex: 40,
              padding: `0 ${CHAT_COLUMN_PADDING}px`,
              pointerEvents: "none",
            }}
          >
            <div
              title={refreshError.message}
              style={{
                width: "fit-content",
                maxWidth: "100%",
                margin: "0 auto",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                borderRadius: 12,
                border: "1px solid color-mix(in srgb, #ef4444 35%, var(--border))",
                background: "color-mix(in srgb, #ef4444 12%, var(--bg-panel))",
                color: "#ef4444",
                fontSize: 12,
                padding: "4px 12px",
              }}
            >
              {t("chat.refreshFailed", { count: refreshError.count, error: refreshError.message })}
            </div>
          </div>
        )}
        {/* The follow library finds wheel targets via the overflow shorthand;
            mixed hidden/auto axes prevent its immediate upward-wheel escape. */}
        <div ref={scrollContainerRef} className="chat-session-scroll min-w-0 flex-1 overflow-auto pt-4 [scrollbar-width:none]">
          <div ref={scrollContentRef} style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            {(() => {
              // Anchor for live-tail detection: the last user message, or a
              // compaction summary when compaction has replaced it mid-turn.
              let lastAnchorIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
              }

              const renderMessage = (idx: number, options: { keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[]; anchor?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const keyPrefix = options.keyPrefix ?? "message";
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble
                  // owns the live timestamp) — never in the frozen historic view.
                  if (showTimestamp && !historyBrowsing && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                // #104: exactly one meaningful block per outline-listed entry
                // gets data-entry-id. Only user/assistant/compaction roles are
                // anchored (branch_summary converts to a user message in
                // session-reader) — paired toolResult entries render null and
                // would leave zero-height wrappers polluting measurement.
                // Exception (#109): ask toolResults render inline under their
                // call AND are outline-listed (role "ask"), so they need an
                // anchor for the outline jump to seek.
                // Split final-assistant renders pass anchor=false on the
                // folded process half so the answer half (or the whole block
                // for tool-only entries) is the unique outline/scroll target.
                const entryId = entryIds[idx];
                const anchorRole = msg.role === "user" || msg.role === "assistant"
                  || (msg.role === "custom" && (msg as CustomMessage).customType === "compaction")
                  || (msg.role === "toolResult" && (msg as ToolResultMessage).toolName === "ask");
                const anchor = options.anchor !== false && !!entryId && anchorRole;
                // Empty/empty-thinking-only non-error assistants render null in
                // MessageView but the outline still lists them — show a compact
                // marker inside the anchor so every outline entry has a target.
                const emptyAssistant = msg.role === "assistant"
                  && getDisplayableAssistantBlocks(msg as AssistantMessage).length === 0
                  && !getAssistantErrorMessage(msg as AssistantMessage);
                const view = emptyAssistant ? (
                  <div
                    key={`${keyPrefix}-view-${idx}`}
                    data-testid="empty-assistant-marker"
                    className="py-1 text-xs italic text-text-dim"
                  >
                    {t("chat.emptyAssistant")}
                  </div>
                ) : (
                  <MessageView
                    key={`${keyPrefix}-view-${idx}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    entryId={entryId}
                    onFork={sessionBusy || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryId}
                    onNavigate={sessionBusy ? undefined : handleNavigate}
                    prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
                    onEditContent={handleEditContent}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                  />
                );
                if (!anchor) return view;
                return (
                  <div
                    key={`${keyPrefix}-entry-${idx}`}
                    data-entry-id={entryId}
                    className={highlightedEntryId === entryId ? "entry-target-flash" : undefined}
                    style={{ minWidth: 0 }}
                  >
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                if (!isGroupAnchor(msg)) {
                  rendered.push(renderMessage(idx));
                  idx += 1;
                  continue;
                }

                const userIdx = idx;
                let endIdx = userIdx + 1;
                while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                if (finalAssistantIdx === -1) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                const isLiveTail = !historyBrowsing && (sessionBusy || streamState.isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isLiveTail) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                rendered.push(renderMessage(userIdx));

                // fileMention messages are context injected directly after the
                // prompt (SDK @-mention auto-read). They must stay visible
                // beside the user message, not fold into the process group —
                // hasDisplayableProcessMessage() excludes them, so without
                // this they would never render on a loaded session.
                for (let mentionIdx = userIdx + 1; mentionIdx < finalAssistantIdx; mentionIdx++) {
                  if (messages[mentionIdx].role === "fileMention") {
                    rendered.push(renderMessage(mentionIdx));
                  }
                }

                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                const finalProcessMessage = finalSplit.processBlocks.length > 0
                  ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
                  : null;
                const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                  : null;

                // Messages that already ended their model turn with an answer
                // (stopReason "stop") stay visible even when the turn went on
                // — e.g. omp's todo reminder re-woke the agent and its short
                // recap became the "final" message. Only the process messages
                // between them fold, one group per run.
                const stoppedAnswers = new Set(findStoppedAnswerIndices(messages, userIdx, finalAssistantIdx));
                let run: { start: number; nodes: ReactNode[]; count: number; toolCalls: number; entryIds: string[] } | null = null;
                // anchored=false halves (stopped/final process splits whose
                // answer renders outside) must NOT join group membership —
                // otherwise seeking the outside answer force-opens the group.
                const addToRun = (start: number, entryIdx: number, node: ReactNode, toolCalls: number, anchored = true) => {
                  if (!run) run = { start, nodes: [], count: 0, toolCalls: 0, entryIds: [] };
                  run.nodes.push(node);
                  run.count += 1;
                  run.toolCalls += toolCalls;
                  const runEntryId = entryIds[entryIdx];
                  if (anchored && runEntryId) run.entryIds.push(runEntryId);
                };
                const flushRun = (isLast: boolean) => {
                  if (!run) return;
                  const { start, nodes, count, toolCalls, entryIds: runEntryIds } = run;
                  run = null;
                  rendered.push(
                    <div key={`process-group-${userIdx}-${isLast ? finalAssistantIdx : start}`}>
                      <ProcessDetailsGroup
                        messageCount={count}
                        defaultExpanded={isLast && !finalAnswerMessage}
                        t={t}
                        toolCallCount={toolCalls}
                        expandSignal={groupExpand !== null && runEntryIds.includes(groupExpand.id) ? groupExpand : null}
                      >
                        {nodes}
                      </ProcessDetailsGroup>
                    </div>,
                  );
                };

                for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                  const processMessage = messages[processIdx];
                  if (stoppedAnswers.has(processIdx)) {
                    const stoppedMessage = processMessage as AssistantMessage;
                    const split = splitFinalAssistantBlocks(stoppedMessage);
                    if (split.processBlocks.length > 0) {
                      addToRun(
                        processIdx,
                        processIdx,
                        renderMessage(processIdx, {
                          keyPrefix: "process-stopped",
                          messageOverride: withAssistantBlocks(stoppedMessage, split.processBlocks, { omitUsage: true }),
                          showTimestamp: false,
                          anchor: false,
                        }),
                        countToolCallBlocks(split.processBlocks),
                        false,
                      );
                    }
                    flushRun(false);
                    rendered.push(renderMessage(processIdx, { messageOverride: withAssistantBlocks(stoppedMessage, split.answerBlocks) }));
                    continue;
                  }
                  if (hasDisplayableProcessMessage(processMessage)) {
                    addToRun(processIdx, processIdx, renderMessage(processIdx, { keyPrefix: "process" }), countToolCalls(messages, [processIdx]));
                  } else if (processMessage.role === "assistant" && entryIds[processIdx]) {
                    // Empty/empty-thinking-only assistant entries are listed
                    // by the outline but MessageView renders null for them —
                    // keep a compact anchored marker so seeks never exhaust.
                    addToRun(processIdx, processIdx, renderMessage(processIdx, { keyPrefix: "process-empty" }), 0);
                  } else if (processMessage.role === "toolResult" && (processMessage as ToolResultMessage).toolName === "ask" && entryIds[processIdx]) {
                    // #109: ask answers render inside the paired toolCall view;
                    // the outline still lists this toolResult (role "ask"), so
                    // keep a zero-height anchor for the jump to seek.
                    addToRun(processIdx, processIdx, renderMessage(processIdx, { keyPrefix: "process-ask-anchor" }), 0);
                  }
                }
                if (finalProcessMessage) {
                  addToRun(
                    finalAssistantIdx,
                    finalAssistantIdx,
                    renderMessage(finalAssistantIdx, { keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false, anchor: !finalAnswerMessage }),
                    countToolCallBlocks(finalSplit.processBlocks),
                    !finalAnswerMessage,
                  );
                }
                flushRun(true);

                if (finalAnswerMessage) {
                  // Each tool call is stored as its own assistant entry, so the
                  // final answer alone carries no record of what the turn wrote.
                  // Gather the turn's assistant blocks and derive the file list
                  // from the write/edit calls among them.
                  const turnContent: AssistantContentBlock[] = [];
                  for (let i = userIdx + 1; i <= finalAssistantIdx; i++) {
                    const m = messages[i];
                    if (m?.role === "assistant") {
                      for (const b of (m as AssistantMessage).content ?? []) turnContent.push(b);
                    }
                  }
                  const writtenFiles = extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd);
                  rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage, writtenFiles }));
                }
                if (!finalProcessMessage && !finalAnswerMessage && entryIds[finalAssistantIdx]) {
                  // Empty final assistant (no displayable blocks, no error):
                  // outline lists it, so render a compact anchored marker.
                  rendered.push(renderMessage(finalAssistantIdx, { keyPrefix: "empty-final" }));
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                idx = endIdx;
              }
              // #99: the journal window IS the render list — no client-side
              // render slicing. Earlier history pages in only through the
              // explicit button (never scroll-triggered).
              return (
                <>
                  {historyHasEarlier && (
                    <div className="py-3 text-center">
                      <button
                        type="button"
                        data-testid="load-earlier"
                        aria-label={t("chat.loadEarlier")}
                        disabled={historyLoading}
                        onClick={() => void handleLoadEarlier()}
                        className="rounded-full border border-border bg-bg-panel px-4 py-1.5 text-xs text-text-muted transition-colors hover:text-text disabled:opacity-50"
                      >
                        {historyLoading ? t("chat.loadingEarlier") : t("chat.loadEarlier")}
                      </button>
                    </div>
                  )}
                  {rendered}
                </>
              );
            })()}
            {/* #104: while browsing history, live-only streaming/pending
                content is hidden from the transcript body. Global agent
                activity still shows in the header controls + composer. */}
            {!historyBrowsing && streamState.isStreaming && streamState.streamingMessage && (
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} />
            )}

            {!historyBrowsing && agentRunning && !streamState.streamingMessage && agentPhase && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {!historyBrowsing && bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {!historyBrowsing && pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {(extensionDialog?.method === "ask" || extensionDialog?.method === "plan_review") && (
              <div
                data-testid={extensionDialog.method === "plan_review" ? "plan-inline-card" : "ask-inline-card"}
                style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, margin: "10px 0", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", fontSize: 12 }}
              >
                <span aria-hidden="true" style={{ display: "grid", placeItems: "center", flexShrink: 0, width: 20, height: 20, borderRadius: 5, background: "color-mix(in srgb, var(--accent) 12%, var(--bg-panel))", color: "var(--accent)", fontWeight: 750 }}>?</span>
                <span style={{ flexShrink: 0, color: "var(--text)", fontWeight: 600 }}>
                  {t(extensionDialog.method === "plan_review" ? "chat.planApproval" : "chat.agentQuestion")}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                  {(extensionDialog.method === "plan_review" ? extensionDialog.title : extensionDialog.questions[0]?.question)?.slice(0, 120)}
                </span>
                <button
                  type="button"
                  onClick={onRevealSideDialog}
                  style={{ flexShrink: 0, padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--accent)", cursor: "pointer" }}
                >
                  {t("chat.openQuestion")}
                </button>
              </div>
            )}


            </div>
          </div>
        </div>
        {outlineRail && (
          <SessionOutline
            variant="rail"
            entries={outline}
            loading={outlineLoading}
            error={outlineError}
            onRetryLoad={handleOutlineRetry}
            readingEntryId={readingEntryId}
            targetEntryId={historyTargetEntryId}
            navigating={historyNavigationLoading}
            onJump={handleOutlineJump}
            onClose={closeOutline}
          />
        )}
        {outlineOpen && !outlineRail && (
          <SessionOutline
            variant="drawer"
            entries={outline}
            loading={outlineLoading}
            error={outlineError}
            onRetryLoad={handleOutlineRetry}
            readingEntryId={readingEntryId}
            targetEntryId={historyTargetEntryId}
            navigating={historyNavigationLoading}
            onJump={handleOutlineJump}
            onClose={closeOutline}
            triggerRef={outlineTriggerRef}
          />
        )}
        </div>
      </div>

      <div className="relative">
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {chatInputElement}
        <ExtensionStatusBar statuses={extensionStatuses} />
      </div>
      </>
      )}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

export function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option, index) => {
                const label = typeof option === "string" ? option : option.label;
                const description = typeof option === "string" ? undefined : option.description;
                return (
                  <button
                    key={`${label}:${index}`}
                    onClick={() => onRespond(request, { value: label })}
                    style={{
                      width: "100%",
                      padding: "9px 10px",
                      borderRadius: 7,
                      border: "1px solid var(--border)",
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 13,
                    }}
                  >
                    <span style={{ display: "block" }}>{label}</span>
                    {description && (
                      <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>
                        {description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
