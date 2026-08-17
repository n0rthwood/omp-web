"use client";

/**
 * Generic access/availability notice (issue #10). Used by the navigation
 * pipeline's error stages, and adopted by every other inline
 * permission/availability message in the app (MachinesConfig's forbidden
 * state, SettingsConfig's admin-gated tabs, SessionSidebar's all-filtered
 * empty state) so there is exactly one themed shape for "you can't see
 * this, here's why, here's what to do".
 *
 * `no-permission` and `not-found` are kept visually distinct — machines
 * deliberately distinguish "doesn't exist" from "exists, not granted to
 * you" (issue #10 owner decision: machine-id existence is not a secret on
 * this fleet). `not-available` is the uniform copy for projects/sessions,
 * which never distinguishes hidden from nonexistent (issue #7).
 */

export type AccessNoticeVariant = "no-permission" | "not-found" | "not-available" | "offline";

export interface AccessNoticeAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface AccessNoticeProps {
  variant: AccessNoticeVariant;
  title: string;
  body: string;
  actions?: AccessNoticeAction[];
  /** Fills the viewport (navigation pipeline errors). False renders as a compact block for embedding inside an existing panel. */
  fullScreen?: boolean;
}

const ICON_BY_VARIANT: Record<AccessNoticeVariant, React.ReactElement> = {
  "no-permission": (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  "not-found": (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M9 11h4" />
    </svg>
  ),
  "not-available": (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  ),
  offline: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 12.5a10 10 0 0 1 3.5-2.4" />
      <path d="M19 12.5a10 10 0 0 0-5.5-3.4" />
      <path d="M12 20h.01" />
    </svg>
  ),
};

const ACCENT_BY_VARIANT: Record<AccessNoticeVariant, string> = {
  "no-permission": "var(--warning, #d69e2e)",
  "not-found": "var(--text-muted)",
  "not-available": "var(--text-muted)",
  offline: "var(--danger, #e53e3e)",
};

export function AccessNotice({ variant, title, body, actions, fullScreen = true }: AccessNoticeProps): React.ReactElement {
  const content = (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center",
      gap: 12, maxWidth: 380, padding: fullScreen ? 32 : 24,
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg-hover)", color: ACCENT_BY_VARIANT[variant],
      }}>
        {ICON_BY_VARIANT[variant]}
      </div>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text)" }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--text-muted)" }}>{body}</p>
      {actions && actions.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {actions.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              style={{
                padding: "8px 16px", borderRadius: 8, fontSize: 13, cursor: "pointer",
                fontFamily: "var(--font-mono)",
                border: action.primary ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: action.primary ? "var(--accent)" : "transparent",
                color: action.primary ? "var(--accent-contrast, #fff)" : "var(--text)",
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (!fullScreen) return content;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 500,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg)",
    }}>
      {content}
    </div>
  );
}
