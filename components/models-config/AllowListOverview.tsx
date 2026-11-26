"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { modelSelector, type ModelOption } from "./types";

/**
 * Provider-grouped view of what the `enabledModels` allow-list hides (#147).
 *
 * The tab's search box is a pattern editor: it searches every model so a click
 * can add a pattern. This overview answers a different question — "which models
 * does the allow-list currently hide, per provider?" — so it has its own filter
 * box and never changes what the search box does.
 *
 * "Hidden" here is always the allow-list verdict (`ModelOption.hidden`, set by
 * `GET /api/models?all=1`). It has nothing to do with the per-browser
 * "hide this provider row" preference in `lib/hidden-providers.ts`.
 *
 * `buildAllowListOverview` is pure so the grouping, ordering and collapse rules
 * are testable without a DOM.
 */

/** A provider with more hidden models than this starts collapsed. */
export const COLLAPSE_THRESHOLD = 12;

export interface AllowListGroup {
  provider: string;
  /** Every hidden selector (`provider/modelId`) of this provider, sorted. */
  hidden: string[];
  /** The hidden selectors that survive the keyword, same order. */
  matches: string[];
  /** Models of this provider the allow-list admits. */
  visible: number;
  /** Every model of this provider in the listing. */
  total: number;
  collapsedByDefault: boolean;
}

export interface AllowListOverviewData {
  /** False when the listing carries no per-model verdict (older remote). */
  hasVerdicts: boolean;
  groups: AllowListGroup[];
  hiddenTotal: number;
  visibleTotal: number;
  total: number;
  /** Hidden selectors left after the keyword, summed over the groups. */
  matchedTotal: number;
}

const EMPTY: AllowListOverviewData = {
  hasVerdicts: false,
  groups: [],
  hiddenTotal: 0,
  visibleTotal: 0,
  total: 0,
  matchedTotal: 0,
};

export function buildAllowListOverview(models: readonly ModelOption[], keyword = ""): AllowListOverviewData {
  if (!models.some((model) => model.hidden !== undefined)) return EMPTY;

  const needle = keyword.trim().toLowerCase();
  const byProvider = new Map<string, { hidden: string[]; visible: number; total: number }>();
  for (const model of models) {
    const entry = byProvider.get(model.provider) ?? { hidden: [], visible: 0, total: 0 };
    entry.total += 1;
    if (model.hidden === true) entry.hidden.push(modelSelector(model.provider, model.id));
    else entry.visible += 1;
    byProvider.set(model.provider, entry);
  }

  const groups: AllowListGroup[] = [...byProvider.entries()].map(([provider, entry]) => {
    const hidden = entry.hidden.sort((a, b) => a.localeCompare(b));
    return {
      provider,
      hidden,
      matches: needle ? hidden.filter((selector) => selector.toLowerCase().includes(needle)) : hidden,
      visible: entry.visible,
      total: entry.total,
      collapsedByDefault: hidden.length > COLLAPSE_THRESHOLD,
    };
  });
  // Providers with hidden models first, most hidden first, then by name; the
  // providers with nothing hidden follow as compact rows, by name.
  groups.sort((a, b) => {
    const aHidden = a.hidden.length > 0;
    const bHidden = b.hidden.length > 0;
    if (aHidden !== bHidden) return aHidden ? -1 : 1;
    if (aHidden) return b.hidden.length - a.hidden.length || a.provider.localeCompare(b.provider);
    return a.provider.localeCompare(b.provider);
  });

  let hiddenTotal = 0;
  let visibleTotal = 0;
  let matchedTotal = 0;
  for (const group of groups) {
    hiddenTotal += group.hidden.length;
    visibleTotal += group.visible;
    matchedTotal += group.matches.length;
  }
  return { hasVerdicts: true, groups, hiddenTotal, visibleTotal, total: hiddenTotal + visibleTotal, matchedTotal };
}

export function AllowListOverview({ models }: { models: readonly ModelOption[] }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const data = useMemo(() => buildAllowListOverview(models, filter), [models, filter]);

  if (!data.hasVerdicts) return null;

  return (
    <section
      data-testid="allow-list-overview"
      aria-label={t("models.allowListOverviewTitle")}
      style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-elev, var(--bg-panel))", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 10px", padding: "9px 12px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("models.allowListOverviewTitle")}</span>
        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
          {t("models.allowListOverviewSummary", { total: data.total, hidden: data.hiddenTotal })}
        </span>
      </div>

      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("models.allowListOverviewFilterPlaceholder")}
          aria-label={t("models.allowListOverviewFilterLabel")}
          data-testid="allow-list-overview-filter"
          style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, padding: "7px 10px", fontSize: 12.5, color: "var(--text)", outline: "none", boxSizing: "border-box" }}
        />
      </div>

      {data.matchedTotal === 0 && filter.trim() && (
        <div style={{ padding: "10px 12px", color: "var(--text-dim)", fontSize: 12 }}>
          {t("models.allowListOverviewEmpty", { query: filter.trim() })}
        </div>
      )}

      {data.groups.map((group) => (
        <OverviewGroup key={group.provider} group={group} />
      ))}
    </section>
  );
}

/**
 * Whether a group lists its hidden ids. The collapse rule of `OverviewGroup`,
 * pure so the "shrank below the threshold" case is testable without a DOM (#147).
 *
 * A group that is not collapsed-by-default always lists its models: the toggle
 * only exists above the threshold, so a group that dropped to the threshold or
 * below must not stay stuck closed with no way to open it.
 */
export function overviewShowsIds(group: AllowListGroup, expanded: boolean): boolean {
  return group.matches.length > 0 && (!group.collapsedByDefault || expanded);
}

export function OverviewGroup({ group }: { group: AllowListGroup }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!group.collapsedByDefault);
  const nothingHidden = group.hidden.length === 0;

  return (
    <div
      data-testid="allow-list-overview-group"
      data-provider={group.provider}
      data-hidden={group.hidden.length}
      data-visible={group.visible}
      style={{ borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", padding: "6px 12px" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)" }}>{group.provider}</span>
        {nothingHidden ? (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("models.allowListOverviewVisible", { count: group.visible })}</span>
        ) : (
          <>
            <span style={{ fontSize: 11, color: "var(--warning, #e3b341)" }}>{t("models.allowListOverviewHidden", { count: group.hidden.length })}</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("models.allowListOverviewVisible", { count: group.visible })}</span>
            <span style={{ flex: 1 }} />
            {group.collapsedByDefault && (
              <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}
                data-testid="allow-list-overview-toggle"
                style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: 999, padding: "2px 9px", fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
                {expanded ? t("models.allowListOverviewCollapse") : t("models.allowListOverviewExpand", { count: group.hidden.length })}
              </button>
            )}
          </>
        )}
      </div>

      {!nothingHidden && overviewShowsIds(group, expanded) && (
        <ul style={{ margin: 0, padding: "0 12px 8px 12px", listStyle: "none" }}>
          {group.matches.map((selector) => (
            <li key={selector} data-testid="allow-list-overview-model"
              style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.7, overflowWrap: "anywhere" }}>
              {selector}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}