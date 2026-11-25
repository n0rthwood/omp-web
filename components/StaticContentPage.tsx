"use client";

/**
 * Standalone `/static` landing surface (issue #136). Outside AppShell, so it
 * provides its own I18n/Machine providers and renders the same aggregate
 * list as the Home Static content tab. Navigation back to the app uses full
 * page loads — this route is not part of the client navigation codec.
 */

import Link from "next/link";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { MachineProvider } from "@/lib/machine-context";
import { StaticContentList } from "./StaticContentList";

export function StaticContentPage() {
  return (
    <I18nProvider>
      <MachineProvider>
        <StaticContentPageBody />
      </MachineProvider>
    </I18nProvider>
  );
}

function StaticContentPageBody() {
  const { t } = useI18n();
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)",
      display: "flex", flexDirection: "column",
    }}>
      <header style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        padding: "14px 20px 10px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {t("staticContent.title")}
          </h1>
          <div style={{ flex: 1 }} />
          <Link
            href="/"
            style={{
              display: "inline-flex", alignItems: "center", height: 28, padding: "0 12px",
              borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-hover)",
              color: "var(--text-muted)", fontSize: 12.5, textDecoration: "none", flexShrink: 0,
            }}
          >
            {t("staticContent.backHome")}
          </Link>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-dim)" }}>
          {t("staticContent.aggregate.description")}
        </p>
      </header>
      <main style={{ flex: 1, overflowY: "auto", width: "100%", maxWidth: 1440, margin: "0 auto", padding: "16px 20px 60px" }}>
        <StaticContentList />
      </main>
    </div>
  );
}
