/**
 * Session host entry (issue #94, contract §§1–2). One Bun process per
 * conversation: creates the AgentSession with the OLD startRpcSession
 * preamble (ported verbatim from lib/rpc-manager.ts @ 822c1cf), then runs the
 * SDK's runRpcMode IN-PROCESS over a shell-owned UDS transport. No
 * `omp --mode rpc` child, no stdio pump — runRpcMode owns all business logic
 * (prompt correlation, settle watching, subagent registry, extension init,
 * ACP builtins, goal/btw/live); the shell owns lifecycle only.
 *
 * argv (HostStartOptions):
 *   --session-id <id>        browser session key (socket/unit name)
 *   --session-file <path>    journal path, "" for a new session
 *   --cwd <path>             required when --session-file is ""
 *   --tools <json>           JSON array of active tool names ([] = all off)
 *   --model <provider/id>    explicit initial model
 *   --thinking-level <lvl>   initial thinking level
 */
import { ThinkingLevel, type ThinkingLevel as ThinkingLevelValue } from "@oh-my-pi/pi-agent-core";
import {
  createAgentSession,
  discoverSessionExtensionPaths,
  FileSessionStorage,
  getAgentDir,
  initTheme,
  readSessionHeaderId,
  SessionManager,
  SessionMoveRefusedError,
  tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { discoverCustomToolPaths } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { realpathSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { resolveVisibleModels, selectInitialModelScope } from "../../lib/model-scope";
import { untrustedProjectSessionOptions } from "../../lib/project-trust";
import { readDefaultModelRole } from "../../lib/model-roles";
import { applyConversationRotation } from "../../lib/model-rotation";
import { getOmpSetting } from "../../lib/omp-setting-access";
import { getOmpRuntime, getSettingsForCwd } from "../../lib/omp-runtime";
import { persistExplicitStartupPreferences } from "../../lib/startup-preferences";
import { FOREIGN_LEASE_ERROR } from "../../lib/session-host-transport";
import { createSessionTransport, sessionSocketPath } from "./transport";
import { decorateWebUiContext, type WebUiDecoration } from "./ui-decoration";
import { createWebCompat, withExtensionTools } from "./web-compat";
import { startIdleReaper } from "./idle";
import { beginCrashMarker, restoreInterruptedWork } from "./restore";
import { bindPromptProfile } from "../../lib/prompt-store";
import { promptSessionOptions } from "../../lib/prompt-runtime";

// Grace for the SDK's stdin-EOF teardown (rpc-mode.ts:2682-2697) after the host
// closes its input controller. Bun can leave the SDK's stream reader parked after
// a mid-turn host_attach + detach of all clients, so EOF never reaches the input
// loop; past this grace the host disposes the session and exits itself.
const SHUTDOWN_EXIT_GRACE_MS = 2_000;

interface HostArgs {
  sessionId: string;
  sessionFile: string;
  cwd?: string;
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevelValue;
}

/** Startup flags carry agent thinking levels (no wire-only "auto"). */
function isThinkingLevel(value: string | undefined): value is ThinkingLevelValue {
  return value !== undefined && Object.values(ThinkingLevel).includes(value as ThinkingLevelValue);
}

function parseArgs(argv: string[]): HostArgs {
  const args: HostArgs = { sessionId: "", sessionFile: "" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--session-id":
        args.sessionId = value ?? "";
        i++;
        break;
      case "--session-file":
        args.sessionFile = value ?? "";
        i++;
        break;
      case "--cwd":
        args.cwd = value;
        i++;
        break;
      case "--tools": {
        const parsed: unknown = JSON.parse(value ?? "[]");
        if (!Array.isArray(parsed)) throw new Error("--tools must be a JSON array");
        args.toolNames = parsed.map(String);
        i++;
        break;
      }
      case "--model": {
        const selector = value ?? "";
        const slash = selector.indexOf("/");
        if (slash <= 0) throw new Error(`--model must be provider/modelId, got: ${selector}`);
        args.initialModel = { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
        i++;
        break;
      }
      case "--thinking-level":
        if (!isThinkingLevel(value)) {
          throw new Error(`Unknown thinking level: ${value ?? "(missing)"}`);
        }
        args.thinkingLevel = value;
        i++;
        break;
      default:
        throw new Error(`Unknown host argument: ${flag}`);
    }
  }
  if (!args.sessionId) throw new Error("--session-id is required");
  return args;
}

/**
 * omp-web owns the process-wide `AsyncJobManager`, and no AgentSession does
 * (port verbatim; one host process = one conversation here, but the singleton
 * keeps async deliveries routed by the session's distinct agentId).
 */
function ensureAsyncJobManager(maxRunningJobs: number): void {
  if (AsyncJobManager.instance()) return;
  const manager = new AsyncJobManager({ maxRunningJobs });
  AsyncJobManager.setInstance(manager);
  const cleanup = () => {
    if (AsyncJobManager.instance() === manager) AsyncJobManager.setInstance(undefined);
    void manager.dispose({ timeoutMs: 3_000 });
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

/** Stable, collision-free agent id for one browser conversation. */
function webAgentId(sessionId: string): string {
  return `web-${sessionId}`;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

const startingSessionCwds = new Map<string, number>();

function trackStartingSession(cwd: string): () => void {
  const key = normalizeRpcCwd(cwd);
  startingSessionCwds.set(key, (startingSessionCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingSessionCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingSessionCwds.set(key, remaining);
    else startingSessionCwds.delete(key);
  };
}

/**
 * File storage whose ownership claim throws instead of returning null. The
 * SDK treats a null claim as "open elsewhere" and forks to a sibling journal;
 * the host must refuse a foreign lease outright (contract §1) and keeps the
 * refcounted claim it wins for its whole lifetime. The claim always goes
 * through the manager, never a raw probe held across open (same-process
 * tryAcquire is non-reentrant, and a failed attempt releases the holder's
 * lock).
 */
class RefusingClaimStorage extends FileSessionStorage {
  override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
    const release = super.claimSession(sessionId, sessionPath);
    if (!release) {
      throw new SessionMoveRefusedError(FOREIGN_LEASE_ERROR);
    }
    return release;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Some extensions access the SDK's global theme even outside the terminal UI.
  await initTheme(false);
  const agentDir = getAgentDir();
  // Foreign-lease probe before first write (contract §5: "Host probes same way
  // before first write"). A live foreign holder (TUI/CLI, or another web
  // instance) means the journal stays readable but cannot be modified here —
  // refuse outright instead of letting the SDK silently fork to a sibling.
  // Probe-and-release: the raw OS lease is same-process NON-reentrant, so it
  // must NOT be held across open — the manager's own refcounted claimSession
  // re-acquires it on first write and holds it until dispose/exit.
  // RefusingClaimStorage turns any later null claim (mid-session takeover)
  // into a refusal rather than a fork.
  const storage = new RefusingClaimStorage();
  if (args.sessionFile) {
    const headerId = await readSessionHeaderId(args.sessionFile);
    if (headerId !== undefined) {
      const probe = tryAcquireSessionLease(headerId);
      if (!probe) {
        console.error(FOREIGN_LEASE_ERROR);
        process.exit(1);
      }
      probe.release();
    }
  }
  const sessionManager = args.sessionFile
    ? await SessionManager.open(args.sessionFile, undefined, storage)
    : (() => {
      if (!args.cwd) throw new Error("cwd is required for a new session");
      return SessionManager.create(args.cwd, undefined, storage);
    })();
  try {
    await sessionManager.ensureOnDisk();
  } catch (error) {
    if (error instanceof SessionMoveRefusedError) {
      console.error(FOREIGN_LEASE_ERROR);
      process.exit(1);
    }
    throw error;
  }
  // Defense in depth: a claim that fails LATER (mid-session takeover) makes
  // the SDK move to a sibling; refuse instead of silently continuing on a
  // forked journal. Notices replay to late subscribers, so a claim already
  // lost before this point is caught too.
  sessionManager.onPersistenceNotice(() => {
    console.error(FOREIGN_LEASE_ERROR);
    process.exit(1);
  });

  const sessionCwd = sessionManager.getCwd();
  const finishStartingSession = trackStartingSession(sessionCwd);

  try {
    const runtime = await getOmpRuntime();
    const sessionSettings = await getSettingsForCwd(sessionCwd);
    // Long-lived hosts apply on-disk config edits live (CLI precedent,
    // main.ts:2585-2590). No-op unless this is the persisting global instance.
    sessionSettings.startWatching();

    const { toolNames, initialModel, thinkingLevel } = args;

    // Determine which tools to pass based on requested toolNames.
    let toolsOption: string[] | undefined;
    if (toolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in omp-web sessions even though the
      // `omp` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = toolNames.length === 0 ? [] : undefined;
    }

    // Gate untrusted project code so opening a repository in a browser tab does
    // not run its `.omp/extensions`, `.omp/tools`, or `.mcp.json` servers (see
    // lib/project-trust.ts). Discovery still runs — only project-local entries
    // are dropped, so user-level extensions keep working.
    const [extensionPaths, customToolPaths] = await Promise.all([
      discoverSessionExtensionPaths({}, sessionCwd, sessionSettings),
      discoverCustomToolPaths([], sessionCwd),
    ]);
    const untrusted = untrustedProjectSessionOptions(sessionCwd, agentDir, { extensionPaths, customToolPaths });
    // Managed defaults bind once to a new conversation, not to each host incarnation.
    const promptProfile = await bindPromptProfile(sessionManager, sessionCwd, !args.sessionFile, agentDir);

    const { modelRegistry } = runtime;

    // Rotate this conversation's roles, then never again for its lifetime.
    //
    // Only on creation: a conversation reloaded after an idle teardown must
    // come back on the model it was already using, or a 10-minute gap would
    // silently switch models mid-conversation and throw away the provider's
    // prompt cache — the exact cost rotation exists to avoid. `default` is
    // skipped when the browser named a model, because an explicit pick must
    // win and must not burn a rotation slot.
    //
    // `getSettingsForCwd` hands back the SHARED process-wide Settings when the
    // cwd already matches, so the override has to go on a clone or it leaks
    // into every other conversation and into the TUI-facing config.
    let settings = sessionSettings;
    const hasExistingMessages = sessionManager.buildSessionContext().messages.length > 0;
    if (!hasExistingMessages) {
      const own = await sessionSettings.cloneForCwd(sessionCwd);
      const rotated = applyConversationRotation(own, agentDir, {
        skipRoles: initialModel ? ["default"] : [],
      });
      if (rotated.length > 0) {
        settings = own;
        console.log(`[omp-web] rotated models for new session: ${
          rotated.map((r) => `${r.role}=${r.primary} (${r.index + 1}/${r.poolSize})`).join(", ")
        }`);
      }
    }

    const scope = await resolveVisibleModels(modelRegistry, getOmpSetting(settings, "enabledModels"), settings);
    const defaultRole = readDefaultModelRole(settings);
    const initial = hasExistingMessages
      ? { scopedModels: [...scope.scopedModels], model: undefined, thinkingLevel: undefined }
      : selectInitialModelScope(scope, {
        ...(initialModel ? { requestedModel: initialModel } : {}),
        ...(defaultRole ? { defaultModel: defaultRole } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
    // Every browser conversation names itself. Two purposes: async job
    // deliveries are routed by agent id (an unnamed session would be
    // `MAIN_AGENT_ID` and would steal another conversation's results), and the
    // patched SDK only shares the process AsyncJobManager with a session that
    // supplies a distinct id. Derived from the session id, so a conversation
    // reloaded after an idle teardown keeps the same identity and any pending
    // delivery still reaches it.
    ensureAsyncJobManager(Math.min(100, Math.max(1, getOmpSetting<number | undefined>(settings, "async.maxJobs") ?? 100)));
    const { session, eventBus, subagentEventBus, setToolUIContext } = await createAgentSession({
      cwd: sessionCwd,
      agentDir,
      settings,
      sessionManager,
      modelRegistry,
      hasUI: true,
      agentId: webAgentId(sessionManager.getSessionId()),
      ...(initial.model ? { model: initial.model } : {}),
      ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
      ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
      ...(toolsOption !== undefined ? { toolNames: toolsOption, restrictToolNames: true } : {}),
      ...(untrusted ?? {}),
      ...promptSessionOptions(promptProfile, toolsOption !== undefined),
    });

    const persistedPreferences = await persistExplicitStartupPreferences(
      runtime.settings,
      {
        ...(initialModel ? { model: initialModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      },
      {
        ...(session.model
          ? { model: { provider: session.model.provider, modelId: session.model.id } }
          : {}),
        thinkingLevel: session.thinkingLevel ?? "off",
        supportsThinking: Boolean(session.model?.reasoning),
      },
    );
    // modelDefaultChanged cache invalidation stays web-side (contract §5):
    // the flag rides the next session_info mirror; the wrapper invalidates.

    // If specific tool names were requested (non-empty), set the active tools to the
    // requested builtin coding tools PLUS all extension/package tools, so installed
    // extensions stay usable in omp-web just like in the `omp` CLI.
    if (toolNames && toolNames.length > 0) {
      await session.setActiveToolsByName(withExtensionTools(session, toolNames));
    }

    // Thinking level: createAgentSession already applied initial.thinkingLevel
    // (clamped per model); the old wrapper's explicit setThinkingLevel added
    // nothing beyond that, so no second apply here.

    const transport = await createSessionTransport({
      sessionId: args.sessionId,
      helloSessionId: sessionManager.getSessionId(),
      sessionFile: sessionManager.getSessionFile() ?? "",
      cwd: sessionCwd,
      onFrame: (frame) => compat.handleInboundFrame(frame),
      onOutboundFrame: (frame) => compat.handleOutboundFrame(frame),
      onAttach: () => compat.emitSessionInfo(),
      onJournalAttach: () => {
        // #88 on the #99 journal-mode attach: ring replay no longer carries
        // host_prompt_identity, so re-emit identities of prompts still in
        // flight BEFORE capturing the boundary — they land inside the
        // handshake (seq ≤ boundary.seq), and a reattached wrapper settles
        // the original draft when the prompt_result lands. Legacy attach
        // replays them from the ring, so it needs no re-emission.
        for (const identity of compat.pendingPromptIdentities()) {
          transport.emitHostFrame({ type: "host_prompt_identity", ...identity });
        }
        return compat.captureHistoryBoundary();
      },
      onActivity: () => reaper.reset(),
      onInboundActivity: () => reaper.reset(),
    });

    // Close the input controller (contract §2 clean-shutdown trigger), then arm a
    // bounded exit: if the SDK's EOF teardown has not exited the process within the
    // grace (its reader can park in Bun after a mid-turn host_attach + detach), the
    // host disposes the session and exits itself. dispose() is idempotent, so this
    // is safe even if the SDK teardown later runs. The "exit" hook removes the
    // crash marker + socket.
    let shutdownExitTimer: Timer | undefined;
    const closeInputAndArmExit = (): void => {
      transport.closeInput();
      shutdownExitTimer ??= setTimeout(() => {
        void session.dispose().catch(() => { /* best-effort; exit regardless */ }).finally(() => process.exit(0));
      }, SHUTDOWN_EXIT_GRACE_MS);
    };

    let decoration: WebUiDecoration | undefined;
    const compat = createWebCompat({
      session,
      sessionManager,
      settings,
      promptProfile,
      cwd: sessionCwd,
      transport,
      getDecoration: () => decoration,
      eventBus,
      ...(subagentEventBus ? { subagentEventBus } : {}),
      ...(persistedPreferences.modelDefaultChanged ? { modelDefaultChanged: true } : {}),
      onShutdown: () => {
        reaper.stop();
        closeInputAndArmExit();
      },
    });

    const reaper = startIdleReaper({
      session,
      transport,
      hasLiveSubagents: () => compat.hasLiveSubagents(),
      onReap: () => {
        console.log(`[omp-web-host] idle reap: session ${sessionManager.getSessionId()}`);
        closeInputAndArmExit();
      },
    });

    // Crash marker AFTER the run dir exists (transport created it). A prior
    // marker means the previous host died mid-work ⇒ restore below.
    const priorUncleanExit = beginCrashMarker(args.sessionId);

    // runRpcMode reads process.stdout (rpc-mode.ts:1356, non-win32); install
    // the UDS adapter BEFORE calling so the SDK's ready frame lands on the wire.
    process.stdout = transport.stdoutAdapter as unknown as typeof process.stdout;

    void runRpcMode(session, {
      setToolUIContext: (ctx, hasUI) => {
        // The decorator wraps the real RpcExtensionUIContext (host dialogs
        // only); the SDK keeps using its own ctx — passing the decoration
        // itself would hide notify/select/confirm from the tool context.
        decoration = decorateWebUiContext(ctx, (frame) => transport.emitHostFrame(frame));
        setToolUIContext(ctx, hasUI);
      },
      headless: false,
      ...(subagentEventBus ? { subagentEventBus } : {}),
      input: transport.input,
    }).catch((e) => {
      console.error("[omp-web-host] runRpcMode rejected:", e instanceof Error ? e.message : e);
    });

    if (priorUncleanExit) {
      // AFTER runRpcMode is pumping so restored work's events forward.
      void restoreInterruptedWork(session, {
        eventBus,
        ...(subagentEventBus ? { subagentEventBus } : {}),
      }).catch((error) => {
        console.error("[omp-web-host] restore failed:", error instanceof Error ? error.message : error);
      });
    }

    process.once("exit", () => {
      reaper.stop();
      compat.dispose();
      // The SDK EOF teardown exits without awaiting transport.close(); remove
      // the socket here so a reaped host leaves no stale endpoint behind.
      try { unlinkSync(transport.socketPath); } catch { /* already gone */ }
      try { unlinkSync(join(dirname(transport.socketPath), `${transport.socketKey}.info`)); } catch { /* never written */ }
    });

    console.log(`[omp-web-host] session ${sessionManager.getSessionId()} listening on ${sessionSocketPath(args.sessionId)}`);
  } finally {
    finishStartingSession();
  }
}

// Init must not hang forever (SDK extension/MCP discovery can stall); the web
// side's connect retry is bounded, so a host that never binds should die
// loudly instead of squatting the unit.
const initDeadline = setTimeout(() => {
  console.error("[omp-web-host] fatal: session init exceeded 60s");
  process.exit(1);
}, 60_000);
initDeadline.unref();

void main().then(() => {
  clearTimeout(initDeadline);
}).catch((error) => {
  console.error("[omp-web-host] fatal:", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
