/**
 * Crash-restore markers for the session host (issue #94, contract §1). Each
 * host writes `<socketKey>.restore` under the run dir at startup and removes
 * it on clean exit. A marker still present at the NEXT start means the prior
 * process died mid-work, so the new host runs restoreSession AFTER runRpcMode
 * is pumping (events must forward). A fresh session (no prior marker) never
 * restores.
 */
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { hostsRunDir } from "./transport";

function markerPath(socketKey: string): string {
  return join(hostsRunDir(), `${socketKey}.restore`);
}

/**
 * Install this host's crash marker. Returns whether a PRIOR marker existed
 * (unclean previous exit ⇒ restore). Call after the run dir exists.
 */
export function beginCrashMarker(socketKey: string): boolean {
  const path = markerPath(socketKey);
  const priorUnclean = existsSync(path);
  writeFileSync(path, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  process.once("exit", () => {
    // Clean exit (including the SDK EOF path's process.exit(0)) removes the
    // marker; a crash leaves it for the next host.
    try {
      unlinkSync(path);
    } catch {
      // Already gone (concurrent teardown) — nothing to restore next time.
    }
  });
  return priorUnclean;
}

export interface HostRestoreOptions {
  eventBus: EventBus;
  subagentEventBus?: EventBus;
}

/**
 * Resume the interrupted turn + subagents of a session whose prior host died.
 * MUST be called after `void runRpcMode(...)` so restored work's events reach
 * attached clients.
 */
export async function restoreInterruptedWork(
  session: AgentSession,
  options: HostRestoreOptions,
): Promise<{ turn: boolean; subagents: string[] }> {
  return restoreSession(session, {
    eventBus: options.eventBus,
    ...(options.subagentEventBus ? { subagentEventBus: options.subagentEventBus } : {}),
  });
}
