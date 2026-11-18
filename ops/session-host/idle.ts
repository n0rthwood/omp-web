/**
 * Idle reaping for the session host (issue #94, contract §1). A settled host
 * exits so ~220MB/process does not accumulate per conversation; the next
 * message transparently re-spawns it. NEVER reaps active sessions: the SDK
 * settle predicate covers streaming turns, admitted submissions, queued
 * steering/follow-ups and pending async work (subagents, background bash);
 * the host additionally guards open prompts, live subagents and shell runs.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { isRpcSessionSettled } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { SessionTransport } from "./transport";

const DEFAULT_IDLE_MS = 10 * 60 * 1000;

export interface IdleReaperOptions {
  session: AgentSession;
  transport: SessionTransport;
  hasLiveSubagents: () => boolean;
  /** Reap action: close the shell-owned input → SDK EOF teardown → exit. */
  onReap: () => void;
  /** Test override; defaults to OMP_WEB_HOST_IDLE_MS or 10 minutes. */
  idleMs?: number;
}

export interface IdleReaper {
  reset(): void;
  stop(): void;
}

function resolveIdleMs(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  const raw = process.env.OMP_WEB_HOST_IDLE_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IDLE_MS;
}

export function startIdleReaper(options: IdleReaperOptions): IdleReaper {
  const idleMs = resolveIdleMs(options.idleMs);
  let timer: Timer | undefined;
  let stopped = false;

  function active(): boolean {
    return (
      !isRpcSessionSettled(options.session)
      || options.transport.hasOpenPrompt()
      || options.hasLiveSubagents()
      || options.session.isBashRunning
      || options.session.isCompacting
    );
  }

  function arm(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      if (active()) {
        // Activity resumed between arming and firing; keep watching.
        arm();
        return;
      }
      stopped = true;
      options.onReap();
    }, idleMs);
    // The reaper must not keep the process alive on its own; the SDK loop and
    // the UDS server do that while there is work.
    timer.unref?.();
  }

  function reset(): void {
    if (stopped) return;
    clearTimeout(timer);
    arm();
  }

  arm();

  return {
    reset,
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
