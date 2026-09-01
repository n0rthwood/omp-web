import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { getKnownRoleIds } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { listRoleFallbackChains } from "./model-roles";

/**
 * Per-conversation model rotation.
 *
 * We hold quota with several providers for comparable models. Without rotation
 * every conversation starts on the same primary for a role, so one provider
 * absorbs all the load while the others idle until it fails.
 *
 * Naive per-request balancing is the wrong fix: switching model mid-conversation
 * throws away the provider-side prompt cache, and a cache miss on a long context
 * is both slow and expensive. So rotation happens **once, at conversation
 * start**, and the conversation then stays on its pick for life.
 *
 * The pool for a role is its primary model followed by its configured backups
 * (`retry.fallbackChains`, see lib/model-roles.ts). Conversation *n* takes entry
 * *k*; the rest of the pool, in rotation order, becomes that conversation's
 * failover chain — so an outage still moves the conversation on, and it moves to
 * a different entry than its neighbour would.
 *
 * Everything above `readRotationState` is pure so the rotation maths can be
 * tested without touching disk or omp's Settings.
 */

const ROTATION_FILE = "omp-web-model-rotation.json";

/** Opt-in flags and the per-role round-robin cursors. */
export interface ModelRotationState {
  /** Master switch. With this off no role rotates, whatever `roles` says. */
  enabled: boolean;
  /** Per-role opt-in. A role absent here does not rotate. */
  roles: Record<string, boolean>;
  /** Monotonic counter per role; the pool index is this modulo pool length. */
  cursors: Record<string, number>;
}

/** One role's rotated assignment for a single conversation. */
export interface RotatedRole {
  /** Pool entry this conversation runs on. */
  primary: string;
  /** Remaining pool entries in rotation order — this conversation's failover chain. */
  chain: string[];
  /** Index chosen within the pool, retained for display and tests. */
  index: number;
}

export const EMPTY_ROTATION_STATE: ModelRotationState = { enabled: false, roles: {}, cursors: {} };

/**
 * Ordered, de-duplicated candidate list for a role.
 *
 * Mirrors how omp itself narrows subagent model candidates
 * (`task/executor.ts` `resolveSubagentRetryFallbackCandidates`): entries whose
 * provider is disabled are dropped rather than rotated onto, because selecting
 * one would fail every request for that conversation.
 */
export function buildRolePool(
  primary: string | undefined,
  chain: readonly string[] | undefined,
  disabledProviders: readonly string[] = [],
): string[] {
  const disabled = new Set(disabledProviders);
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const entry of [primary, ...(chain ?? [])]) {
    const selector = entry?.trim();
    if (!selector || seen.has(selector)) continue;
    // A selector is `provider/modelId` with an optional `:thinkingLevel`.
    const provider = selector.slice(0, selector.indexOf("/"));
    if (provider && disabled.has(provider)) continue;
    seen.add(selector);
    pool.push(selector);
  }
  return pool;
}

/**
 * Pick this conversation's entry and rotate the remainder behind it.
 *
 * With pool `[A,B,C]` and cursor 1 the conversation runs `B` and fails over to
 * `[C,A]`. Wrapping keeps every pool member reachable as a backup, so rotating
 * never shrinks a conversation's failover depth.
 */
export function rotateRole(pool: readonly string[], cursor: number): RotatedRole | undefined {
  if (pool.length === 0) return undefined;
  // A negative or non-finite cursor must not produce a negative index.
  const safeCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  const index = ((safeCursor % pool.length) + pool.length) % pool.length;
  const primary = pool[index];
  if (primary === undefined) return undefined;
  const chain = [...pool.slice(index + 1), ...pool.slice(0, index)];
  return { primary, chain, index };
}

/** Whether a role should rotate under the current state. */
export function rotatesRole(state: ModelRotationState, role: string): boolean {
  return state.enabled && state.roles[role] === true;
}

function rotationFilePath(agentDir: string): string {
  return join(agentDir, ROTATION_FILE);
}

function coerceState(parsed: unknown): ModelRotationState {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...EMPTY_ROTATION_STATE };
  const source: Record<string, unknown> = { ...parsed };
  const roles: Record<string, boolean> = {};
  const rawRoles = source.roles;
  if (typeof rawRoles === "object" && rawRoles !== null && !Array.isArray(rawRoles)) {
    for (const [role, value] of Object.entries(rawRoles)) {
      if (typeof value === "boolean") roles[role] = value;
    }
  }
  const cursors: Record<string, number> = {};
  const rawCursors = source.cursors;
  if (typeof rawCursors === "object" && rawCursors !== null && !Array.isArray(rawCursors)) {
    for (const [role, value] of Object.entries(rawCursors)) {
      if (typeof value === "number" && Number.isFinite(value)) cursors[role] = Math.trunc(value);
    }
  }
  return { enabled: source.enabled === true, roles, cursors };
}

export function readRotationState(agentDir: string): ModelRotationState {
  try {
    return coerceState(JSON.parse(readFileSync(rotationFilePath(agentDir), "utf8")));
  } catch {
    // Absent or unreadable means "not configured", which is rotation off.
    return { ...EMPTY_ROTATION_STATE };
  }
}

export function writeRotationState(agentDir: string, state: ModelRotationState): void {
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(rotationFilePath(agentDir), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Consume one rotation slot for each named role and persist the advance.
 *
 * Read-modify-write is done synchronously so two conversations created in the
 * same tick cannot observe the same cursor: the event loop cannot interleave
 * between the read and the write. Two *processes* sharing an agent dir can still
 * land on the same entry, which costs a missed spread rather than correctness.
 */
export function advanceCursors(agentDir: string, roles: readonly string[]): Record<string, number> {
  const state = readRotationState(agentDir);
  const taken: Record<string, number> = {};
  for (const role of roles) {
    const current = state.cursors[role] ?? 0;
    taken[role] = current;
    state.cursors[role] = current + 1;
  }
  if (roles.length > 0) {
    try {
      writeRotationState(agentDir, state);
    } catch {
      // A cursor that fails to persist repeats an entry next time. That is a
      // worse spread, not a broken conversation, so never fail session start.
    }
  }
  return taken;
}

/** What rotation did for one conversation, for logging and the UI read-out. */
export interface AppliedRotation {
  role: string;
  primary: string;
  index: number;
  poolSize: number;
}

/**
 * Pin this conversation's rotating roles onto a Settings instance.
 *
 * MUST be handed a Settings the conversation owns. `getSettingsForCwd()` returns
 * the shared process-wide instance whenever the cwd already matches, and
 * overriding that would leak one conversation's rotation into every other
 * conversation and into the config surface the TUI reads.
 *
 * Writes through the runtime override layer, which is never persisted — the
 * same mechanism omp uses to give a single subagent its own model and failover
 * chain (`task/executor.ts` `installSubagentRetryFallbackChain`). `override`
 * replaces a key wholesale, so both records are rebuilt from the current
 * effective values rather than patched.
 *
 * Roles whose pool has fewer than two entries are skipped and consume no
 * rotation slot: there is nothing to rotate between, and burning a cursor there
 * would desynchronise the spread of the roles that can.
 */
export function applyConversationRotation(
  settings: Settings,
  agentDir: string,
  options: { skipRoles?: readonly string[] } = {},
): AppliedRotation[] {
  const state = readRotationState(agentDir);
  if (!state.enabled) return [];

  const skip = new Set(options.skipRoles ?? []);
  const disabledProviders = settings.get("disabledProviders") ?? [];
  const chains = listRoleFallbackChains(settings);
  const chainByRole: Record<string, string[]> = {};
  for (const entry of chains) chainByRole[entry.role] = entry.effective;

  const pools: Record<string, string[]> = {};
  for (const role of getKnownRoleIds(settings)) {
    if (skip.has(role) || !rotatesRole(state, role)) continue;
    const pool = buildRolePool(settings.getModelRole(role), chainByRole[role], disabledProviders);
    if (pool.length > 1) pools[role] = pool;
  }

  const roles = Object.keys(pools);
  if (roles.length === 0) return [];

  const cursors = advanceCursors(agentDir, roles);
  const modelRoles: Record<string, string> = {};
  for (const [role, selector] of Object.entries(settings.getModelRoles())) {
    if (typeof selector === "string" && selector) modelRoles[role] = selector;
  }
  const fallbackChains: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(settings.get("retry.fallbackChains") ?? {})) {
    if (Array.isArray(value)) fallbackChains[key] = [...value];
  }

  const applied: AppliedRotation[] = [];
  for (const role of roles) {
    const pool = pools[role];
    if (!pool) continue;
    const rotated = rotateRole(pool, cursors[role] ?? 0);
    if (!rotated) continue;
    modelRoles[role] = rotated.primary;
    fallbackChains[role] = rotated.chain;
    applied.push({ role, primary: rotated.primary, index: rotated.index, poolSize: pool.length });
  }

  settings.override("modelRoles", modelRoles);
  settings.override("retry.fallbackChains", fallbackChains);
  return applied;
}
