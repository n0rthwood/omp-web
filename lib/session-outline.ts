// Frozen #104 outline shared types (browser-safe, builtin-free).
//
// The web UI imports these without pulling any server runtime: the only
// dependency is a TYPE-only import of JournalAnchor from the journal reader.

import type { JournalAnchor } from "./session-history";

/** #135: normalized async-job lifecycle status (cancelled folds into aborted). */
export type OutlineJobStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** #135: one job/subagent carried by an async outline row (bounded). */
export interface OutlineJobInfo {
  id: string;
  name: string;
  status: OutlineJobStatus;
}

export interface SessionOutlineEntry {
  entryId: string;
  /** #109 adds ask tool answers without changing existing message ordinals.
   * #121 adds subagent async-result deliveries as their own category.
   * #121b adds injected system context (eager-task-prelude reminders).
   * #135 adds tool/write/wait taxonomy rows, title_change rows, and lists
   * every injected custom_message as system. All new fields are optional so
   * a new gateway UI tolerates old remote payloads. */
  role: "user" | "assistant" | "summary" | "ask" | "subagent" | "system" | "tool" | "write" | "wait" | "title";
  /** Bounded deterministic plain text, incl tool names if no text. */
  preview: string;
  timestamp: string;
  /** Zero-based visible transcript MESSAGE position, NOT raw journal index.
   * title_change rows carry the ordinal of their jump anchor (they render no
   * transcript block themselves). */
  ordinal: number;
  /** #121: assistant entry whose preview is toolCall labels only (no text).
   * Presentation-layer grouping input; never set on other roles. */
  toolOnly?: boolean;
  /** #135: tool-call names for tool/write/wait rows (group glyph mix). */
  toolNames?: string[];
  /** #135: aggregate lifecycle badge for async rows (spawn + delivery);
   * aggregates the FULL job set at parse time, never the display cap. */
  jobStatus?: OutlineJobStatus;
  /** #135: per-job breakdown for multi-task spawn rows / batch deliveries
   * (display-capped). */
  jobs?: OutlineJobInfo[];
  /** #135: task toolCall ids on spawn rows — lets the client synthesize jobs
   * from live snapshots whose parentToolCallId matches, even before the
   * receipt lands (sync task calls only journal their result at completion). */
  taskCallIds?: string[];
  /** #135: title_change rows jump to the nearest FOLLOWING rendered entry
   * (falling back to the nearest preceding one when the rename is the last
   * record); absent when the transcript has no rendered entry at all. */
  anchorEntryId?: string;
}

export interface SessionOutline {
  anchor: JournalAnchor;
  leafId: string | null;
  entries: SessionOutlineEntry[];
}

/** #135: worst-status aggregate for a multi-job row. Severity order:
 * failed > aborted > running > pending > completed. Any failure or abort
 * surfaces on the row even while siblings still run; only an all-completed
 * run reads completed. */
const JOB_STATUS_SEVERITY: Record<OutlineJobStatus, number> = {
  completed: 0,
  pending: 1,
  running: 2,
  aborted: 3,
  failed: 4,
};

export function aggregateOutlineJobStatus(jobs: readonly OutlineJobInfo[]): OutlineJobStatus | undefined {
  if (jobs.length === 0) return undefined;
  let worst: OutlineJobStatus = "completed";
  for (const job of jobs) {
    if (JOB_STATUS_SEVERITY[job.status] > JOB_STATUS_SEVERITY[worst]) worst = job.status;
  }
  return worst;
}

/** #135: live subagent state for the outline merge (from SubagentSnapshot). */
export interface LiveOutlineJob {
  id: string;
  status: OutlineJobStatus;
  name?: string;
  parentToolCallId?: string;
}

/** Display bound mirrors the server's per-row job cap. */
const LIVE_JOB_DISPLAY_CAP = 16;

/** #135: merge live subagent snapshots into outline rows without a reload.
 * Precedence: live snapshot > async-result delivery > spawn receipt.
 * Spawn rows also SYNTHESIZE jobs from snapshots whose parentToolCallId
 * matches the row's task calls — covering receipt-less in-flight spawns and
 * recovering jobs beyond the display cap (aggregation stays uncapped).
 * Rows with no matching live state keep their durable parse-time status
 * (which aggregates the full, uncapped job set). Pure: returns the input
 * array untouched when nothing changed. */
export function applyLiveOutlineJobStatus(
  entries: SessionOutlineEntry[],
  live: readonly LiveOutlineJob[],
): SessionOutlineEntry[] {
  if (live.length === 0) return entries;
  const byId = new Map(live.map((job) => [job.id, job]));
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.role !== "subagent") return entry;
    const callIds = entry.taskCallIds && entry.taskCallIds.length > 0 ? new Set(entry.taskCallIds) : null;
    const matched = callIds ? live.filter((job) => job.parentToolCallId !== undefined && callIds.has(job.parentToolCallId)) : [];
    const jobs = entry.jobs ?? [];
    if (matched.length === 0 && !jobs.some((job) => byId.has(job.id))) return entry;
    // Upgrade known jobs; synthesize matched snapshots missing from the row.
    const merged: OutlineJobInfo[] = jobs.map((job) => {
      const state = byId.get(job.id);
      return state && state.status !== job.status ? { ...job, status: state.status } : job;
    });
    const known = new Set(merged.map((job) => job.id));
    for (const state of matched) {
      if (known.has(state.id)) continue;
      known.add(state.id);
      merged.push({ id: state.id, name: state.name ?? state.id, status: state.status });
    }
    // Aggregate over ALL merged jobs (uncapped); cap only the display list.
    const jobStatus = aggregateOutlineJobStatus(merged) ?? entry.jobStatus;
    const display = merged.length > LIVE_JOB_DISPLAY_CAP ? merged.slice(0, LIVE_JOB_DISPLAY_CAP) : merged;
    const jobsChanged = display.length !== jobs.length || display.some((job, index) => job !== jobs[index]);
    if (!jobsChanged && jobStatus === entry.jobStatus) return entry;
    changed = true;
    return { ...entry, jobs: display, jobStatus };
  });
  return changed ? next : entries;
}

/** #137: what a primary click on an outline row does. Async subagent rows
 * drill down (multi-job rows expand to their job list, single-job rows open
 * the detail directly); every other row — and async rows with no resolvable
 * job (bash/eval background deliveries) — keeps the plain transcript jump. */
export type OutlineDrillTarget =
  | { kind: "jump" }
  | { kind: "jobs" }
  | { kind: "detail"; jobId: string };

export function resolveOutlineDrillTarget(entry: SessionOutlineEntry): OutlineDrillTarget {
  if (entry.role !== "subagent") return { kind: "jump" };
  const jobs = entry.jobs ?? [];
  if (jobs.length > 1) return { kind: "jobs" };
  if (jobs.length === 1) return { kind: "detail", jobId: jobs[0].id };
  return { kind: "jump" };
}
