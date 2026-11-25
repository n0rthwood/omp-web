"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useMachines } from "@/lib/machine-context";
import type {
  StaticMapping,
  StaticMappingDeleteResponse,
  StaticMappingLifecycle,
  StaticMappingListResponse,
  StaticMappingMutationResponse,
  StaticMappingPatchInput,
} from "@/lib/static-mappings";
import { useI18n } from "@/hooks/useI18n";
import { AccessNotice, type AccessNoticeVariant } from "./AccessNotice";
import { accessVariant, aggregatePublicHref, formatDate, request, type StaticApiError } from "./static-content-helpers";
import styles from "./SettingsConfig.module.css";

type RevokeChoice = "delete" | "retain";

type MappingDraft = {
  lifecycle: StaticMappingLifecycle;
  expiresAt: string;
};

function toDateTimeLocal(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function defaultExpiry(): string {
  return toDateTimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
}

function initialDraft(mapping: StaticMapping): MappingDraft {
  return {
    lifecycle: mapping.lifecycle,
    expiresAt: toDateTimeLocal(mapping.expiresAt),
  };
}

export function StaticContentConfig() {
  const { t } = useI18n();
  const { machineId, machines } = useMachines();
  const [mappings, setMappings] = useState<StaticMapping[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, MappingDraft>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<AccessNoticeVariant | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; choice: RevokeChoice } | null>(null);

  const machineName = useMemo(
    () => machines.find((machine) => machine.id === machineId)?.name ?? machineId,
    [machineId, machines],
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setAccessError(null);
    setConfirmRevoke(null);
    try {
      const result = await request<StaticMappingListResponse>(apiPath("/api/static-mappings"), { cache: "no-store", signal });
      setMappings(result.mappings);
      setDrafts(Object.fromEntries(result.mappings.map((mapping) => [mapping.id, initialDraft(mapping)])));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      const status = (caught as StaticApiError).status;
      setAccessError(accessVariant(status));
      setError(caught instanceof Error ? caught.message : String(caught));
      setMappings(null);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, machineId]);

  const updateDraft = (mapping: StaticMapping, update: Partial<MappingDraft>) => {
    setDrafts((current) => ({
      ...current,
      [mapping.id]: { ...(current[mapping.id] ?? initialDraft(mapping)), ...update },
    }));
  };

  const saveMapping = async (mapping: StaticMapping) => {
    const draft = drafts[mapping.id] ?? initialDraft(mapping);
    const persistent = draft.lifecycle === "persistent";
    const expiresAt = persistent ? null : fromDateTimeLocal(draft.expiresAt);
    const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (!persistent && !expiresAt) {
      setError(t("staticContent.expiryRequired"));
      return;
    }
    if (!persistent && (!Number.isFinite(expiryMs) || expiryMs <= Date.now())) {
      setError(t("staticContent.expiryPast"));
      return;
    }
    setSavingId(mapping.id);
    setError(null);
    try {
      const payload: StaticMappingPatchInput = {
        lifecycle: draft.lifecycle,
        persistent,
        expiresAt,
      };
      const result = await request<StaticMappingMutationResponse>(apiPath(`/api/static-mappings/${encodeURIComponent(mapping.id)}`), {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      if (!result.mapping) throw new Error(t("staticContent.invalidResponse"));
      setMappings((current) => current?.map((item) => item.id === mapping.id ? result.mapping! : item) ?? current);
      setDrafts((current) => ({ ...current, [mapping.id]: initialDraft(result.mapping!) }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingId(null);
    }
  };

  const revokeMapping = async (mapping: StaticMapping, choice: RevokeChoice) => {
    if (!confirmRevoke || confirmRevoke.id !== mapping.id || confirmRevoke.choice !== choice) {
      setConfirmRevoke({ id: mapping.id, choice });
      return;
    }
    setRevokingId(mapping.id);
    setError(null);
    try {
      const result = await request<StaticMappingDeleteResponse>(
        `${apiPath(`/api/static-mappings/${encodeURIComponent(mapping.id)}`)}?content=${choice}`,
        { method: "DELETE" },
      );
      if (!result.mapping) throw new Error(t("staticContent.invalidResponse"));
      setMappings((current) => current?.filter((item) => item.id !== mapping.id) ?? current);
      setDrafts((current) => {
        const next = { ...current };
        delete next[mapping.id];
        return next;
      });
      setConfirmRevoke(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRevokingId(null);
    }
  };

  if (accessError) {
    const copy = accessError === "no-permission"
      ? { title: t("accessNotice.machine.no-permission.title"), body: t("accessNotice.machine.no-permission.body") }
      : accessError === "not-found"
        ? { title: t("accessNotice.machine.not-found.title"), body: t("accessNotice.machine.not-found.body") }
        : { title: t("accessNotice.machine.offline.title"), body: t("accessNotice.machine.offline.body") };
    return <AccessNotice variant={accessError} title={copy.title} body={copy.body} fullScreen={false} />;
  }

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>{t("staticContent.title")}</h2>
        <p className={styles.contentDescription}>{t("staticContent.description", { machine: machineName })}</p>
      </header>
      <div className={styles.settingsBody}>
        {error && <div role="alert" className={styles.error} style={{ marginBottom: 14 }}>{error}</div>}
        {loading && !mappings ? <div className={styles.empty}>{t("staticContent.loading")}</div> : mappings === null ? <div className={styles.empty}>{error ?? t("staticContent.empty")}</div> : mappings.length ? (
          <div className={styles.staticMappingList}>
            {mappings.map((mapping) => {
              const draft = drafts[mapping.id] ?? initialDraft(mapping);
              const persistent = draft.lifecycle === "persistent";
              const confirmingDelete = confirmRevoke?.id === mapping.id && confirmRevoke.choice === "delete";
              const confirmingRetain = confirmRevoke?.id === mapping.id && confirmRevoke.choice === "retain";
              const busy = savingId === mapping.id || revokingId === mapping.id;
              return (
                <article className={styles.staticMappingCard} key={mapping.id}>
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
                    <a href={aggregatePublicHref({ machineId, mapping })} target="_blank" rel="noreferrer">{aggregatePublicHref({ machineId, mapping })}</a>
                  </div>

                  <dl className={styles.staticMappingMeta}>
                    {mapping.projectRoot && <div><dt>{t("staticContent.project")}</dt><dd title={mapping.projectRoot}>{mapping.projectRoot}</dd></div>}
                    <div><dt>{t("staticContent.created")}</dt><dd>{formatDate(mapping.createdAt)}</dd></div>
                    <div><dt>{t("staticContent.updated")}</dt><dd>{formatDate(mapping.updatedAt)}</dd></div>
                    <div><dt>{t("staticContent.expiry")}</dt><dd>{mapping.lifecycle === "persistent" ? t("staticContent.noExpiry") : formatDate(mapping.expiresAt)}</dd></div>
                    {mapping.revokedAt && <div><dt>{t("staticContent.revoked")}</dt><dd>{formatDate(mapping.revokedAt)}</dd></div>}
                  </dl>

                  <div className={styles.staticMappingControls}>
                    <div className={styles.staticMappingControlGroup}>
                      <div>
                        <div className={styles.settingLabel}>{t("staticContent.lifecycle")}</div>
                        <div className={styles.settingDescription}>{persistent ? t("staticContent.persistent") : t("staticContent.temporary")}</div>
                      </div>
                      <button
                        type="button"
                        className={styles.switch}
                        data-on={persistent}
                        aria-pressed={persistent}
                        aria-label={persistent ? t("staticContent.makeTemporary") : t("staticContent.makePersistent")}
                        disabled={busy || mapping.state === "revoked"}
                        onClick={() => updateDraft(mapping, { lifecycle: persistent ? "temporary" : "persistent", expiresAt: persistent && !draft.expiresAt ? defaultExpiry() : draft.expiresAt })}
                      />
                    </div>
                    <label className={styles.staticMappingExpiry}>
                      <span className={styles.settingLabel}>{t("staticContent.expiry")}</span>
                      <input
                        className={styles.dateInput}
                        type="datetime-local"
                        min={toDateTimeLocal(new Date().toISOString())}
                        value={draft.expiresAt}
                        disabled={busy || persistent || mapping.state === "revoked"}
                        onChange={(event) => updateDraft(mapping, { expiresAt: event.target.value, lifecycle: "temporary" })}
                      />
                    </label>
                    <button type="button" className={styles.primaryButton} disabled={busy || mapping.state === "revoked"} onClick={() => void saveMapping(mapping)}>
                      {savingId === mapping.id ? t("staticContent.saving") : t("staticContent.save")}
                    </button>
                  </div>

                  <div className={styles.staticMappingRevoke}>
                    <div>
                      <div className={styles.settingLabel}>{t("staticContent.revoke")}</div>
                      <div className={styles.settingDescription}>{t("staticContent.revokeDescription")}</div>
                    </div>
                    <div className={styles.staticMappingActions}>
                      <button type="button" className={styles.dangerButton} disabled={busy || mapping.state === "revoked"} onClick={() => void revokeMapping(mapping, "retain")}>
                        {revokingId === mapping.id && confirmingRetain ? t("staticContent.revoking") : confirmingRetain ? t("staticContent.confirmRetain") : t("staticContent.revokeRetain")}
                      </button>
                      <button type="button" className={styles.dangerButton} disabled={busy || mapping.state === "revoked"} onClick={() => void revokeMapping(mapping, "delete")}>
                        {revokingId === mapping.id && confirmingDelete ? t("staticContent.revoking") : confirmingDelete ? t("staticContent.confirmDelete") : t("staticContent.revokeDelete")}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className={styles.empty}>{t("staticContent.empty")}</div>}
      </div>
    </div>
  );
}
