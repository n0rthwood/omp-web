"use client";

/**
 * Provider status strip (issue #134): one compact row at the sidebar bottom
 * showing each configured provider's brand icon, quota status dot and headline
 * numbers. Hover for all windows + reset times + last fetch + errors; click
 * opens the Models settings modal. Polls GET /api/provider-status every ~60s
 * through apiPath(), so a remote machine view shows that machine's snapshot
 * via the gateway proxy. Sized to wrap in table mode and collapse to dots in
 * the 92px strip mode (lib/panel-layout.ts SIDEBAR_STRIP_WIDTH).
 */

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiPath } from "@/lib/api-path";
import type {
  ProviderStatusEntry,
  ProviderStatusSnapshot,
  ProviderStatusWindow,
} from "@/lib/provider-status";
import AnthropicIcon from "@lobehub/icons/es/Anthropic/components/Mono";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenRouterIcon from "@lobehub/icons/es/OpenRouter/components/Mono";
import ZhipuColorIcon from "@lobehub/icons/es/Zhipu/components/Color";
import QwenColorIcon from "@lobehub/icons/es/Qwen/components/Color";
import ZAIIcon from "@lobehub/icons/es/ZAI/components/Mono";

type IconComponent = React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>;

// Same brand-icon precedent as ModelsConfig.tsx; Mono icons inherit text color.
const BRAND_ICONS: Record<string, { Icon: IconComponent; hasColor: boolean }> = {
  "anthropic": { Icon: AnthropicIcon, hasColor: false },
  "openai-codex": { Icon: OpenAIIcon, hasColor: false },
  "openrouter": { Icon: OpenRouterIcon, hasColor: false },
  "zhipu-coding-plan": { Icon: ZhipuColorIcon, hasColor: true },
  "alibaba-coding-plan": { Icon: QwenColorIcon, hasColor: true },
  "alibaba-token-plan": { Icon: QwenColorIcon, hasColor: true },
  "zai": { Icon: ZAIIcon, hasColor: false },
};

const POLL_INTERVAL_MS = 60_000;

function statusColor(status: ProviderStatusEntry["status"]): string {
  if (status === "exhausted" || status === "error") return "var(--danger)";
  if (status === "warning") return "var(--warning)";
  if (status === "absent") return "var(--text-dim)";
  return "var(--success)";
}

/** Headline numbers per provider kind; full detail lives in the tooltip. */
function headline(entry: ProviderStatusEntry, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (entry.kind === "openrouter") {
    const window = entry.windows[0];
    if (!window || window.used === undefined || window.limit === undefined) return null;
    return t("providerStatus.openrouterHeadline", { keys: entry.keyCount ?? 0, used: window.used, limit: window.limit });
  }
  if (entry.id === "anthropic") {
    const overall = entry.windows.find((w) => w.id === "anthropic:7d");
    const parts: string[] = [];
    if (overall?.usedPercent !== undefined) parts.push(`${overall.usedPercent}%`);
    for (const window of entry.windows) {
      if (!window.id.startsWith("anthropic:7d:") || window.usedPercent === undefined) continue;
      parts.push(t("providerStatus.modelWindow", { model: window.id.slice("anthropic:7d:".length), percent: window.usedPercent }));
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  if (entry.id === "openai-codex") {
    const primary = entry.windows.find((w) => w.id === "openai-codex:primary");
    return primary?.usedPercent !== undefined ? `${primary.usedPercent}%` : null;
  }
  // Other usage-capable providers (zai, alibaba-token-plan, …): worst window %.
  const percents = entry.windows.map((w) => w.usedPercent).filter((p): p is number => p !== undefined);
  return percents.length > 0 ? `${Math.max(...percents)}%` : null;
}

function formatResetTime(resetsAt: number): string {
  return new Date(resetsAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function windowLine(window: ProviderStatusWindow, t: (key: string, params?: Record<string, string | number>) => string): string {
  let amount: string;
  if (window.usedPercent !== undefined) amount = `${window.usedPercent}%`;
  else if (window.used !== undefined && window.limit !== undefined) amount = `${window.used}/${window.limit}`;
  else if (window.used !== undefined) amount = String(window.used);
  else amount = "—";
  const reset = window.resetsAt !== undefined
    ? ` · ${t("providerStatus.resetsAt", { time: formatResetTime(window.resetsAt) })}`
    : "";
  return `${window.label}: ${amount}${reset}`;
}

function tooltipText(
  entry: ProviderStatusEntry,
  fetchedAt: number | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const lines = [entry.displayName];
  for (const window of entry.windows) lines.push(windowLine(window, t));
  if (entry.kind === "openrouter" && entry.keys && entry.keys.length > 0) {
    lines.push(t("providerStatus.accounts", { count: entry.accountCount ?? 0 }));
    for (const key of entry.keys) {
      const label = key.label ?? t("providerStatus.unnamedKey");
      const quota = key.used !== undefined && key.limit !== undefined ? ` ${key.used}/${key.limit}` : "";
      const error = key.error ? ` (${key.error})` : "";
      lines.push(`· ${label}${quota}${error}`);
    }
  }
  if (entry.error) lines.push(t("providerStatus.errorLine", { error: entry.error }));
  if (entry.status === "absent") lines.push(t("providerStatus.absent"));
  lines.push(
    fetchedAt !== null
      ? t("providerStatus.lastFetch", { time: formatResetTime(fetchedAt) })
      : t("providerStatus.pending"),
  );
  return lines.join("\n");
}

export function ProviderStatusStrip({ onOpenModels }: { onOpenModels: () => void }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ProviderStatusSnapshot | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: NodeJS.Timeout | undefined;
    let controller: AbortController | undefined;

    async function poll() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(apiPath("/api/provider-status"), { signal: controller.signal });
        if (response.ok && mountedRef.current) {
          setSnapshot((await response.json()) as ProviderStatusSnapshot);
        }
      } catch {
        // Transient network failure: keep the last snapshot, retry next tick.
      }
      if (mountedRef.current) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
    void poll();

    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  const providers = snapshot?.providers ?? [];
  if (providers.length === 0) return null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("providerStatus.title")}
      onClick={onOpenModels}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenModels();
        }
      }}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: "4px 10px",
        padding: "4px 0",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--text-muted)",
        userSelect: "none",
      }}
    >
      {providers.map((entry) => {
        const brand = BRAND_ICONS[entry.id];
        const text = headline(entry, t);
        const color = statusColor(entry.status);
        return (
          <span
            key={entry.id}
            title={tooltipText(entry, snapshot?.fetchedAt ?? null, t)}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%", overflow: "hidden" }}
          >
            {brand ? (
              <brand.Icon size={12} style={brand.hasColor ? undefined : { color: "var(--text-muted)", flexShrink: 0 }} />
            ) : (
              <span style={{ flexShrink: 0 }}>{entry.displayName}</span>
            )}
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                boxShadow: `0 0 0 2px color-mix(in srgb, ${color} 15%, transparent)`,
              }}
            />
            {text !== null && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
