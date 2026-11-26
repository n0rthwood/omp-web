"use client";

/**
 * Provider status strip (issue #134; moved above the composer by #145): one
 * compact line with each configured provider's brand icon, quota status dot
 * and headline numbers, ending in the time those numbers were measured. Hover
 * a provider for every window, reset time, data time and error; click opens
 * the Models settings modal. The trailing warning icon (#147) carries the
 * `enabledModels` hidden-model counts and scope warnings that used to occupy a
 * banner row of their own.
 *
 * Presentational only: the shell owns the poll (hooks/useProviderStatus)
 * because ChatWindow is re-keyed per session, which would restart an in-strip
 * poll on every session switch. The line never wraps — headline text shrinks
 * with an ellipsis, and the mobile breakpoint drops it (app/globals.css) so
 * every provider keeps its icon + dot.
 */

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
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
import { HiddenModelsNotice, hiddenNoticeVisible } from "./HiddenModelsNotice";

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

const CODEX_WINDOW_PREFIX = "openai-codex:";

function statusColor(status: ProviderStatusEntry["status"]): string {
  if (status === "exhausted" || status === "error") return "var(--danger)";
  if (status === "warning") return "var(--warning)";
  if (status === "absent") return "var(--text-dim)";
  return "var(--success)";
}

function windowAmount(window: ProviderStatusWindow): string | null {
  if (window.usedPercent !== undefined) return `${window.usedPercent}%`;
  if (window.used !== undefined && window.limit !== undefined) return `${window.used}/${window.limit}`;
  if (window.used !== undefined) return String(window.used);
  return null;
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
    // Every metered window, not only `primary`: the weekly window and extra
    // meters (e.g. Spark) each gate requests on their own.
    const parts: string[] = [];
    for (const window of entry.windows) {
      const amount = windowAmount(window);
      if (amount === null) continue;
      // Compact window name: the SDK's window id ("5h", "7d"), else the last id segment.
      const tag = window.windowId ?? window.id.split(":").pop() ?? window.id;
      const meter = window.id.startsWith(CODEX_WINDOW_PREFIX) ? window.id.slice(CODEX_WINDOW_PREFIX.length) : "";
      // An extra meter (`openai-codex:<slug>:<key>`, e.g. Spark) is named by its slug.
      parts.push(`${meter.includes(":") ? `${meter.split(":")[0]} ` : ""}${tag} ${amount}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
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

function formatAge(time: number, now: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  return minutes < 60
    ? t("providerStatus.ageMinutes", { minutes })
    : t("providerStatus.ageHours", { hours: Math.round(minutes / 60) });
}

function windowLine(window: ProviderStatusWindow, t: (key: string, params?: Record<string, string | number>) => string): string {
  const reset = window.resetsAt !== undefined
    ? ` · ${t("providerStatus.resetsAt", { time: formatResetTime(window.resetsAt) })}`
    : "";
  return `${window.label}: ${windowAmount(window) ?? "—"}${reset}`;
}

function tooltipText(
  entry: ProviderStatusEntry,
  dataTime: number | null,
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
    dataTime !== null
      ? t("providerStatus.dataAt", { time: formatResetTime(dataTime) })
      : t("providerStatus.pending"),
  );
  return lines.join("\n");
}

export function ProviderStatusStrip({ snapshot, onOpenModels, onOpenAllowList, hiddenModelCount, hiddenByProvider, modelScopeWarnings, cwd }: {
  /** Latest poll snapshot; `null` or an empty provider list renders nothing. */
  snapshot: ProviderStatusSnapshot | null;
  onOpenModels: () => void;
  /** Opens Settings on Models → allow-list (#147); the warning icon's action. */
  onOpenAllowList: () => void;
  /** Models the `enabledModels` allow-list hides; `undefined` when no scope is in effect. */
  hiddenModelCount?: number;
  /** Per-provider split of `hiddenModelCount`, most hidden first. */
  hiddenByProvider?: { provider: string; hidden: number; visible: number }[];
  /** `enabledModels` patterns that matched nothing. */
  modelScopeWarnings?: string[];
  /** Session cwd; the icon's lazy id fetch is scoped to it. */
  cwd?: string | null;
}) {
  const { t } = useI18n();
  const providers = snapshot?.providers ?? [];
  // "Now" lives in state: reading the clock during render is impure, and the
  // 30s tick keeps the tooltip's relative age honest between two polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // A scope can hide models on a provider that has no credential row yet, so the
  // warning icon outlives an empty provider list.
  if (providers.length === 0 && !hiddenNoticeVisible(hiddenModelCount, modelScopeWarnings)) return null;

  const fetchedAt = snapshot?.fetchedAt ?? null;
  // A report-backed entry carries its own measurement time; everything else
  // was computed in the cycle. The label shows the oldest of them so it never
  // claims fresher numbers than the stalest one on the line.
  const measured = providers
    .map((entry) => entry.recordedAt ?? fetchedAt)
    .filter((time): time is number => time !== null);
  if (fetchedAt !== null) measured.push(fetchedAt);
  const dataTime = measured.length > 0 ? Math.min(...measured) : null;
  // Clock label: "HH:mm" while the data is from today, "MMM d HH:mm" once older.
  let dataTimeLabel: string | null = null;
  if (dataTime !== null) {
    const measuredOn = new Date(dataTime);
    const today = new Date(now);
    const sameDay = measuredOn.getFullYear() === today.getFullYear()
      && measuredOn.getMonth() === today.getMonth()
      && measuredOn.getDate() === today.getDate();
    dataTimeLabel = sameDay
      ? measuredOn.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : formatResetTime(dataTime);
  }

  const dataTimeTitle = dataTime === null ? undefined : [
    t("providerStatus.dataAt", { time: formatResetTime(dataTime) }),
    formatAge(dataTime, now, t),
    ...(snapshot?.nextPollAt ? [t("providerStatus.nextPoll", { time: formatResetTime(snapshot.nextPollAt) })] : []),
  ].join(" · ");

  return (
    <div
      data-testid="provider-status-strip"
      style={{
        display: "flex",
        flexWrap: "nowrap",
        alignItems: "center",
        gap: 12,
        height: 26,
        flexShrink: 0,
        minWidth: 0,
        overflow: "hidden",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: "var(--text-muted)",
        userSelect: "none",
      }}
    >
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
          alignItems: "center",
          gap: 12,
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        {providers.map((entry) => {
          const brand = BRAND_ICONS[entry.id];
          const text = headline(entry, t);
          const color = statusColor(entry.status);
          return (
            <span
              key={entry.id}
              title={tooltipText(entry, entry.recordedAt ?? fetchedAt, t)}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "0 1 auto", minWidth: 0 }}
            >
              {brand ? (
                <brand.Icon size={12} style={brand.hasColor ? undefined : { color: "var(--text-muted)", flexShrink: 0 }} />
              ) : (
                <span style={{ flexShrink: 0, maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis" }}>{entry.displayName}</span>
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
                <span className="provider-status-headline" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {text}
                </span>
              )}
            </span>
          );
        })}
        {dataTimeLabel !== null && (
          <span
            data-testid="provider-status-data-time"
            title={dataTimeTitle}
            style={{ flexShrink: 0, marginLeft: "auto", color: "var(--text-dim)" }}
          >
            {t("providerStatus.dataTime", { time: dataTimeLabel })}
          </span>
        )}
      </div>
      {/* The notice never shrinks and sits last, so the provider region above
          absorbs the squeeze and the icon stays visible at 390px. */}
      <HiddenModelsNotice
        hiddenModelCount={hiddenModelCount}
        hiddenByProvider={hiddenByProvider}
        warnings={modelScopeWarnings}
        cwd={cwd}
        names={Object.fromEntries(providers.map((entry) => [entry.id, entry.displayName]))}
        onOpenAllowList={onOpenAllowList}
      />
    </div>
  );
}
