"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { fetchInjectionSettings, INJECTION_SETTINGS_CHANGED_EVENT, patchInjectionSetting } from "@/lib/injection-client";
import { INJECTION_SOURCES, type InjectionSourceDef } from "@/lib/injection-sources";
import type { InjectionSettingPatch, InjectionSettingsResponse, InjectionSwitchState, SettingsValue } from "@/lib/settings-api";
import styles from "./PromptsConfig.module.css";

function printable(value: SettingsValue, inherit: string): string {
  return value === null ? inherit : Array.isArray(value) ? value.join(", ") : String(value);
}

/** Uses the exact endpoint, setting paths and change event consumed by #116's transcript controls. */
export function InjectionSettingsPanel({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const [data, setData] = useState<InjectionSettingsResponse | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [rule, setRule] = useState("");
  const load = useCallback(async () => {
    try { setData(await fetchInjectionSettings(cwd)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [cwd]);
  useEffect(() => {
    void load();
    const update = () => { void load(); };
    window.addEventListener(INJECTION_SETTINGS_CHANGED_EVENT, update);
    return () => window.removeEventListener(INJECTION_SETTINGS_CHANGED_EVENT, update);
  }, [load]);
  const write = async (patch: InjectionSettingPatch) => {
    setBusy(true); setError(""); setNote("");
    try { await patchInjectionSetting(patch); setNote(t("prompts.injectionSaved")); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const scopeControl = (entry: InjectionSwitchState, scope: "global" | "project") => {
    const raw = entry[scope];
    const disabled = busy || (scope === "project" && !cwd);
    const base = { path: entry.path, scope, cwd: scope === "project" ? cwd ?? undefined : undefined } as const;
    if (entry.kind === "append-rule") return <div className={styles.ruleList}>
      {raw === null && <small>{t("prompts.inherit")}</small>}
      {(Array.isArray(raw) ? raw : scope === "project" && Array.isArray(entry.effective) ? entry.effective : []).map((name) => <button key={name} disabled={disabled} onClick={() => void write({ ...base, removeRule: name })} title={t("prompts.enableRule")}>{name} ×</button>)}
      <div className={styles.ruleInput}><input aria-label={`${t("prompts.disableRule")} ${scope}`} value={rule} onChange={(event) => setRule(event.target.value)} placeholder={t("prompts.ruleName")} /><button disabled={disabled || !rule.trim()} onClick={() => void write({ ...base, appendRule: rule.trim() })}>{t("prompts.disableRule")}</button></div>
      {raw !== null && <button disabled={disabled} onClick={() => void write({ ...base, clear: true })}>{t("prompts.inherit")}</button>}
    </div>;
    const options: Array<{ value: string; label: string }> = entry.options?.length
      ? entry.options.map((value) => ({ value: JSON.stringify(value), label: value === entry.offValue ? `${value} · ${t("prompts.off")}` : value }))
      : [{ value: "true", label: t("prompts.on") }, { value: "false", label: t("prompts.off") }];
    return <select aria-label={`${entry.label} · ${scope}`} value={raw === null ? "inherit" : JSON.stringify(raw)} disabled={disabled} onChange={(event) => {
      const next = event.target.value;
      void write(next === "inherit" ? { ...base, clear: true } : { ...base, value: JSON.parse(next) as boolean | string });
    }}><option value="inherit">{t("prompts.inherit")}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  };
  const unmapped = (Object.values(INJECTION_SOURCES) as InjectionSourceDef[]).filter((source) => !source.setting);
  return <section className={styles.injections}>
    <h3>{t("prompts.injections")}</h3><p className={styles.muted}>{t("prompts.injectionDescription")}</p>
    {error && <div className={styles.error} role="alert">{error} <button onClick={() => void load()}>{t("prompts.retry")}</button></div>}
    {note && <p role="status">{note}</p>}
    {!data && !error && <p>{t("prompts.loading")}</p>}
    {data && <div className={styles.switchTable}><div className={styles.switchHeader}><span>{t("prompts.source")}</span><span>{t("prompts.global")}</span><span>{t("prompts.project")}</span></div>{data.switches.map((entry) => <div className={styles.switchRow} key={entry.path}>
      <div><strong>{entry.path === "plan.defaultOnStartup" ? t("prompts.planStartup") : entry.label}</strong><code>{entry.path}</code><small>{entry.path === "plan.defaultOnStartup" ? t("prompts.planStartupNote") : entry.description}</small><small>{t("prompts.effective")}: {printable(entry.effective, t("prompts.inherit"))} · {t(entry.effect === "new-session" ? "prompts.newConversations" : "prompts.nextTurn")}</small></div>
      {scopeControl(entry, "global")}{scopeControl(entry, "project")}
    </div>)}</div>}
    <details><summary>{t("prompts.unmapped")}</summary><p className={styles.muted}>{t("prompts.unmappedDescription")}</p>{unmapped.map((source) => <div key={source.id} className={styles.readOnlyRow}>{source.label} <span>{t("prompts.readOnly")}</span></div>)}</details>
  </section>;
}
