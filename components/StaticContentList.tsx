"use client";

/**
 * Aggregate static-content discovery list (issue #136): every machine the
 * signed-in account can see contributes its `/api/static-mappings` response
 * through the existing machine proxy seam (`apiPath`). Project filtering and
 * legacy-row admin gating happen server-side per machine; a machine that
 * fails or is unreachable contributes zero rows and is surfaced only as a
 * compact per-machine notice. Rows are ordered by `createdAt`, newest first.
 * Shared by the `/static` landing page and the Home Static content tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useMachines } from "@/lib/machine-context";
import type { StaticMappingListResponse } from "@/lib/static-mappings";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SettingsConfig.module.css";
import {
  accessVariant,
  aggregatePublicHref,
  aggregateStaticMappings,
  formatDate,
  request,
  validatedStaticResponseMappings,
  type StaticAggregateEntry,
  type StaticApiError,
  type StaticMachineResult,
} from "./static-content-helpers";

export function StaticContentList({ reloadKey = 0 }: { reloadKey?: number }) {
  const { t } = useI18n();
  const { machines, loading: machinesLoading } = useMachines();
  const [results, setResults] = useState<StaticMachineResult[] | null>(null);
  const [localReloadKey, setLocalReloadKey] = useState(0);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (machinesLoading) return;
    const generation = ++loadGenerationRef.current;
    // Start from an empty aggregate: no stale rows survive a refresh. Each
    // machine settles independently, so a slow/offline machine never blanks
    // rows already returned by healthy machines.
    setResults([]);
    await Promise.all(machines.map(async (machine) => {
      const base = { machineId: machine.id, machineName: machine.name || machine.id };
      let outcome: StaticMachineResult;
      try {
        const result = await request<StaticMappingListResponse>(apiPath("/api/static-mappings", machine.id), { cache: "no-store", signal });
        // A 200 with a non-JSON body (proxy/HTML error page) parses to null,
        // a primitive, or an array; anything but the documented envelope with
        // renderable rows is a per-machine failure, never rows — one malformed
        // response must not blank or crash the list.
        const mappings = validatedStaticResponseMappings(result);
        outcome = mappings
          ? { ...base, mappings, failure: null }
          : { ...base, mappings: [], failure: { status: null, message: t("staticContent.invalidResponse") } };
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        outcome = {
          ...base,
          mappings: [],
          failure: {
            status: (caught as StaticApiError).status ?? null,
            message: caught instanceof Error ? caught.message : String(caught),
          },
        };
      }
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setResults((current) => {
        const prev = current ?? [];
        const index = prev.findIndex((item) => item.machineId === machine.id);
        if (index === -1) return [...prev, outcome];
        const next = [...prev];
        next[index] = outcome;
        return next;
      });
    }));
  }, [machines, machinesLoading, t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [load, reloadKey, localReloadKey]);

  // Only machines still granted in the current listing may contribute rows;
  // a stale response must never outlive a machine-grant change.
  const visibleResults = useMemo(() => {
    if (!results) return null;
    const granted = new Set(machines.map((machine) => machine.id));
    return results.filter((result) => granted.has(result.machineId));
  }, [results, machines]);
  const entries = useMemo(() => (visibleResults ? aggregateStaticMappings(visibleResults) : []), [visibleResults]);
  const failures = useMemo(() => (visibleResults ?? []).filter((result) => result.failure), [visibleResults]);
  const loading = machinesLoading || visibleResults === null;
  // Machines whose response has not settled yet in the current attempt.
  const settledIds = useMemo(() => new Set((visibleResults ?? []).map((result) => result.machineId)), [visibleResults]);
  const pending = machinesLoading ? machines.length : machines.filter((machine) => !settledIds.has(machine.id)).length;

  return (
    <div className={styles.staticAggregateBody}>
      {loading ? (
        <div className={styles.empty}>{t("staticContent.loading")}</div>
      ) : (
        <>
          {failures.length > 0 && (
            <div className={styles.staticFailureList} role="status">
              {failures.map((result) => {
                const variant = accessVariant(result.failure!.status ?? undefined);
                const reason = variant === "no-permission"
                  ? t("staticContent.aggregate.machineNoPermission")
                  : variant === "not-found"
                    ? t("staticContent.aggregate.machineNotFound")
                    : variant === "offline"
                      ? t("staticContent.aggregate.machineOffline")
                      : t("staticContent.aggregate.machineError", { reason: result.failure!.message });
                return (
                  <div key={result.machineId} className={styles.staticFailureNote}>
                    <strong>{result.machineName}</strong>
                    <span>{reason}</span>
                  </div>
                );
              })}
            </div>
          )}
          {pending > 0 && (
            <div className={styles.staticPendingNote} role="status">{t("staticContent.loading")}</div>
          )}
          {entries.length > 0 ? (
            <div className={styles.staticMappingList}>
              {entries.map((entry) => (
                <StaticAggregateCard key={`${entry.machineId}:${entry.mapping.id}`} entry={entry} />
              ))}
            </div>
          ) : pending === 0 ? (
            <div className={styles.empty}>{t("staticContent.aggregate.empty")}</div>
          ) : null}
          <div className={styles.staticAggregateFooter}>
            <button type="button" className={styles.staticRefreshButton} disabled={pending > 0} onClick={() => setLocalReloadKey((key) => key + 1)}>
              {t("home.refresh")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function StaticAggregateCard({ entry }: { entry: StaticAggregateEntry }) {
  const { t } = useI18n();
  const { mapping } = entry;
  const href = aggregatePublicHref(entry);
  return (
    <article className={styles.staticMappingCard}>
      <div className={styles.staticMappingHeader}>
        <div className={styles.staticMappingName}>
          <h3>{mapping.label || mapping.id}</h3>
          <code title={mapping.id}>{mapping.id}</code>
        </div>
        <div className={styles.staticMappingBadges}>
          <span className={styles.sourceBadge} data-status={mapping.state}>{t(`staticContent.state.${mapping.state}`)}</span>
          <span className={styles.sourceBadge} data-status={mapping.contentRetained ? "retained" : "deleted"}>{mapping.contentRetained ? t("staticContent.contentRetained") : t("staticContent.contentDeleted")}</span>
        </div>
      </div>

      <div className={styles.staticMappingPath}>
        <span className={styles.settingLabel}>{t("staticContent.publicPath")}</span>
        <a href={href} target="_blank" rel="noreferrer">{href}</a>
      </div>

      <dl className={styles.staticMappingMeta}>
        <div><dt>{t("staticContent.machine")}</dt><dd title={entry.machineId}>{entry.machineName}</dd></div>
        <div><dt>{t("staticContent.project")}</dt><dd title={mapping.projectRoot}>{mapping.projectRoot ?? t("staticContent.noProject")}</dd></div>
        <div><dt>{t("staticContent.created")}</dt><dd>{formatDate(mapping.createdAt)}</dd></div>
        <div><dt>{t("staticContent.expiry")}</dt><dd>{mapping.lifecycle === "persistent" ? t("staticContent.noExpiry") : formatDate(mapping.expiresAt)}</dd></div>
      </dl>
    </article>
  );
}
