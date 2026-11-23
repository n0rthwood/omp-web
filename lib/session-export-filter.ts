// Out-of-band `type:"custom"` marker filter for omp session export HTML.
//
// Extracted from the export route because Next.js route files may only export
// route handlers — a shared pure helper must live in lib/.

const SESSION_DATA_SCRIPT_RE =
  /<script id="session-data" type="application\/json">([^<]*)<\/script>/;

/**
 * The omp CLI export embeds the raw journal (base64 JSON) in a session-data
 * script tag; the remote viewer renders out-of-band `type:"custom"` marker
 * entries (tool_execution_start, system-prompt-digest, omp-web:prompt-profile,
 * …) as empty rows. Drop ONLY those markers, keeping every rendered message
 * and metadata entry (message/custom_message/model_usage/title_change/…).
 * Custom markers sit IN the parentId chain, and the viewer's buildTree pushes
 * unknown-parent nodes as roots — so kept entries whose parent was dropped
 * are re-linked to the nearest surviving ancestor (null ⇒ root) first.
 * Any failure (missing tag, malformed base64/JSON, unexpected shape) returns
 * the original html unchanged — export must never fail because of the filter.
 */
export function stripCustomEntriesFromExportHtml(html: string): string {
  try {
    const match = SESSION_DATA_SCRIPT_RE.exec(html);
    if (!match) return html;
    const encoded = match[1].replace(/\s+/g, "");
    const decoded = Buffer.from(encoded, "base64");
    // Buffer.from silently skips invalid base64 characters; require a clean
    // round-trip (padding-insensitive) so malformed payloads fall back.
    const stripPad = (value: string) => value.replace(/=+$/, "");
    if (stripPad(decoded.toString("base64")) !== stripPad(encoded)) return html;
    const data: unknown = JSON.parse(decoded.toString("utf8"));
    if (!data || typeof data !== "object") return html;
    const entries = (data as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return html;
    const isCustom = (entry: unknown): boolean =>
      !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "custom";
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        if (typeof record.id === "string") byId.set(record.id, record);
      }
    }
    const droppedIds = new Set<string>();
    for (const [id, record] of byId) if (isCustom(record)) droppedIds.add(id);
    // Walk a dropped parent chain up to the nearest surviving ancestor.
    const resolveParent = (parentId: unknown): unknown => {
      const seen = new Set<string>();
      let current = parentId;
      while (typeof current === "string" && droppedIds.has(current)) {
        if (seen.has(current)) return null; // cycle guard
        seen.add(current);
        current = byId.get(current)?.parentId ?? null;
      }
      return current;
    };
    const kept = entries
      .filter((entry) => !isCustom(entry))
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        const parentId = record.parentId;
        if (typeof parentId === "string" && droppedIds.has(parentId)) {
          return { ...record, parentId: resolveParent(parentId) };
        }
        return entry;
      });
    if (kept.length === entries.length) return html;
    const patched: Record<string, unknown> = { ...(data as Record<string, unknown>), entries: kept };
    // The viewer navigates to data.leafId on boot (unknown id ⇒ blank
    // transcript); the journal leaf is frequently a custom marker, so remap
    // it through the same ancestor walk. subSessions carry their own
    // entries/leafId pairs and are left untouched.
    if (typeof patched.leafId === "string" && droppedIds.has(patched.leafId)) {
      patched.leafId = resolveParent(patched.leafId);
    }
    const reencoded = Buffer.from(JSON.stringify(patched), "utf8").toString("base64");
    return (
      html.slice(0, match.index) +
      `<script id="session-data" type="application/json">${reencoded}</script>` +
      html.slice(match.index + match[0].length)
    );
  } catch {
    return html;
  }
}