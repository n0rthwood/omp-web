// Frozen #104 outline shared types (browser-safe, builtin-free).
//
// The web UI imports these without pulling any server runtime: the only
// dependency is a TYPE-only import of JournalAnchor from the journal reader.

import type { JournalAnchor } from "./session-history";

export interface SessionOutlineEntry {
  entryId: string;
  role: "user" | "assistant" | "summary";
  /** Bounded deterministic plain text, incl tool names if no text. */
  preview: string;
  timestamp: string;
  /** Zero-based visible transcript MESSAGE position, NOT raw journal index. */
  ordinal: number;
}

export interface SessionOutline {
  anchor: JournalAnchor;
  leafId: string | null;
  entries: SessionOutlineEntry[];
}
