// Frozen #104 outline shared types (browser-safe, builtin-free).
//
// The web UI imports these without pulling any server runtime: the only
// dependency is a TYPE-only import of JournalAnchor from the journal reader.

import type { JournalAnchor } from "./session-history";

export interface SessionOutlineEntry {
  entryId: string;
  /** #109 adds ask tool answers without changing existing message ordinals.
   * #121 adds subagent async-result deliveries as their own category. */
  role: "user" | "assistant" | "summary" | "ask" | "subagent";
  /** Bounded deterministic plain text, incl tool names if no text. */
  preview: string;
  timestamp: string;
  /** Zero-based visible transcript MESSAGE position, NOT raw journal index. */
  ordinal: number;
  /** #121: assistant entry whose preview is toolCall labels only (no text).
   * Presentation-layer grouping input; never set on other roles. */
  toolOnly?: boolean;
}

export interface SessionOutline {
  anchor: JournalAnchor;
  leafId: string | null;
  entries: SessionOutlineEntry[];
}
