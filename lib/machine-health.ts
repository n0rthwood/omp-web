/**
 * Shared vocabulary + pure decision logic for the aggregate machine-health
 * poll (issue #82).
 *
 * `GET /api/machines/health` (gateway-local, never proxied) answers one
 * `MachineHealthReport` per machine visible to the caller, and the switcher's
 * polling hook (`hooks/useMachineHealth.ts`) turns those reports into the
 * status dot. Pure module: no React, no fs, no network — the poll-interval
 * choice and the stale-response guard live here so they are testable without
 * a browser or a fleet.
 */

export type MachineHealthState = "online" | "offline" | "unauthorized";

/** One machine's verdict as returned by `GET /api/machines/health`. */
export interface MachineHealthReport {
  id: string;
  state: MachineHealthState;
  reason?: string;
}

/** The same verdict as a value in the switcher-side status map. */
export interface MachineHealthEntry {
  state: MachineHealthState;
  reason?: string;
}

/**
 * Status-map value the interval logic tolerates — a `MachineHealthEntry`,
 * plus the switcher's transient `"loading"` placeholder, which counts as
 * "no verdict yet" (fast cadence).
 */
export interface MachineHealthLike {
  state: "loading" | MachineHealthState;
  reason?: string;
}

/** Builds the id -> status map from one aggregate response. */
export function machineHealthMapFromReports(
  reports: readonly MachineHealthReport[],
): Record<string, MachineHealthEntry> {
  const map: Record<string, MachineHealthEntry> = {};
  for (const report of reports) {
    map[report.id] =
      report.reason === undefined ? { state: report.state } : { state: report.state, reason: report.reason };
  }
  return map;
}

/** Poll cadence while every machine is online. */
export const MACHINE_HEALTH_POLL_MS = 30_000;
/** Faster cadence while any machine is offline, unauthorized, or still unknown. */
export const MACHINE_HEALTH_DEGRADED_POLL_MS = 8_000;

/**
 * The delay to schedule after a poll: slow (30s) only when every visible
 * machine is currently online; fast (8s) as soon as one is offline,
 * unauthorized, or has no verdict yet (`health` has no entry for its id), so
 * a recovering machine's dot flips back without an F5.
 */
export function machineHealthPollIntervalMs(
  ids: readonly string[],
  health: Readonly<Record<string, MachineHealthLike>>,
): number {
  for (const id of ids) {
    const entry = health[id];
    if (!entry || entry.state !== "online") return MACHINE_HEALTH_DEGRADED_POLL_MS;
  }
  return MACHINE_HEALTH_POLL_MS;
}

/**
 * Apply-guard for one aggregate response: a response may only be applied
 * while it still owns the latest run AND its poller is still mounted. Every
 * poll bumps a monotonic run id before awaiting; an out-of-order or late
 * response from an earlier run is ignored so it can never overwrite a newer
 * verdict, and anything landing after unmount is dropped.
 */
export function shouldApplyMachineHealthResponse(
  responseRunId: number,
  latestRunId: number,
  disposed: boolean,
): boolean {
  if (disposed) return false;
  return responseRunId === latestRunId;
}
