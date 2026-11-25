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
  /** #135: aggregate lifecycle badge for async rows (spawn + delivery). */
  jobStatus?: OutlineJobStatus;
  /** #135: per-job breakdown for multi-task spawn rows / batch deliveries. */
  jobs?: OutlineJobInfo[];
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

/** #135: merge live subagent snapshot statuses into outline rows without a
 * reload. Precedence: live snapshot > async-result delivery > spawn receipt.
 * Pure: returns the input array untouched when nothing changed. */
export function applyLiveOutlineJobStatus(
  entries: SessionOutlineEntry[],
  live: ReadonlyMap<string, OutlineJobStatus>,
): SessionOutlineEntry[] {
  if (live.size === 0) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.role !== "subagent" || !entry.jobs || entry.jobs.length === 0) return entry;
    let jobsChanged = false;
    const jobs = entry.jobs.map((job) => {
      const status = live.get(job.id);
      if (status === undefined || status === job.status) return job;
      jobsChanged = true;
      return { ...job, status };
    });
    if (!jobsChanged) return entry;
    changed = true;
    return { ...entry, jobs, jobStatus: aggregateOutlineJobStatus(jobs) ?? entry.jobStatus };
  });
  return changed ? next : entries;
}
