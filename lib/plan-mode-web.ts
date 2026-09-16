// Web Plan-mode transitions for omp-web (issue #68).
//
// The SDK's `/plan` slash command is TUI-only (`builtin-modes.ts` ships just
// `handleTui`), so `executeAcpBuiltinSlashCommand` leaves it unhandled and a
// naive web client would forward it to the model as a plain prompt. These
// helpers mirror the SDK ACP mode-change semantics (`acp-agent.ts
// #applyModeChange`) — set/clear `PlanModeState` plus the plan-proposal
// handler, and persist a `mode_change` entry so TUI↔Web session restore
// (`AgentSessionWrapper.syncPlanModeFromSession`) sees the same journal the
// TUI writes. The module stays dependency-free so the client can import the
// slash-command intent parser from the React hook.

/** Mirrors the ACP agent's default plan file (`DEFAULT_PLAN_FILE_URL`). */
export const WEB_DEFAULT_PLAN_FILE_URL = "local://PLAN.md";

export interface WebPlanModeSnapshot {
  enabled: boolean;
  planFilePath: string;
  workflow?: "parallel" | "sequential";
  reentry?: boolean;
}

/** Serializable mode state returned by `get_state`, `set_plan_mode`, and the
 *  session-detail endpoint. `available` reflects the `plan.enabled` setting. */
export interface WebPlanModeInfo {
  enabled: boolean;
  planFilePath?: string;
  available: boolean;
}

export type WebPlanProposalHandler = (title: string) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}>;

/** Structural slice of `AgentSessionLike` these helpers touch. */
export interface WebPlanModeSession {
  getPlanModeState?(): WebPlanModeSnapshot | undefined;
  setPlanModeState?(state: WebPlanModeSnapshot | undefined): void;
  setPlanProposalHandler?(handler: WebPlanProposalHandler | null): void;
  sessionManager: {
    appendModeChange(mode: string, data?: Record<string, unknown>): unknown;
  };
  // Minimal test doubles omit settings; the availability gate then falls
  // back to the schema default (plan.enabled: true).
  settings?: { get(path: "plan.enabled"): boolean };
}

export type ModeChangeEntryLike = {
  type?: string;
  mode?: string;
  data?: Record<string, unknown>;
};

/**
 * Reconstruct plan-mode state from a session's journal entries — the last
 * `mode_change` entry wins. This is the same contract the TUI persists
 * (`InteractiveMode.#enterPlanMode` appends `mode: "plan"` with the plan file
 * path), so a session planned in the TUI restores as plan mode in the web and
 * vice versa. A `plan` entry without a usable plan file path is ignored, since
 * plan-mode recovery needs the file to steer proposals.
 */
export function readPersistedPlanModeState(
  entries: readonly ModeChangeEntryLike[],
): WebPlanModeSnapshot | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "mode_change") continue;
    if (entry.mode === "plan") {
      const planFilePath = entry.data?.planFilePath;
      if (typeof planFilePath === "string" && planFilePath.length > 0) {
        return {
          enabled: true,
          planFilePath,
          workflow: entry.data?.workflow === "sequential" ? "sequential" : "parallel",
          reentry: true,
        };
      }
    }
    return undefined;
  }
  return undefined;
}

/** Observable plan-mode state, preferring live SDK state over the journal. */
export function webPlanModeInfo(session: WebPlanModeSession): WebPlanModeInfo {
  const available = session.settings?.get("plan.enabled") ?? true;
  const state = session.getPlanModeState?.();
  if (state?.enabled) {
    return { enabled: true, planFilePath: state.planFilePath, available };
  }
  return { enabled: false, available };
}

/** Same shape for sessions with no live wrapper (session-detail endpoint). */
export function planModeInfoFromEntries(
  entries: readonly ModeChangeEntryLike[],
): WebPlanModeInfo {
  const state = readPersistedPlanModeState(entries);
  return state?.enabled
    ? { enabled: true, planFilePath: state.planFilePath, available: true }
    : { enabled: false, available: true };
}

/**
 * Enter or exit plan mode with ACP semantics: entering sets `PlanModeState`
 * (default plan file, `reentry` when plan mode was active before) and installs
 * the proposal handler that consumes `xd://propose`; exiting clears both. Both
 * directions persist a `mode_change` entry so the mode survives wrapper
 * restarts and crosses the TUI↔Web boundary. The SDK enforces plan mode's
 * read-only guarantees for subsequent prompts from the state alone.
 */
export function applyWebPlanModeTransition(
  session: WebPlanModeSession,
  enabled: boolean,
  proposalHandler: WebPlanProposalHandler,
): WebPlanModeInfo {
  const available = session.settings?.get("plan.enabled") ?? true;
  if (enabled) {
    if (!available) {
      throw new Error("Plan mode is disabled. Enable it in settings (plan.enabled).");
    }
    const previous = session.getPlanModeState?.();
    const planFilePath = previous?.planFilePath ?? WEB_DEFAULT_PLAN_FILE_URL;
    session.setPlanModeState?.({
      enabled: true,
      planFilePath,
      workflow: previous?.workflow ?? "parallel",
      reentry: previous !== undefined,
    });
    // Mirror `InteractiveMode.#enterPlanMode`: without a standing proposal
    // handler, `xd://propose` dispatch falls through and plan mode has no
    // approval path.
    session.setPlanProposalHandler?.(proposalHandler);
    session.sessionManager.appendModeChange("plan", { planFilePath });
    return { enabled: true, planFilePath, available };
  }

  const previous = session.getPlanModeState?.();
  session.setPlanProposalHandler?.(null);
  session.setPlanModeState?.(undefined);
  if (previous?.enabled) {
    session.sessionManager.appendModeChange("none");
  }
  return { enabled: false, available };
}

/**
 * Client-side `/plan` parsing (TUI toggle semantics): when plan mode is off,
 * `/plan` enters it and any trailing prompt becomes the first planning turn;
 * when plan mode is on, `/plan` exits it. Returns `null` for any other input
 * so the caller keeps its normal slash/prompt handling. The returned intent is
 * executed through the same `set_plan_mode` path as the UI toggle — never as
 * a model prompt.
 */
export function planSlashCommandIntent(
  text: string,
  currentEnabled: boolean,
): { enabled: boolean; prompt?: string } | null {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match || match[1] !== "plan") return null;
  if (currentEnabled) return { enabled: false };
  const prompt = (match[2] ?? "").trim();
  return prompt ? { enabled: true, prompt } : { enabled: true };
}

/**
 * Translate a failed `set_plan_mode` transition into an actionable message.
 * A fleet remote still running omp-web ≤ 0.5.6 has no `set_plan_mode`
 * command and answers HTTP 500 "Unsupported command: set_plan_mode" (the
 * machine proxy passes status and body through unchanged); surfacing that
 * rawly is neither understandable nor actionable for the operator.
 */
export function planModeTransitionErrorMessage(rawMessage: string): string {
  if (/Unsupported command:\s*["']?set_plan_mode/i.test(rawMessage)) {
    return "Plan mode is not supported by this machine's omp-web — it rejected the mode-change command. Upgrade that machine's omp-web to 0.5.7 or newer, then retry.";
  }
  return rawMessage;
}

/**
 * Failure contract for the web `/plan` builtin (issue #68 follow-up): a
 * failed transition MUST return `error` so the composer keeps the unsent
 * text and dispatches nothing; only a successful transition clears the
 * input (optionally dispatching the trailing prompt as the first planning
 * turn). Encoded here so the regression test can pin the contract.
 */
export function planSlashCommandOutcome(
  intent: { enabled: boolean; prompt?: string },
  transitionError: string | null,
): { handled: true; error?: string; prompt?: string; message?: string } {
  if (transitionError !== null) {
    return { handled: true, error: transitionError };
  }
  return {
    handled: true,
    ...(intent.prompt ? { prompt: intent.prompt } : {}),
    message: intent.enabled ? "Plan mode enabled" : "Plan mode disabled",
  };
}
