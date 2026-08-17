"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useMachines } from "@/lib/machine-context";
import { useI18n } from "@/hooks/useI18n";
import { AccessNotice } from "./AccessNotice";
import type { MachineAuthMode, MachineHealth, MachineTestResult, SafeMachine } from "@/lib/api-types";
import styles from "./SettingsConfig.module.css";

type HealthState = {
  state: "loading" | "online" | "offline" | "unauthorized";
  health?: MachineHealth;
  reason?: string;
};

type MachineForm = {
  name: string;
  baseUrl: string;
  authMode: MachineAuthMode;
  credential: string;
  username: string;
  headersText: string;
};

type ApiError = Error & { status?: number };

const EMPTY_FORM: MachineForm = {
  name: "",
  baseUrl: "",
  authMode: "bearer",
  credential: "",
  username: "omp",
  headersText: "",
};

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init?.headers,
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok || result.error) {
    const error = new Error(result.error ?? `HTTP ${response.status}`) as ApiError;
    error.status = response.status;
    throw error;
  }
  return result;
}

function parseHeaders(text: string): Record<string, string> | undefined | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (separator <= 0 || !name || !value) return null;
    headers[name] = value;
  }
  return headers;
}

function statusLabel(status: HealthState | undefined): string {
  if (!status || status.state === "loading") return "Checking…";
  if (status.state === "online") return "Online";
  if (status.state === "unauthorized") return "Unauthorized";
  return "Offline";
}

function statusColor(status: HealthState | undefined): string {
  if (!status || status.state === "loading") return "var(--text-dim)";
  if (status.state === "online") return "var(--success)";
  if (status.state === "unauthorized") return "var(--warning)";
  return "var(--danger)";
}

async function fetchHealth(machine: SafeMachine, signal: AbortSignal): Promise<HealthState> {
  try {
    const response = await fetch(apiPath("/api/health", machine.id), { cache: "no-store", signal });
    const body = await response.json().catch(() => ({})) as MachineHealth & { error?: string };
    if (response.status === 401 || response.status === 403) {
      return { state: "unauthorized", reason: body.error ?? "The machine rejected its configured credential." };
    }
    if (!response.ok || body.ok !== true) {
      return { state: "offline", reason: body.error ?? `HTTP ${response.status}` };
    }
    return { state: "online", health: body };
  } catch (caught) {
    return { state: "offline", reason: caught instanceof DOMException && caught.name === "AbortError" ? "Connection timed out." : errorMessage(caught) };
  }
}

function versionLabel(label: string, remote: string | null, local: string | null): React.ReactNode {
  if (!remote) return <span>{label} unavailable</span>;
  const drift = local !== null && local !== remote;
  return <span style={{ color: drift ? "var(--warning)" : "var(--text-dim)" }}>{label} {remote}{drift ? ` · local ${local}` : ""}</span>;
}

export function MachinesConfig() {
  const { refreshMachines } = useMachines();
  const { t } = useI18n();
  const [machines, setMachines] = useState<SafeMachine[] | null>(null);
  const [health, setHealth] = useState<Record<string, HealthState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<MachineForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<HealthState | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await request<{ machines: SafeMachine[] }>("/api/machines", { cache: "no-store" });
      setMachines(result.machines);
      setForbidden(false);
      setError(null);
    } catch (caught) {
      if ((caught as ApiError).status === 403) {
        setForbidden(true);
        setMachines([]);
        return;
      }
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!machines?.length) return;
    const controllers = machines.map(() => new AbortController());
    const timers = controllers.map((controller) => window.setTimeout(() => controller.abort(), 6_000));
    void Promise.all(machines.map((machine, index) => fetchHealth(machine, controllers[index].signal).then((result) => [machine.id, result] as const)))
      .then((results) => setHealth(Object.fromEntries(results)))
      .finally(() => timers.forEach((timer) => window.clearTimeout(timer)));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      controllers.forEach((controller) => controller.abort());
    };
  }, [machines]);

  const currentMachine = useMemo(() => machines?.find((machine) => machine.id === selected) ?? null, [machines, selected]);
  const localHealth = health.local?.health ?? null;

  useEffect(() => {
    if (!machines?.length) return;
    if (!selected || !machines.some((machine) => machine.id === selected)) setSelected(machines[0].id);
  }, [machines, selected]);

  useEffect(() => {
    setConfirmDelete(false);
    setTestResult(null);
    setError(null);
    if (!currentMachine || currentMachine.isLocal) return;
    setForm({
      name: currentMachine.name,
      baseUrl: currentMachine.baseUrl,
      authMode: currentMachine.authMode,
      credential: "",
      username: "",
      headersText: "",
    });
  }, [currentMachine]);

  useEffect(() => { setTestResult(null); }, [form.name, form.baseUrl, form.authMode, form.credential, form.username, form.headersText]);

  const updateForm = <Key extends keyof MachineForm>(key: Key, value: MachineForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const startCreate = () => {
    setCreating(true);
    setSelected(null);
    setForm(EMPTY_FORM);
    setError(null);
  };

  const formPayload = (): Record<string, unknown> | null => {
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const headers = parseHeaders(form.headersText);
    if (!name || !baseUrl) {
      setError("Name and base URL are required.");
      return null;
    }
    if (headers === null) {
      setError("Static headers must use one Name: value pair per line.");
      return null;
    }
    if (form.authMode !== "none" && creating && !form.credential) {
      setError("A credential is required for bearer and basic authentication.");
      return null;
    }
    return {
      name,
      baseUrl,
      authMode: form.authMode,
      ...(form.credential ? { token: form.credential } : {}),
      ...(form.authMode === "basic" && form.username.trim() ? { username: form.username.trim() } : {}),
      ...(headers ? { headers } : {}),
    };
  };

  const testConnection = async () => {
    const payload = formPayload();
    if (!payload || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Local-only: /api/machines/** is the gateway's own fleet API, never proxied.
      const result = await request<MachineTestResult>("/api/machines/test", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: payload.baseUrl,
          authMode: payload.authMode,
          ...(payload.token ? { token: payload.token } : {}),
          ...(payload.username ? { username: payload.username } : {}),
          ...(payload.headers ? { headers: payload.headers } : {}),
          ...(!creating && currentMachine ? { id: currentMachine.id } : {}),
        }),
      });
      setTestResult(result.ok && result.health
        ? { state: "online", health: result.health }
        : result.code === "machine_unauthorized"
          ? { state: "unauthorized", reason: result.error ?? "The machine rejected this credential." }
          : { state: "offline", reason: result.error ?? result.code ?? "Connection test failed." });
    } catch (caught) {
      setTestResult({ state: "offline", reason: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };

  const saveMachine = async () => {
    const payload = formPayload();
    if (!payload || busy) return;
    if (testResult && testResult.state !== "online") {
      setError("Saved anyway — the last connection test did not succeed.");
    }
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        const machine = await request<SafeMachine>("/api/machines", { method: "POST", body: JSON.stringify(payload) });
        setCreating(false);
        setSelected(machine.id);
      } else if (currentMachine) {
        await request<SafeMachine>(`/api/machines/${encodeURIComponent(currentMachine.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
      }
      await Promise.all([load(), refreshMachines()]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const deleteMachine = async () => {
    if (!currentMachine || currentMachine.isLocal || busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(`/api/machines/${encodeURIComponent(currentMachine.id)}`, { method: "DELETE" });
      setSelected("local");
      await Promise.all([load(), refreshMachines()]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  if (forbidden) {
    return <AccessNotice variant="no-permission" title={t("accessNotice.adminOnly")} body={t("accessNotice.forbidden")} fullScreen={false} />;
  }

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>Machines</h2>
        <p className={styles.contentDescription}>Connect this gateway to other omp-web instances. Credentials are write-only and remain on this gateway.</p>
      </header>
      <div className={styles.settingsBody}>
        {!machines ? <div className={styles.empty}>{error ?? "Loading machines…"}</div> : (
          <div className={styles.mcpLayout}>
            <aside className={styles.mcpList}>
              <div className={styles.serverRows}>
                {machines.map((machine) => {
                  const machineHealth = health[machine.id];
                  return (
                    <div key={machine.id} className={styles.serverRow} data-active={!creating && selected === machine.id}>
                      <button type="button" className={styles.serverSelect} onClick={() => { setCreating(false); setSelected(machine.id); }} title={machine.baseUrl}>
                        <span className={styles.statusDot} style={{ background: statusColor(machineHealth) }} />
                        <span className={styles.serverName} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span>{machine.name}</span>
                          <span title={machine.baseUrl} style={{ color: "var(--text-dim)", fontSize: 9 }}>{machine.baseUrl}</span>
                        </span>
                        <span className={styles.sourceBadge}>{machine.authMode}</span>
                        <span className={styles.sourceBadge} style={{ color: statusColor(machineHealth) }}>{statusLabel(machineHealth)}</span>
                        {machine.isLocal ? <span className={styles.sourceBadge}>local</span> : machineHealth?.health && localHealth && (machineHealth.health.ompVersion !== localHealth.ompVersion || machineHealth.health.ompWebVersion !== localHealth.ompWebVersion) && <span className={styles.sourceBadge} style={{ color: "var(--warning)" }}>version drift</span>}
                      </button>
                    </div>
                  );
                })}
              </div>
              <button type="button" className={styles.addServer} onClick={startCreate}>+ Add machine</button>
            </aside>
            <section className={styles.mcpEditor}>
              {creating || (currentMachine && !currentMachine.isLocal) ? <>
                <div className={styles.editorHeader}>
                  <input className={styles.textInput} placeholder="machine name" value={form.name} spellCheck={false} onChange={(event) => updateForm("name", event.target.value)} />
                  {!creating && <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void deleteMachine()}>{confirmDelete ? "Confirm delete?" : "Delete"}</button>}
                </div>
                <div className={styles.settingLabel}>Base URL</div>
                <input className={styles.textInput} placeholder="https://omp.example.test" value={form.baseUrl} spellCheck={false} onChange={(event) => updateForm("baseUrl", event.target.value)} />
                <div className={styles.settingLabel} style={{ marginTop: 10 }}>Authentication</div>
                <select className={styles.select} value={form.authMode} onChange={(event) => updateForm("authMode", event.target.value as MachineAuthMode)}>
                  <option value="bearer">Bearer token</option><option value="basic">Basic authentication</option><option value="none">No authentication</option>
                </select>
                {form.authMode === "basic" && <><div className={styles.settingLabel} style={{ marginTop: 10 }}>Basic username</div><input className={styles.textInput} value={form.username} placeholder={creating ? "omp" : "leave blank to keep the current username"} spellCheck={false} onChange={(event) => updateForm("username", event.target.value)} /></>}
                {form.authMode !== "none" && <><div className={styles.settingLabel} style={{ marginTop: 10 }}>{form.authMode === "basic" ? "Basic password" : "Bearer token"}</div><input type="password" className={styles.textInput} value={form.credential} placeholder={creating ? "credential" : "leave blank to keep the current credential"} autoComplete="new-password" onChange={(event) => updateForm("credential", event.target.value)} /></>}
                <div className={styles.settingLabel} style={{ marginTop: 10 }}>Static headers</div>
                <textarea className={styles.jsonEditor} style={{ minHeight: 72 }} value={form.headersText} placeholder={creating ? "X-Example: value" : "leave blank to keep current headers"} spellCheck={false} onChange={(event) => updateForm("headersText", event.target.value)} />
                {currentMachine?.headerNames.length ? <div className={styles.saveState}>Configured header names: {currentMachine.headerNames.join(", ")}.</div> : null}
                {currentMachine?.hasCredential && !creating && <div className={styles.saveState}>A credential is configured for this machine. It is never shown here.</div>}
                {testResult && <div role={testResult.state === "online" ? "status" : "alert"} className={testResult.state === "online" ? styles.saveState : styles.error} style={{ marginTop: 10 }}>
                  {statusLabel(testResult)}{testResult.reason ? ` · ${testResult.reason}` : ""}
                </div>}
                <div className={styles.editorActions}>
                  <div>{error && <div className={styles.error}>{error}</div>}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => { setCreating(false); setSelected(currentMachine?.id ?? "local"); }}>Cancel</button>
                    <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void testConnection()}>{busy ? "Testing…" : "Test connection"}</button>
                    <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void saveMachine()}>{busy ? "Saving…" : creating ? "Add machine" : "Save machine"}</button>
                  </div>
                </div>
              </> : currentMachine ? <>
                <div className={styles.editorHeader}><input className={styles.textInput} value={currentMachine.name} readOnly /></div>
                <div className={styles.readOnlyNotice}>This is the gateway machine. It is always available locally and cannot be edited or deleted.</div>
                <div className={styles.serverRow} style={{ marginTop: 10 }}><span className={styles.statusDot} style={{ background: statusColor(health.local) }} /><span className={styles.serverName}>{statusLabel(health.local)}</span></div>
              </> : <div className={styles.empty}>Select a machine or add one.</div>}
              {currentMachine && <div style={{ marginTop: 18, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <div className={styles.settingLabel}>Connection status</div>
                <div className={styles.saveState}>{currentMachine.baseUrl}</div>
                <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 7, font: "10px var(--font-mono)", color: statusColor(health[currentMachine.id]) }}><span className={styles.statusDot} style={{ background: statusColor(health[currentMachine.id]) }} />{statusLabel(health[currentMachine.id])}</div>
                {health[currentMachine.id]?.reason && <div className={styles.error} style={{ marginTop: 5 }}>{health[currentMachine.id].reason}</div>}
                {health[currentMachine.id]?.health && <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 3, font: "10px var(--font-mono)" }}>
                  {versionLabel("omp-web", health[currentMachine.id].health?.ompWebVersion ?? null, localHealth?.ompWebVersion ?? null)}
                  {versionLabel("omp", health[currentMachine.id].health?.ompVersion ?? null, localHealth?.ompVersion ?? null)}
                </div>}
              </div>}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
