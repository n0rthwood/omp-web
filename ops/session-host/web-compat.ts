/**
 * Web command compatibility layer for the session host (issue #94, contract
 * §§3–4). The SDK's runRpcMode owns the rpc protocol; this module intercepts
 * the commands whose OLD in-process wrapper behavior differs from the SDK
 * (web-shaped get_state, role-aware set_model, plan mode, fork, bash-only
 * persistence, auto-title, session_info mirrors) and answers them host-side.
 * Everything else is forwarded to the SDK dispatcher verbatim.
 *
 * Ported from lib/rpc-manager.ts @ 822c1cf (AgentSessionWrapper.send and its
 * helpers). Cache invalidation (models-cache/session-reader) stays web-side
 * and is deliberately absent here.
 */
import type { AgentSession, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { SessionManager as SessionManagerClass, tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
  executeAcpBuiltinSlashCommand,
  type AcpBuiltinSlashCommandResult,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import {
  readRpcSubagentTranscript,
  RpcSubagentRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { isRpcSessionSettled } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getOmpSetting } from "../../lib/omp-setting-access";
import {
  applyWebPlanModeTransition,
  readPersistedPlanModeState,
  shouldEnterPlanModeOnStartupWeb,
  webPlanModeInfo,
  WEB_DEFAULT_PLAN_FILE_URL,
  type ModeChangeEntryLike,
  type WebPlanModeSession,
} from "../../lib/plan-mode-web";
import { PRESET_FULL } from "../../lib/tool-presets";
import {
  fallbackTitle,
  findFirstTitleSource,
  findFirstUserMessage,
  generateSessionTitle,
  shouldAutoGenerateTitle,
} from "../../lib/session-title";
import { sessionPathKey } from "../../lib/session-path";
import { readSessionHeader } from "../../lib/session-reader";
import type { AgentSessionLike, SlashCommandInfo, ToolInfo } from "../../lib/omp-types";
import { validateAgentImages } from "../../lib/image-attachments";
import type {
  ExtensionUiResponse,
  SessionMessageEntry,
  SessionStatus,
  SubagentSnapshot,
} from "../../lib/types";
import { boundActivePartial, type HostHistoryBoundary, type HostJournalAnchor, type HostSessionInfoFrame } from "../../lib/session-host-protocol";
import type { SessionTransport } from "./transport";
import type { WebUiDecoration } from "./ui-decoration";

const MAX_SUBAGENT_HISTORY = 128;

/** Wire levels accepted by AgentSession.setThinkingLevel (SDK
 *  ConfiguredThinkingLevel union, rpc-wire.generated.d.ts:277). */
const CONFIGURED_THINKING_LEVELS: Record<string, true> = {
  auto: true, inherit: true, off: true, minimal: true, low: true,
  medium: true, high: true, xhigh: true, max: true,
};

/**
 * Boundary view for the lib helpers that take `AgentSessionLike`
 * (generateSessionTitle). The structural view intentionally widens
 * `modelRegistry.refresh` to `(strategy?: string)`; the SDK narrows it to
 * `ModelRefreshStrategy`, which is not assignable under parameter
 * contravariance. The title helpers never call refresh (they only read
 * getAvailable/getApiKey/resolver), so the view is safe — this is the same
 * boundary the old wrapper crossed by storing `inner: AgentSessionLike`.
 */
type TitleGenerationSession = AgentSessionLike;

/**
 * Boundary view for lib/plan-mode-web helpers. The lib snapshot spells the
 * non-parallel workflow "sequential" while SDK PlanModeState spells it
 * "iterative"; neither value is ever read by these helpers (they only touch
 * enabled/planFilePath/reentry and pass workflow through opaquely), so the
 * views are behavior-identical — same cast boundary as the old wrapper's
 * `inner: AgentSessionLike`.
 */
type WebPlanSession = WebPlanModeSession;

const CODING_TOOL_NAMES: Record<string, true> = Object.fromEntries(
  PRESET_FULL.map((name) => [name, true]),
);

/** SDK dispatcher cases (rpc-mode.ts). Only these are forwarded; anything
 *  else is answered host-side so the SDK's `Unknown command:` never surfaces. */
const SDK_COMMAND_TYPES: Record<string, true> = {
  abort: true,
  abort_and_prompt: true,
  abort_and_restore_queue: true,
  abort_bash: true,
  abort_retry: true,
  bash: true,
  branch: true,
  btw: true,
  btw_cancel: true,
  cancel_subagent: true,
  compact: true,
  cycle_model: true,
  cycle_thinking_level: true,
  export_html: true,
  follow_up: true,
  fork: true,
  get_available_commands: true,
  get_available_models: true,
  get_available_thinking_levels: true,
  get_branch_messages: true,
  get_btw_history: true,
  get_entries: true,
  get_last_assistant_text: true,
  get_login_providers: true,
  get_logout_accounts: true,
  get_messages: true,
  get_messages_page: true,
  get_session_stats: true,
  get_state: true,
  get_subagent_messages: true,
  get_subagents: true,
  get_tree: true,
  goal: true,
  handoff: true,
  live_mute: true,
  live_start: true,
  live_stop: true,
  login: true,
  logout: true,
  negotiate_protocol: true,
  new_session: true,
  open_session: true,
  predict_word: true,
  predict_word_feedback: true,
  promote_queued_message: true,
  prompt: true,
  remove_queued_message: true,
  set_ask_dialog: true,
  set_auto_compaction: true,
  set_auto_retry: true,
  set_cache_warming: true,
  set_event_filter: true,
  set_fast_mode: true,
  set_follow_up_mode: true,
  set_host_tools: true,
  set_host_uri_schemes: true,
  set_interrupt_mode: true,
  set_model: true,
  set_session_name: true,
  set_slow_mode: true,
  set_steering_mode: true,
  set_subagent_subscription: true,
  set_thinking_level: true,
  set_todos: true,
  steer: true,
  steer_subagent: true,
  switch_session: true,
};

/** Commands that must wait for runRpcMode's extension initialization. */
const EXTENSION_GATED_TYPES: Record<string, true> = {
  prompt: true,
  steer: true,
  follow_up: true,
  get_commands: true,
  execute_slash_command: true,
};

export function withExtensionTools(session: AgentSession, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];
  const extensionToolNames = session
    .getAllToolNames()
    .filter((name) => CODING_TOOL_NAMES[name] !== true);
  return [...new Set([...toolNames, ...extensionToolNames])];
}

/** Tool descriptors for the browser's tool picker. */
function listTools(session: AgentSession): ToolInfo[] {
  return session.getAllToolNames().map((name) => ({
    name,
    description: session.getToolByName(name)?.description ?? "",
  }));
}

function appendSlashCommand(
  commands: SlashCommandInfo[],
  seenNames: Set<string>,
  command: SlashCommandInfo,
): void {
  const name = command.name.trim();
  if (!name || seenNames.has(name)) return;
  seenNames.add(name);
  commands.push({ ...command, name });
}

/**
 * Keep the browser palette aligned with omp's own command registry and
 * discovery pipeline (port of rpc-manager.ts getAvailableSlashCommands).
 */
export async function getAvailableSlashCommands(session: AgentSession): Promise<SlashCommandInfo[]> {
  const commands: SlashCommandInfo[] = [];
  const seenNames = new Set<string>();

  for (const builtin of BUILTIN_SLASH_COMMAND_DEFS) {
    const hint = builtin.inlineHint;
    appendSlashCommand(commands, seenNames, {
      name: builtin.name,
      aliases: builtin.aliases,
      description: builtin.description,
      source: "builtin",
      ...(hint ? { input: { hint } } : {}),
      ...(builtin.subcommands ? { subcommands: builtin.subcommands } : {}),
    });
  }

  const discovered = await buildAvailableSlashCommands(session);
  for (const command of discovered) {
    // Builtins were taken from the complete registry above, including
    // commands without an ACP/text-mode handler such as /plan and /handoff.
    if (command.source === "builtin") continue;
    appendSlashCommand(commands, seenNames, command);
  }

  // Prompt templates are a separate SDK resource from custom commands and
  // file-based commands, so retain them explicitly in the browser contract.
  for (const template of session.promptTemplates) {
    appendSlashCommand(commands, seenNames, {
      name: template.name,
      description: template.description,
      source: "prompt",
      ...(template.source ? { path: template.source } : {}),
    });
  }

  return commands;
}

// ---------------------------------------------------------------------------
// session_info mirror computation (port of runtimeMessageText /
// runtimeMessageActivityMs / runtimeSessionStatus / getRpcSessionInfos).
// ---------------------------------------------------------------------------

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution" || entry.message.role === "fileMention") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Coarse {@link SessionStatus} for a live in-memory session, mirroring the
 * SDK's file-tail classification without extra disk I/O (port verbatim).
 */
function runtimeSessionStatus(messages: SessionMessageEntry[], isRunning: boolean): SessionStatus {
  if (isRunning) return "pending";
  const last = messages[messages.length - 1]?.message;
  if (!last) return "unknown";
  switch (last.role) {
    case "assistant":
      if (last.stopReason === "error") return "error";
      if (last.stopReason === "aborted") return "aborted";
      if (last.stopReason === "length") return "interrupted";
      return last.content.some((block) => block.type === "toolCall") ? "interrupted" : "complete";
    case "toolResult":
      return "interrupted";
    case "user":
      return "pending";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Subagent lifecycle payload shapes (wire frames carry the same payloads the
// old wrapper consumed from session.subscribe).
// ---------------------------------------------------------------------------

interface SubagentLifecyclePayload {
  id?: string;
  index?: number;
  agent?: string;
  agentSource?: "bundled" | "user" | "project";
  description?: string;
  status?: "started" | "completed" | "failed" | "aborted";
  sessionFile?: string;
  parentToolCallId?: string;
}

interface SubagentProgressPayload {
  progress?: { id?: string };
}

interface PromptMeta {
  message: string;
  streamingBehavior?: string;
  /** Client draft identity (#88); rides prompt_result via a host-only frame. */
  promptId?: string;
}

export interface WebCompatOptions {
  session: AgentSession;
  sessionManager: SessionManager;
  settings: Settings;
  cwd: string;
  transport: SessionTransport;
  /** Decoration is installed by runRpcMode's setToolUIContext callback, which
   *  may run after this module is constructed; absent until then. */
  getDecoration: () => WebUiDecoration | undefined;
  eventBus: EventBus;
  subagentEventBus?: EventBus;
  /** Clean host shutdown: close the shell-owned input → SDK EOF teardown. */
  onShutdown: () => void;
  /** Startup persisted an explicit model default (old wrapper invalidated the
   *  web models cache); carried on the next session_info mirror. */
  modelDefaultChanged?: boolean;
}

/** Wire command shape: the transport parses NDJSON; commands carry a string
 *  `type` and optional string `id`. Fields are read with typeof checks at use. */
interface WireCommand {
  type: string;
  id?: string;
  [key: string]: unknown;
}

interface OutboundResponse {
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
}

export interface WebCompat {
  handleInboundFrame(frame: unknown): void;
  handleOutboundFrame(frame: unknown): void;
  emitSessionInfo(): void;
  hasLiveSubagents(): boolean;
  /** Atomic durable journal/live boundary (#99), captured synchronously. */
  captureHistoryBoundary(): HostHistoryBoundary;
  /**
   * Admitted prompts still awaiting prompt_result that carry a client draft
   * identity (#88). Journal-mode attach (#99) skips ring replay, so the host
   * re-emits their host_prompt_identity frames at attach — a reattached web
   * wrapper can still settle the original submitter's draft.
   */
  pendingPromptIdentities(): Array<{ id: string; promptId: string; streamingBehavior?: string }>;
  /** Resolves when runRpcMode has bound extensions (available_commands_update). */
  readonly extensionsReady: Promise<void>;
  dispose(): void;
}

/**
 * Durable journal anchor + atomic wire splice (#99), captured synchronously in
 * ONE callback (journal-mode attach handshake / get_history_anchor control):
 *   1. flushSync makes every appended entry durable (append-only fast path;
 *      pending rewrites are materialized synchronously by the SDK);
 *   2. stat + cheap SDK accessors snapshot the durable position — no entry
 *      body parsing, no full-entry copying;
 *   3. the CURRENT ring seq completes the boundary: journal ≤ anchor was all
 *      emitted at seq ≤ boundary.seq; live frames after it are post-boundary.
 * A transient (unpersisted) session yields the empty anchor; nothing durable
 * exists, so the whole conversation is live-stream territory.
 */
export function captureJournalBoundary(sessionManager: SessionManager, currentSeq: () => number): HostHistoryBoundary {
  const anchor: HostJournalAnchor = {
    lastEntryId: null,
    leafId: null,
    entryCount: 0,
    sizeBytes: 0,
    mtimeMs: 0,
  };
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile && sessionManager.isSessionOnDisk()) {
    sessionManager.flushSync();
    const stat = statSync(sessionFile);
    anchor.sizeBytes = stat.size;
    anchor.mtimeMs = stat.mtimeMs;
    // lastEntryId = PHYSICAL durable tail (bounds reads); leafId = the active
    // branch leaf, which after navigate_tree/fork points mid-file.
    const entries = sessionManager.getEntries();
    anchor.entryCount = entries.length;
    anchor.lastEntryId = entries[entries.length - 1]?.id ?? null;
    anchor.leafId = sessionManager.getLeafId();
  }
  return { seq: currentSeq(), journal: anchor };
}

export function createWebCompat(options: WebCompatOptions): WebCompat {
  const { session, sessionManager, settings, cwd, transport, onShutdown } = options;

  // Named boundary adapters (see type justifications above): only the lib
  // helper call groups below consume these views; everything else uses the
  // real AgentSession.
  const webSession = session as unknown as TitleGenerationSession;
  const webPlanSession = session as unknown as WebPlanSession;

  // Shadow registry: runRpcMode's own registry is a local const, unreachable
  // from here. This one subscribes to the same bus for snapshots/transcript
  // resolution only; subscription level stays "off" and output is a no-op, so
  // it never emits wire frames (the SDK registry owns those).
  const subagents = new RpcSubagentRegistry(options.subagentEventBus ?? options.eventBus, () => {});
  const subagentHistory = new Map<string, SubagentSnapshot>();
  const promptMeta = new Map<string, PromptMeta>();
  let autoTitleInFlight = false;
  let forceEmptySystemPrompt = false;
  let disposed = false;
  /** Latest in-flight assistant partial (#99), fed by the outbound tap. */
  let activePartial: { message: unknown; messageId?: string } | undefined;

  const { promise: extensionsReady, resolve: markExtensionsBound } = Promise.withResolvers<void>();
  let extensionsBound = false;

  function respondSuccess(id: unknown, command: string, data?: object | null): void {
    transport.emitHostFrame({
      id,
      type: "response",
      command,
      success: true,
      ...(data !== undefined ? { data } : {}),
    });
  }

  function respondError(id: unknown, command: string, message: string): void {
    transport.emitHostFrame({ id, type: "response", command, success: false, error: message });
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** Background a long host-side command; the response lands when it settles. */
  function runHostCommand(id: unknown, command: string, operation: () => Promise<object | null | undefined>): void {
    void (async () => {
      try {
        const data = await operation();
        respondSuccess(id, command, data);
      } catch (error) {
        respondError(id, command, errorMessage(error));
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Subagent history (bounded port of rememberSubagentSnapshot /
  // rememberSubagentFrame / getSubagentSnapshots).
  // -------------------------------------------------------------------------

  function rememberSubagentSnapshot(snapshot: SubagentSnapshot): void {
    subagentHistory.set(snapshot.id, snapshot);
    if (subagentHistory.size <= MAX_SUBAGENT_HISTORY) return;
    const removable = [...subagentHistory.values()]
      .filter((entry) => entry.status !== "pending" && entry.status !== "running")
      .sort((left, right) => left.lastUpdate - right.lastUpdate);
    while (subagentHistory.size > MAX_SUBAGENT_HISTORY && removable.length > 0) {
      const oldest = removable.shift();
      if (oldest) subagentHistory.delete(oldest.id);
    }
  }

  function rememberSubagentFrame(frame: { type: string; payload?: unknown }): void {
    if (frame.type === "subagent_progress") {
      const payload = frame.payload as SubagentProgressPayload | undefined;
      const id = payload?.progress?.id;
      if (!id) return;
      const live = subagents.getSubagents().find((entry) => entry.id === id);
      if (live) {
        const snapshot = live as unknown as SubagentSnapshot;
        rememberSubagentSnapshot(snapshot);
      }
      return;
    }
    if (frame.type !== "subagent_lifecycle") return;
    const payload = frame.payload as SubagentLifecyclePayload | undefined;
    if (!payload?.id || !payload.status) return;
    const live = subagents.getSubagents().find((entry) => entry.id === payload.id);
    if (payload.status === "started") {
      if (live) {
        const snapshot = live as unknown as SubagentSnapshot;
        rememberSubagentSnapshot(snapshot);
      }
      return;
    }
    const liveSnapshot = live as unknown as SubagentSnapshot | undefined;
    const previous = liveSnapshot ?? subagentHistory.get(payload.id);
    const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
      ? "failed"
      : payload.status === "aborted"
        ? "aborted"
        : "completed";
    rememberSubagentSnapshot({
      id: payload.id,
      index: payload.index ?? previous?.index ?? 0,
      agent: payload.agent ?? previous?.agent ?? payload.id,
      agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
      description: payload.description ?? previous?.description,
      status: terminalStatus,
      task: previous?.task,
      assignment: previous?.assignment,
      sessionFile: payload.sessionFile ?? previous?.sessionFile,
      lastUpdate: Date.now(),
      parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
      progress: previous?.progress
        ? { ...previous.progress, status: terminalStatus }
        : undefined,
    });
  }

  function getSubagentSnapshots(): SubagentSnapshot[] {
    for (const live of subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      rememberSubagentSnapshot(snapshot);
    }
    const snapshots = new Map(subagentHistory);
    for (const live of subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      snapshots.set(snapshot.id, snapshot);
    }
    return [...snapshots.values()].sort((left, right) => {
      const leftActive = left.status === "pending" || left.status === "running";
      const rightActive = right.status === "pending" || right.status === "running";
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (leftActive) return left.index - right.index || left.id.localeCompare(right.id);
      return right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id);
    });
  }

  // -------------------------------------------------------------------------
  // Plan mode (port of syncPlanModeFromSession / handlePlanProposal).
  // -------------------------------------------------------------------------

  function syncPlanModeFromSession(): void {
    let state = session.getPlanModeState();
    if (!state) {
      // Boundary: lib snapshot spells the non-parallel workflow "sequential",
      // SDK PlanModeState spells it "iterative". The lib only ever writes
      // "sequential" for legacy journal entries and the SDK never reads
      // workflow, so translating keeps both vocabularies lossless.
      const persisted = readPersistedPlanModeState(
        sessionManager.getEntries() as ModeChangeEntryLike[],
      );
      state = persisted && {
        enabled: persisted.enabled,
        planFilePath: persisted.planFilePath,
        ...(persisted.workflow
          ? { workflow: persisted.workflow === "sequential" ? "iterative" as const : "parallel" as const }
          : {}),
        ...(persisted.reentry !== undefined ? { reentry: persisted.reentry } : {}),
      };
      if (state) session.setPlanModeState(state);
    }
    if (state?.enabled) {
      session.setPlanProposalHandler((title) => handlePlanProposal(title));
    }
    if (!session.getPlanModeState()?.enabled && shouldEnterPlanModeOnStartupWeb(
      sessionManager.getEntries() as ModeChangeEntryLike[],
      sessionManager.buildSessionContext().messages.length,
      {
        defaultOnStartup: getOmpSetting<boolean>(settings, "plan.defaultOnStartup"),
        enabled: getOmpSetting<boolean>(settings, "plan.enabled"),
      },
    )) {
      applyWebPlanModeTransition(
        webPlanSession,
        true,
        (title) => handlePlanProposal(title),
        getOmpSetting<boolean>(settings, "plan.enabled"),
      );
      transport.emitHostFrame({
        type: "mode_change",
        mode: "plan",
        planFilePath: WEB_DEFAULT_PLAN_FILE_URL,
      });
    }
  }

  async function handlePlanProposal(title: string): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }> {
    const state = session.getPlanModeState();
    if (!state?.enabled) {
      throw new Error("Plan mode is not active.");
    }

    const review = await session.preparePlanForReview(title);
    const planFilePath = review.details?.planFilePath;
    const resolvedTitle = review.details?.title;
    if (!planFilePath || !resolvedTitle) {
      throw new Error("The proposed plan could not be resolved.");
    }

    const planContent = await readPlanFile(planFilePath, {
      cwd,
      localProtocolOptions: {
        getArtifactsDir: () => sessionManager.getArtifactsDir(),
        getSessionId: () => sessionManager.getSessionId(),
      },
    });
    if (!planContent?.trim()) {
      throw new Error(`Plan file not found at ${planFilePath}`);
    }

    const decoration = options.getDecoration();
    if (!decoration) throw new Error("Plan mode is not active.");
    const responseValue = await decoration.requestPlanReview(resolvedTitle, planFilePath, planContent);
    let choice: { action?: unknown; feedback?: unknown } = {};
    try {
      choice = JSON.parse(responseValue) as { action?: unknown; feedback?: unknown };
    } catch {
      // Treat malformed or stale browser responses as a request to keep planning.
    }

    const details = { planFilePath, title: resolvedTitle, planExists: true };
    if (choice.action === "approve") {
      session.setPlanReferencePath(planFilePath);
      session.setPlanProposalHandler(null);
      session.setPlanModeState(undefined);
      sessionManager.appendModeChange("none");
      transport.emitHostFrame({ type: "mode_change", mode: "none" });
      return {
        content: [{
          type: "text",
          text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
        }],
        details,
      };
    }

    if (state.planFilePath !== planFilePath) {
      session.setPlanModeState({ ...state, planFilePath });
      sessionManager.appendModeChange("plan", { planFilePath });
    }
    const feedback = typeof choice.feedback === "string" ? choice.feedback.trim() : "";
    return {
      content: [{
        type: "text",
        text: [
          "Plan refinement requested.",
          feedback ? `User feedback:\n${feedback}` : "",
          `Update the plan file, then write ${resolvedTitle} to xd://propose again when ready.`,
        ].filter(Boolean).join("\n\n"),
      }],
      details,
    };
  }

  // -------------------------------------------------------------------------
  // Forced-empty system prompt + bash-only persistence (ports).
  // -------------------------------------------------------------------------

  function applyForcedEmptySystemPrompt(): void {
    if (forceEmptySystemPrompt && session.agent.state) {
      session.agent.state.systemPrompt = [];
    }
  }

  function persistBashOnlySession(): void {
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = sessionManager.getHeader();
    if (!header) return;

    const content = [header, ...sessionManager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // omp normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries. The SDK
    // exposes no public setter for this internal flag.
    const flushable = sessionManager as unknown as { flushed: boolean };
    flushable.flushed = true;
  }

  // -------------------------------------------------------------------------
  // Auto-title (port of maybeAutoGenerateTitle; cache invalidation stays
  // web-side, so only the rename event + mirror are emitted here).
  // -------------------------------------------------------------------------

  async function maybeAutoGenerateTitle(message: string): Promise<void> {
    const commandNames = new Set(
      (session.extensionRunner?.getRegisteredCommands() ?? []).map((command) => command.name),
    );
    const eligible = shouldAutoGenerateTitle({
      message,
      hasSessionName: Boolean(sessionManager.getSessionName()),
      piNoTitle: process.env.PI_NO_TITLE,
      extensionCommandNames: commandNames,
    });
    if (!eligible) return;
    if (autoTitleInFlight) return;
    autoTitleInFlight = true;

    try {
      let title: string | undefined;
      try {
        title = (await generateSessionTitle(webSession, message))?.title;
      } catch (error) {
        console.error("[pi-web] auto title generation failed:", errorMessage(error));
      }
      title ||= fallbackTitle(message);
      if (!title || disposed) return;
      // Re-check after generation: a concurrent manual "Generate title"
      // click may have already named the session while this was in flight.
      if (sessionManager.getSessionName()) return;
      const applied = await sessionManager.setSessionName(title, "auto");
      if (!applied) return;

      transport.emitHostFrame({ type: "session_renamed", title, sessionId: session.sessionId });
      emitSessionInfo();
    } catch (error) {
      console.error("[pi-web] auto title generation failed:", errorMessage(error));
    } finally {
      autoTitleInFlight = false;
    }
  }

  // -------------------------------------------------------------------------
  // session_info mirror (contract §4; sibling HostSessionInfoFrame shape).
  // -------------------------------------------------------------------------

  function hostIsRunning(): boolean {
    return (
      session.isStreaming
      || session.isCompacting
      || session.isBashRunning
      || subagents.getSubagents().length > 0
      || transport.hasOpenPrompt()
    );
  }

  function emitSessionInfo(): void {
    if (disposed) return;
    const header = sessionManager.getHeader();
    const entries = sessionManager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResultMessages = 0;
    for (const entry of messages) {
      if (entry.message.role === "user") userMessages++;
      else if (entry.message.role === "assistant") assistantMessages++;
      else if (entry.message.role === "toolResult") toolResultMessages++;
    }
    const sessionFile = sessionManager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const isRunning = hostIsRunning();

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && (!isRunning || !firstUserMessage)) {
      // Suppressed runtimes get NO discovery sidecar; drop a stale one so a
      // restarted web does not rediscover an idle empty ensure_session host.
      try { unlinkSync(discoverySidecarPath()); } catch { /* never written */ }
      return;
    }

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    const name = sessionManager.getSessionName();
    const frame: HostSessionInfoFrame = {
      type: "session_info",
      sessionId: header?.id ?? session.sessionId,
      sessionFile: sessionFile ?? "",
      cwd: header?.cwd ?? cwd,
      ...(name ? { name } : {}),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      userMessages,
      assistantMessages,
      toolResultMessages,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      persisted,
      status: runtimeSessionStatus(messages, isRunning),
      isRunning,
      ...(options.modelDefaultChanged ? { modelDefaultChanged: true } : {}),
    };
    writeDiscoverySidecar(frame);
    transport.emitHostFrame(frame);
  }

  /** Discovery sidecar lives next to the socket, keyed by the requested key. */
  function discoverySidecarPath(): string {
    return join(dirname(transport.socketPath), `${transport.socketKey}.info`);
  }

  /**
   * Atomically publish the emitted session_info frame so a restarted web can
   * rediscover this host without attaching (contract §3/§5). write tmp +
   * rename so a concurrent refreshHostDiscovery never sees a torn file.
   */
  function writeDiscoverySidecar(frame: HostSessionInfoFrame): void {
    const sidecar = { pid: process.pid, socketKey: transport.socketKey, info: frame };
    const target = discoverySidecarPath();
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(sidecar), "utf8");
      renameSync(tmp, target);
    } catch {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  // -------------------------------------------------------------------------
  // Host-intercepted command bodies.
  // -------------------------------------------------------------------------

  function buildWebState(): Record<string, unknown> {
    // Plan mode may live only in the session journal (fresh host for a
    // TUI-planned session); surface it before reading observable state.
    syncPlanModeFromSession();
    const model = session.model;
    const contextUsage = session.getContextUsage();
    const queuedMessages = session.getQueuedMessages();
    const decoration = options.getDecoration();
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? "",
      isStreaming: session.isStreaming,
      isBashRunning: session.isBashRunning,
      isCompacting: session.isCompacting,
      autoCompactionEnabled: session.autoCompactionEnabled,
      autoRetryEnabled: session.autoRetryEnabled,
      model: model ? { id: model.id, provider: model.provider } : undefined,
      messageCount: 0,
      pendingMessageCount: session.queuedMessageCount,
      queuedMessages: {
        steering: [...queuedMessages.steering],
        followUp: [...queuedMessages.followUp],
        liveSteered: queuedMessages.liveSteered,
      },
      contextUsage: contextUsage
        ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
        : null,
      systemPrompt: [session.agent.state?.systemPrompt ?? ""].flat().join("\n"),
      thinkingLevel: session.agent.state?.thinkingLevel ?? "off",
      extensionStatuses: decoration?.getExtensionStatuses() ?? [],
      extensionWidgets: decoration?.getExtensionWidgets() ?? [],
      subagents: getSubagentSnapshots(),
      planMode: webPlanModeInfo(webPlanSession, getOmpSetting<boolean>(settings, "plan.enabled")),
      // SDK RpcSessionState equivalents the host can read directly. The
      // wrapper owns isPromptRunning; dumpTools is omitted (the web UI never
      // consumed it from the old wrapper either).
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      interruptMode: session.interruptMode,
      sessionName: session.sessionName,
      queuedMessageCount: session.queuedMessageCount,
      hasPendingAsyncWork: session.hasPendingAsyncWork(),
      // The SDK's goal-turn probe lives inside runRpcMode; session_settled
      // frames close any goal-scheduled gap the host cannot see here.
      isSettled: isRpcSessionSettled(session),
      todoPhases: session.getTodoPhases(),
      fastModeEnabled: session.isFastModeEnabled(),
      // TUI composer parity (interactive-mode.ts#tokenRateLabel): the
      // kernel-weighted live meter, which keeps its last reading between
      // turns. The whole-message average covers a host that has not streamed
      // a message in this process yet (fresh attach on a historical session).
      tokensPerSecond: session.tokenRate.rate()
        ?? calculateTokensPerSecond(session.messages, session.isStreaming),
      fastModeActive: session.isFastModeActive(),
      slowModeSupported: session.isSlowModeSupported(),
      slowModeEnabled: session.isSlowModeEnabled(),
      slowModeScope: session.getSlowModeScope(),
      usageLimit: session.getUsageLimitState(),
      goal: session.getGoalModeState() ?? null,
      // Bounded mid-turn snapshot (#99): a browser subscribing mid-stream must
      // see the partial message's already-emitted text without any historical
      // replay. Latest snapshot only; the wrapper overlays its fresher copy.
      activePartial: activePartial ? boundActivePartial(activePartial.message, activePartial.messageId) : null,
    };
  }

  async function executeFork(entryId: string): Promise<{ cancelled: boolean; newSessionId?: string }> {
    if (session.isBashRunning) {
      throw new Error("Cannot fork while a shell command is running");
    }
    const currentSessionFile = session.sessionFile;
    if (!currentSessionFile) return { cancelled: true };

    const entry = sessionManager.getEntry(entryId);
    if (!entry) throw new Error("Invalid entry ID for forking");

    const sessionDir = sessionManager.getSessionDir();
    let newSessionFile: string;

    if (!entry.parentId) {
      // Fork before the first message: create an empty session linked to this one
      const newManager = SessionManagerClass.create(sessionManager.getCwd(), sessionDir);
      await newManager.newSession({ parentSession: currentSessionFile });
      await newManager.ensureOnDisk();
      newSessionFile = newManager.getSessionFile() as string;
    } else {
      // Fork after some history: copy path up to (but not including) the fork point
      const sourceManager = await SessionManagerClass.open(currentSessionFile, sessionDir);
      const forkedPath = sourceManager.createBranchedSession(entry.parentId);
      if (!forkedPath) throw new Error("Failed to create forked session");
      newSessionFile = forkedPath;
    }

    const newSessionId = (await SessionManagerClass.open(newSessionFile, sessionDir)).getSessionId();
    return { cancelled: false, newSessionId };
  }

  /**
   * DELETE semantics moved host-side (issue #94; port of the old
   * app/api/sessions/[id] DELETE handler): the lease-owning host reparents
   * direct children onto this session's parent, unlinks the journal, and
   * tears itself down AFTER the response — the route treats it as terminal.
   * Child journals owned by a foreign live lease are never rewritten here
   * (contract §5: web never writes foreign sessions); they are reported in
   * `refusedForeign` instead of being silently forked or skipped.
   */
  async function executeDeleteSession(): Promise<{ reparented: number; refusedForeign: string[] }> {
    const filePath = sessionManager.getSessionFile();
    if (!filePath) throw new Error("Session not found");

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    let reparented = 0;
    const refusedForeign: string[] = [];
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey
      );
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; id?: string; parentSession?: string };
          if (
            header.type !== "session" ||
            !header.parentSession ||
            sessionPathKey(header.parentSession) !== targetPathKey
          ) continue;
          // Probe-and-release around the write (main.ts startup precedent):
          // the raw OS lease is same-process NON-reentrant, so it must not be
          // held across SessionManager.open's own refcounted claim. A null
          // probe means another live process owns the child — refuse it.
          const probe = header.id ? tryAcquireSessionLease(header.id) : null;
          if (!probe) {
            refusedForeign.push(childPath);
            continue;
          }
          probe.release();
          // Reparent through SessionManager: open claims nothing, the write
          // claims the child lease, close gives it up.
          const childManager = await SessionManagerClass.open(childPath);
          try {
            const childHeader = childManager.getHeader();
            if (!childHeader) throw new Error("missing session header");
            childHeader.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(childHeader);
            writeFileSync(childPath, lines.join("\n"));
            reparented++;
          } finally {
            await childManager.close();
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    // Seal + close BEFORE unlinking: seal fences queued tail rewrites so no
    // deferred publish resurrects the journal after the unlink, and close
    // releases this host's lease on the target.
    sessionManager.seal();
    await sessionManager.close();
    unlinkSync(filePath);
    return { reparented, refusedForeign };
  }

  function queuedMessageText(message: unknown): string {
    if (typeof message === "string") return message;
    const text = message !== null && typeof message === "object" && "text" in message
      ? message.text
      : undefined;
    return String(text ?? "");
  }

  async function executeSlashCommand(message: string): Promise<object> {
    const output: string[] = [];
    const result: AcpBuiltinSlashCommandResult = await executeAcpBuiltinSlashCommand(message, {
      session: session as never,
      sessionManager,
      settings,
      cwd,
      output: (text) => {
        output.push(text);
      },
      refreshCommands: () => {},
      reloadPlugins: async () => {
        await extensionsReady;
        options.getDecoration()?.clearDecoration();
        await session.reload();
        await session.refreshSkills();
        applyForcedEmptySystemPrompt();
      },
    });
    if (result === false) return { handled: false, output };
    return {
      handled: true,
      output,
      ...("prompt" in result ? { prompt: result.prompt } : {}),
    };
  }

  async function executeBashCommand(command: WireCommand): Promise<object | null> {
    if (session.isStreaming || session.isCompacting || session.isBashRunning || transport.hasOpenPrompt()) {
      throw new Error("Cannot run a shell command while the session is busy");
    }
    const running = session.executeBash(
      String(command.command ?? ""),
      undefined,
      { excludeFromContext: command.excludeFromContext as boolean | undefined },
    );
    // Bash has no wire lifecycle events: publish the running mirror at start
    // (the SDK installs its abort controller synchronously unless a user_bash
    // hook intercepts) and again when the command settles, so the discovery
    // sidecar's isRunning stays fresh during bash-only activity.
    emitSessionInfo();
    try {
      const result = await running;
      persistBashOnlySession();
      return result;
    } finally {
      emitSessionInfo();
    }
  }

  async function executeAutoName(): Promise<object> {
    const source = findFirstTitleSource(sessionManager.buildSessionContext().messages)
      ?? findFirstUserMessage(session.agent.state.messages);
    if (!source) return { title: null, skipped: true };
    let title: string | undefined;
    try {
      title = (await generateSessionTitle(webSession, source))?.title;
    } catch (error) {
      console.error("[pi-web] manual title generation failed:", errorMessage(error));
    }
    title ||= fallbackTitle(source);
    if (!title) return { title: null, skipped: true };
    const written = await sessionManager.setSessionName(title, "user");
    if (!written) {
      // A source-"user" write is only refused when the session was released
      // (or the cleaned title came back empty) — same 409 wording the old
      // auto-name route returned, so the web route can map it unchanged.
      throw new Error("The session was closed while its title was being generated. Please try again.");
    }
    transport.emitHostFrame({ type: "session_renamed", title, sessionId: session.sessionId });
    emitSessionInfo();
    return { title };
  }

  async function getSubagentMessages(command: WireCommand): Promise<object> {
    const subagentId = typeof command.subagentId === "string" ? command.subagentId : undefined;
    const sessionFile = typeof command.sessionFile === "string" ? command.sessionFile : undefined;
    const fromByte = typeof command.fromByte === "number" ? command.fromByte : undefined;
    if (fromByte !== undefined && !Number.isFinite(fromByte)) {
      throw new Error("fromByte must be a finite number");
    }
    let transcriptFile: string;
    try {
      transcriptFile = subagents.resolveSessionFile({ subagentId, sessionFile });
    } catch (error) {
      // Terminal subagents evicted from the live registry keep their file in
      // the bounded history snapshot (old wrapper parity).
      const remembered = subagentId ? subagentHistory.get(subagentId)?.sessionFile : undefined;
      const fallback = remembered ?? sessionFile;
      if (!fallback) throw error;
      transcriptFile = fallback;
    }
    return readRpcSubagentTranscript(transcriptFile, fromByte);
  }

  // -------------------------------------------------------------------------
  // Inbound routing.
  // -------------------------------------------------------------------------

  function handleInboundFrame(frame: unknown): void {
    if (disposed || !frame || typeof frame !== "object" || !("type" in frame)) return;
    if (typeof frame.type !== "string") return;
    // Boundary: the transport already parsed NDJSON; commands are wire-shaped
    // objects with a discriminant `type` and optional `id`.
    const command = frame as WireCommand;
    const type = command.type;
    const id = command.id;

    // Host-owned wire commands never reach the SDK.
    if (type === "extension_ui_response") {
      const response = frame as unknown as ExtensionUiResponse;
      const resolved = options.getDecoration()?.resolveResponse(response.id, response) ?? false;
      if (!resolved) transport.forwardToSdk(frame);
      return;
    }
    if (type === "extension_ui_input") {
      options.getDecoration()?.handleInput(command.id ?? "", command.data);
      return;
    }
    if (type === "shutdown") {
      options.getDecoration()?.cancelAllPending();
      respondSuccess(id, "shutdown");
      onShutdown();
      return;
    }

    void (async () => {
      try {
        if (EXTENSION_GATED_TYPES[type] && !extensionsBound) await extensionsReady;
        if (type === "prompt" || type === "steer" || type === "follow_up") {
          syncPlanModeFromSession();
          const imageError = validateAgentImages(command.images);
          if (imageError) throw new Error(imageError);
        }

        switch (type) {
          case "prompt": {
            if (session.isBashRunning) {
              throw new Error("Cannot send a prompt while a shell command is running");
            }
            if (typeof id === "string") {
              promptMeta.set(id, {
                message: String(command.message ?? ""),
                ...(typeof command.streamingBehavior === "string" ? { streamingBehavior: command.streamingBehavior } : {}),
                ...(typeof command.promptId === "string" && command.promptId ? { promptId: command.promptId } : {}),
              });
            }
            transport.forwardToSdk(frame);
            return;
          }
          case "abort_and_prompt": {
            if (typeof id === "string") {
              promptMeta.set(id, {
                message: String(command.message ?? ""),
                ...(typeof command.promptId === "string" && command.promptId ? { promptId: command.promptId } : {}),
              });
            }
            transport.forwardToSdk(frame);
            return;
          }
          case "steer":
          case "follow_up":
            transport.forwardToSdk(frame);
            return;

          case "get_history_anchor":
            // #99: fresh atomic boundary for EACH browser subscription.
            // Host-owned control: durable flush + seq snapshot synchronously,
            // never forwarded to the SDK, never a historical dump.
            respondSuccess(id, type, captureJournalBoundary(sessionManager, () => transport.currentSeq()));
            return;
          case "get_state":
            respondSuccess(id, type, buildWebState());
            return;
          case "get_subagents":
            respondSuccess(id, type, { subagents: getSubagentSnapshots() });
            return;
          case "get_subagent_messages":
            runHostCommand(id, type, () => getSubagentMessages(command));
            return;

          case "set_model": {
            const provider = String(command.provider ?? "");
            const modelId = String(command.modelId ?? "");
            const role = typeof command.role === "string" ? command.role : undefined;
            const selector = `${provider}/${modelId}`;
            let model = session.modelRegistry.find(provider, modelId);
            if (!model) {
              await session.modelRegistry.refresh("offline");
              model = session.modelRegistry.find(provider, modelId);
            }
            if (!model) throw new Error(`Model not found: ${selector}`);
            // omp records the role a model change came from, so the transcript
            // and the `/model` carousel agree on which role is currently driving.
            await session.setModel(model, role);
            respondSuccess(id, type, { id: model.id, provider: model.provider, ...(role ? { role } : {}) });
            return;
          }
          case "set_role_model": {
            const role = String(command.role ?? "");
            const model = session.resolveRoleModel(role);
            if (!model) throw new Error(`No model configured for role "${role}"`);
            await session.setModel(model, role);
            respondSuccess(id, type, { id: model.id, provider: model.provider, role });
            return;
          }

          case "fork": {
            const result = await executeFork(String(command.entryId ?? ""));
            respondSuccess(id, type, result);
            // The browser opens the forked session as a new conversation; this
            // host's session is finished (old wrapper shut down here too).
            if (!result.cancelled) onShutdown();
            return;
          }
          case "navigate_tree": {
            if (session.isBashRunning) {
              throw new Error("Cannot navigate while a shell command is running");
            }
            const result = await session.navigateTree(String(command.targetId ?? ""), {});
            respondSuccess(id, type, { cancelled: result.cancelled });
            return;
          }
          case "set_thinking_level": {
            const level = String(command.level ?? "");
            if (!CONFIGURED_THINKING_LEVELS[level]) {
              throw new Error(`Unknown thinking level: ${level}`);
            }
            session.setThinkingLevel(level as ConfiguredThinkingLevel);
            // setThinkingLevel clamps xhigh→high for models where
            // supportsXhigh()===false. If the model has DeepSeek thinking compat
            // (reasoningEffortMap maps xhigh→max), force the state back so the
            // compat layer can use it correctly. SDK 18.10.4 removed "deepseek"
            // from the OpenAIReasoningFormat union, but models.yml compat is
            // user-supplied JSON — read it through a boundary view so a legacy
            // dialect still triggers the force (old wrapper behavior verbatim).
            const compat = session.model?.compat as { thinkingFormat?: string } | undefined;
            if (level === "xhigh" && compat?.thinkingFormat === "deepseek" && session.agent.state) {
              session.agent.state.thinkingLevel = ThinkingLevel.XHigh;
            }
            respondSuccess(id, type);
            return;
          }
          case "set_plan_mode": {
            // Rehydrate first: on a restarted host the live SDK state is empty
            // even when the journal still says plan mode, and the toggle must
            // land on the persisted mode rather than a stale default.
            syncPlanModeFromSession();
            const planMode = applyWebPlanModeTransition(
              webPlanSession,
              command.enabled === true,
              (title) => handlePlanProposal(title),
              getOmpSetting<boolean>(settings, "plan.enabled"),
            );
            transport.emitHostFrame({
              type: "mode_change",
              mode: planMode.enabled ? "plan" : "none",
              ...(planMode.planFilePath ? { planFilePath: planMode.planFilePath } : {}),
            });
            respondSuccess(id, type, { planMode });
            return;
          }

          case "compact":
            runHostCommand(id, type, async () => {
              const pending = session.compact(command.customInstructions as string | undefined);
              // compact() installs its controller synchronously: isCompacting
              // is already true. Mirror start/end so the sidecar stays fresh.
              emitSessionInfo();
              try {
                return (await pending) ?? null;
              } finally {
                emitSessionInfo();
              }
            });
            return;
          case "set_session_name": {
            const name = typeof command.name === "string" ? command.name.trim() : "";
            if (!name) throw new Error("Session name cannot be empty");
            await sessionManager.setSessionName(name, "user");
            respondSuccess(id, type);
            emitSessionInfo();
            return;
          }
          case "get_session_stats":
            respondSuccess(id, type, {
              ...session.getSessionStats(),
              sessionName: sessionManager.getSessionName(),
            });
            return;
          case "clear_queue": {
            // Full clear only: omp has no single-item dequeue, and clear+requeue
            // races against the agent loop pulling messages mid-flight.
            const cleared = session.clearQueue();
            respondSuccess(id, type, {
              steering: cleared.steering.map(queuedMessageText),
              followUp: cleared.followUp.map(queuedMessageText),
            });
            return;
          }
          case "get_tools": {
            const active = new Set<string>(session.getActiveToolNames());
            respondSuccess(id, type, listTools(session).map((tool) => ({
              name: tool.name,
              description: tool.description,
              active: active.has(tool.name),
            })));
            return;
          }
          case "get_commands":
            runHostCommand(id, type, async () => ({ commands: await getAvailableSlashCommands(session) }));
            return;
          case "execute_slash_command":
            runHostCommand(id, type, () => executeSlashCommand(String(command.message ?? "")));
            return;
          case "set_tools": {
            const toolNames = Array.isArray(command.toolNames) ? command.toolNames.map(String) : [];
            forceEmptySystemPrompt = toolNames.length === 0;
            await session.setActiveToolsByName(withExtensionTools(session, toolNames));
            applyForcedEmptySystemPrompt();
            respondSuccess(id, type);
            return;
          }
          case "reload":
            runHostCommand(id, type, async () => {
              await extensionsReady;
              options.getDecoration()?.clearDecoration();
              await session.reload();
              await session.refreshSkills();
              applyForcedEmptySystemPrompt();
              return { success: true };
            });
            return;
          case "abort_compaction":
            session.abortCompaction();
            respondSuccess(id, type);
            return;
          case "bash":
            runHostCommand(id, type, () => executeBashCommand(command));
            return;
          case "auto_name":
            runHostCommand(id, type, executeAutoName);
            return;
          case "delete_session":
            // Backgrounded like other long host commands so shutdown/abort/
            // get_state can overtake the directory scan. Terminal: the
            // response lands BEFORE onShutdown (route contract).
            void (async () => {
              try {
                const data = await executeDeleteSession();
                respondSuccess(id, type, data);
                options.getDecoration()?.cancelAllPending();
                onShutdown();
              } catch (error) {
                respondError(id, type, errorMessage(error));
              }
            })();
            return;

          default:
            if (Object.hasOwn(SDK_COMMAND_TYPES, type)) {
              transport.forwardToSdk(frame);
            } else {
              respondError(id, type, `Unsupported command: ${type}`);
            }
            return;
        }
      } catch (error) {
        respondError(id, type, errorMessage(error));
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Outbound observation (tap on SDK output; host frames bypass the tap).
  // -------------------------------------------------------------------------

  function handleOutboundFrame(frame: unknown): void {
    if (disposed || !frame || typeof frame !== "object" || !("type" in frame)) return;
    const type = frame.type;
    if (typeof type !== "string") return;

    if (type === "available_commands_update") {
      // Emitted after runRpcMode's initializeExtensions — the host's
      // extensions-bound signal (contract §2 ordering).
      if (!extensionsBound) {
        extensionsBound = true;
        applyForcedEmptySystemPrompt();
        markExtensionsBound();
      }
      return;
    }

    // #99 active-partial tracking (small lifecycle frames only; the giant
    // accumulated message_update snapshots never reach this tap past the
    // bounded prefix). message_end settles the partial into the journal.
    if (type === "message_start" || type === "message_update") {
      const message = "message" in frame ? frame.message : undefined;
      if (typeof message === "object" && message !== null && "role" in message && message.role === "assistant") {
        activePartial = {
          message,
          ...("messageId" in frame && typeof frame.messageId === "string" ? { messageId: frame.messageId } : {}),
        };
      }
      return;
    }
    if (type === "message_end") {
      activePartial = undefined;
      return;
    }

    if (type === "subagent_lifecycle" || type === "subagent_progress") {
      rememberSubagentFrame(frame as { type: string; payload?: unknown });
      return;
    }

    if (type === "prompt_result") {
      const id = "id" in frame && typeof frame.id === "string" ? frame.id : undefined;
      const meta = id ? promptMeta.get(id) : undefined;
      if (id) promptMeta.delete(id);
      if (id && meta?.promptId) {
        // The SDK prompt_result cannot carry promptId. Emit a host-only
        // identity frame from the observation tap: ring-append + client
        // enqueue happen BEFORE the observed SDK bytes, so a wrapper that
        // reattached after a web restart settles the original submitter.
        transport.emitHostFrame({
          type: "host_prompt_identity",
          id,
          promptId: meta.promptId,
          ...(meta.streamingBehavior ? { streamingBehavior: meta.streamingBehavior } : {}),
        });
      }
      emitSessionInfo();
      return;
    }

    if (type === "agent_end" || type === "session_settled" || type === "session_renamed"
      || type === "auto_compaction_start" || type === "auto_compaction_end") {
      if (type === "agent_end" || type === "session_settled") activePartial = undefined;
      emitSessionInfo();
      return;
    }

    if (type === "response") {
      const response = frame as OutboundResponse;
      const promptId = (response.command === "prompt" || response.command === "abort_and_prompt")
        && typeof response.id === "string" ? response.id : undefined;
      if (promptId !== undefined) {
        if (response.success === true) {
          // Prompt admitted: surface the transient session in history now.
          emitSessionInfo();
          const meta = promptMeta.get(promptId);
          if (meta && !meta.streamingBehavior) {
            void maybeAutoGenerateTitle(meta.message);
          }
          // Local extension outcome (rpc-mode.ts:1875 agentInvoked:false) never
          // emits prompt_result — release the admission or the bash/idle guards
          // stay busy forever. Normal admissions carry no data; keep those open
          // until prompt_result (queued turns settle later).
          if (response.data !== null && typeof response.data === "object"
            && "agentInvoked" in response.data && response.data.agentInvoked === false) {
            transport.releasePrompt(promptId);
          }
        } else {
          // Admission error: the SDK discards the ticket, no prompt_result follows.
          transport.releasePrompt(promptId);
        }
      }
      return;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    subagents.dispose();
    subagentHistory.clear();
    promptMeta.clear();
  }

  return {
    handleInboundFrame,
    handleOutboundFrame,
    emitSessionInfo,
    hasLiveSubagents: () => subagents.getSubagents().length > 0,
    captureHistoryBoundary: () => captureJournalBoundary(sessionManager, () => transport.currentSeq()),
    pendingPromptIdentities: () => [...promptMeta.entries()]
      .filter((entry): entry is [string, PromptMeta & { promptId: string }] => typeof entry[1].promptId === "string" && entry[1].promptId.length > 0)
      .map(([id, meta]) => ({
        id,
        promptId: meta.promptId,
        ...(meta.streamingBehavior ? { streamingBehavior: meta.streamingBehavior } : {}),
      })),
    extensionsReady,
    dispose,
  };
}
