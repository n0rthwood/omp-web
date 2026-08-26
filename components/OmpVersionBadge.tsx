/**
 * Compact, non-interactive version readout for the sidebar's bottom corner
 * (issue #33 — replaces the old update-check banner/panel). Reads the
 * build-time env var directly; never fetches, never tries to correct a
 * stale value (issue #32 owns keeping NEXT_PUBLIC_APP_VERSION accurate).
 *
 * Sized for the collapsed strip mode (issue #22, `SIDEBAR_STRIP_WIDTH` =
 * 92px in lib/panel-layout.ts): single line, no padding of its own (the
 * caller's padded wrapper handles that), and clipped with an ellipsis
 * instead of wrapping so an unexpectedly long version string (e.g. a
 * prerelease suffix) can never grow the row or push the settings button.
 */
export function OmpVersionBadge() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  if (!version) return null;
  return (
    <div
      title={`v${version}`}
      style={{
        width: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--text-dim)",
        userSelect: "none",
      }}
    >
      v{version}
    </div>
  );
}
