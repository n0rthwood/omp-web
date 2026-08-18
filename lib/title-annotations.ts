/** Suffix grammar: `(` mains? (` · `)? related? `)` with at least one part present.
 *  mains: `#12` joined by " · " (bare). related: `rel #10` then ", #7" (prefixed). */
export interface TitleAnnotations { main: number[]; related: number[] }

export function parseTitleAnnotations(name: string): { text: string; annotations: TitleAnnotations | null } {
  const match = name.match(/\s+\(([^()]*)\)\s*$/);
  if (!match) return { text: name, annotations: null };
  const parts = match[1].split(" · ").filter((p) => p.length > 0);
  const main: number[] = [];
  const related: number[] = [];
  let seenRelated = false;
  for (const part of parts) {
    if (part.startsWith("rel ")) {
      seenRelated = true;
      for (const item of part.slice(4).split(",")) {
        const n = parseBareIssue(item.trim());
        if (n === null) return { text: name, annotations: null };
        related.push(n);
      }
    } else {
      if (seenRelated) return { text: name, annotations: null }; // related must be last
      const n = parseBareIssue(part);
      if (n === null) return { text: name, annotations: null };
      main.push(n);
    }
  }
  if (main.length === 0 && related.length === 0) return { text: name, annotations: null };
  return { text: name.slice(0, match.index).trimEnd(), annotations: { main, related } };
}

function parseBareIssue(value: string): number | null {
  const m = value.match(/^#(\d+)$/);
  return m ? Number(m[1]) : null;
}
