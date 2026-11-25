/**
 * Fuzzy matching for the model pickers: substring first, then subsequence.
 *
 * The allow-list search has to accept `q4m` for `qwen4-max-preview`, which a
 * plain `includes()` never will, while still ranking a real substring above an
 * incidental subsequence. Scores are only used for ordering, never displayed.
 */

export interface FuzzyMatch {
  hit: boolean;
  score: number;
  /** Character offsets to highlight, ascending. */
  indices: number[];
}

const NO_MATCH: FuzzyMatch = { hit: false, score: 0, indices: [] };

export function fuzzyMatch(candidate: string, query: string): FuzzyMatch {
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return { hit: true, score: 0, indices: [] };

  const at = haystack.indexOf(needle);
  if (at >= 0) {
    const indices: number[] = [];
    for (let i = at; i < at + needle.length; i += 1) indices.push(i);
    return { hit: true, score: 1000 - at, indices };
  }

  const indices: number[] = [];
  let cursor = 0;
  for (const char of needle) {
    while (cursor < haystack.length && haystack[cursor] !== char) cursor += 1;
    if (cursor >= haystack.length) return NO_MATCH;
    indices.push(cursor);
    cursor += 1;
  }
  return { hit: true, score: 100 - indices[0], indices };
}

export interface HighlightSegment {
  text: string;
  marked: boolean;
}

/** Split `text` into marked/unmarked runs for the offsets a match produced. */
export function highlightSegments(text: string, indices: readonly number[]): HighlightSegment[] {
  if (indices.length === 0) return [{ text, marked: false }];
  const marked = new Set(indices);
  const segments: HighlightSegment[] = [];
  let runStart = 0;
  let runMarked = marked.has(0);
  for (let i = 1; i <= text.length; i += 1) {
    const nextMarked = i < text.length ? marked.has(i) : !runMarked;
    if (nextMarked === runMarked) continue;
    segments.push({ text: text.slice(runStart, i), marked: runMarked });
    runStart = i;
    runMarked = nextMarked;
  }
  return segments;
}