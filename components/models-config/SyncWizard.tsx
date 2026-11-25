"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useI18n } from "@/hooks/useI18n";
import type { SyncSection } from "@/lib/models-config-sync";

/**
 * Three-step fleet sync wizard (issue #141): pick sections → pick targets with
 * preflight → diff preview + push. Every call goes through `apiPath()` so the
 * gateway's `/api/fleet/config-sync` orchestration is reached the same way any
 * other proxied route is.
 *
 * Mounted by the config page (three entry points preset `initialSections`);
 * kept in its own file so the page component stays untouched by this slice.
 */
export interface SyncWizardProps {
  open: boolean;
  onClose: () => void;
  /** Sections preselected by the entry point that opened the wizard. */
  initialSections: readonly SyncSection[];
  /** Fleet machines to offer as targets (local is excluded by the caller). */
  machines: readonly { id: string; name: string }[];
}

interface TargetResult {
  machineId: string;
  machineName: string;
  status: "applied" | "skipped" | "failed";
  detail: string;
  changed?: boolean;
  warnings?: string[];
  backupPaths?: string[];
}

interface SyncRunResponse {
  error?: string;
  dryRun?: boolean;
  sourceMachine?: string;
  results?: TargetResult[];
}

const SECTION_LABEL_KEYS: Record<SyncSection, string> = {
  providers: "sync.section.providers",
  roles: "sync.section.roles",
  enabledModels: "sync.section.enabledModels",
};

const SECTION_DETAIL_KEYS: Record<SyncSection, string> = {
  providers: "sync.section.providersDetail",
  roles: "sync.section.rolesDetail",
  enabledModels: "sync.section.enabledModelsDetail",
};

const STATUS_KEYS: Record<TargetResult["status"], string> = {
  applied: "sync.status.applied",
  skipped: "sync.status.skipped",
  failed: "sync.status.failed",
};

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function SyncWizard({ open, onClose, initialSections, machines }: SyncWizardProps) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [sections, setSections] = useState<SyncSection[]>([...initialSections]);
  const [targets, setTargets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TargetResult[] | null>(null);
  const [sourceMachine, setSourceMachine] = useState<string | null>(null);

  // A fresh opening re-presets step 1 from the entry point that mounted us.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSections([...initialSections]);
    setTargets([]);
    setResults(null);
    setError(null);
    setBusy(false);
  }, [open, initialSections]);

  const toggleSection = (section: SyncSection) => {
    setSections((current) => current.includes(section)
      ? current.filter((entry) => entry !== section)
      : [...current, section]);
  };

  const toggleTarget = (machineId: string) => {
    setTargets((current) => current.includes(machineId)
      ? current.filter((entry) => entry !== machineId)
      : [...current, machineId]);
  };

  const run = useCallback(async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiPath("/api/fleet/config-sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets, sections, dryRun }),
      });
      const data = await response.json().catch(() => ({})) as SyncRunResponse;
      if (!response.ok || data.error) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setResults(data.results ?? []);
      setSourceMachine(data.sourceMachine ?? null);
      if (dryRun) setStep(3);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [sections, targets]);

  const warnings = useMemo(
    () => (results ?? []).flatMap((result) => result.warnings ?? []),
    [results],
  );
  const canNext = step === 1 ? sections.length > 0 : step === 2 ? targets.length > 0 : false;

  if (!open) return null;

  const steps = [t("sync.step.sections"), t("sync.step.targets"), t("sync.step.push")];

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.44)",
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-wizard-title"
        data-testid="sync-wizard"
        style={{
          width: 620,
          maxWidth: "100%",
          maxHeight: "calc(100dvh - 32px)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg-panel)",
          boxShadow: "0 18px 52px rgba(0,0,0,0.3)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "16px 18px 10px" }}>
          <h3 id="sync-wizard-title" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
            {t("sync.title")}
          </h3>
          {sourceMachine ? (
            <span style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              {t("sync.source", { machine: sourceMachine })}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t("sync.close")}
            style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: busy ? "wait" : "pointer", fontSize: 16 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", gap: 14, padding: "0 18px 12px", borderBottom: "1px solid var(--border)" }}>
          {steps.map((label, index) => (
            <span
              key={label}
              data-active={step === index + 1}
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: step === index + 1 ? "var(--text)" : "var(--text-dim)",
                fontWeight: step === index + 1 ? 700 : 400,
              }}
            >
              {index + 1}. {label}
            </span>
          ))}
        </div>

        <div style={{ padding: "14px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {step === 1 ? (
            <>
              {(["providers", "roles", "enabledModels"] as const).map((section) => (
                <label
                  key={section}
                  data-testid={`sync-section-${section}`}
                  style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={sections.includes(section)}
                    onChange={() => toggleSection(section)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <span style={{ display: "block", fontSize: 12.5, fontWeight: 650 }}>
                      {t(SECTION_LABEL_KEYS[section])}
                    </span>
                    <span style={{ display: "block", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>
                      {t(SECTION_DETAIL_KEYS[section])}
                    </span>
                  </span>
                </label>
              ))}
              <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                {t("sync.excludedNote")}
              </p>
              {sections.includes("roles") || sections.includes("enabledModels") ? (
                <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                  {t("sync.fallbackNote")}
                </p>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 11 }}>
                {t("sync.targetsHint")}
              </p>
              {machines.length === 0 ? (
                <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 11 }}>
                  {t("sync.noTargets")}
                </p>
              ) : machines.map((machine) => (
                <label
                  key={machine.id}
                  data-testid={`sync-target-${machine.id}`}
                  style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={targets.includes(machine.id)}
                    onChange={() => toggleTarget(machine.id)}
                  />
                  <span style={{ fontSize: 12.5 }}>{machine.name}</span>
                  <span style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                    {machine.id}
                  </span>
                </label>
              ))}
              <button
                type="button"
                onClick={() => void run(true)}
                disabled={busy || targets.length === 0}
                style={{
                  alignSelf: "flex-start",
                  height: 30,
                  padding: "0 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  background: "var(--bg)",
                  color: "var(--text)",
                  cursor: busy || targets.length === 0 ? "wait" : "pointer",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {t("sync.preflight")}
              </button>
              {results ? (
                <div data-testid="sync-preflight-results" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {results.map((result) => (
                    <div
                      key={result.machineId}
                      data-status={result.status}
                      style={{
                        display: "flex",
                        gap: 8,
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        color: result.status === "failed" ? "var(--danger)" : "var(--text-muted)",
                      }}
                    >
                      <span>{result.machineName}</span>
                      <span style={{ flex: 1 }} />
                      <span>{result.detail}</span>
                    </div>
                  ))}
                  {warnings.map((warning) => (
                    <div key={warning} style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      ⚠ {warning}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div data-testid="sync-diff" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(results ?? []).map((result) => (
                  <div
                    key={result.machineId}
                    data-status={result.status}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "baseline",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <span style={{ color: "var(--text)" }}>{result.machineName}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ color: result.status === "failed" ? "var(--danger)" : "var(--text-muted)" }}>
                      {t(STATUS_KEYS[result.status])}
                    </span>
                  </div>
                ))}
              </div>
              {warnings.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {warnings.map((warning) => (
                    <div key={warning} style={{ fontSize: 11, color: "var(--text-dim)" }}>
                      ⚠ {warning}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p data-testid="sync-error" style={{ margin: 0, color: "var(--danger)", fontSize: 11 }}>
              {error}
            </p>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={() => { setStep((current) => Math.max(1, current - 1)); setResults(null); }}
            disabled={busy || step === 1}
            style={{ height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", cursor: busy || step === 1 ? "default" : "pointer", fontSize: 11 }}
          >
            {t("sync.back")}
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", cursor: busy ? "wait" : "pointer", fontSize: 11 }}
          >
            {t("sync.cancel")}
          </button>
          <button
            type="button"
            data-testid="sync-next"
            onClick={() => {
              if (step === 1) { setStep(2); return; }
              if (step === 2) { void run(false); return; }
              onClose();
            }}
            disabled={busy || (step === 1 ? !canNext : step === 2 ? !canNext : false)}
            style={{
              height: 30,
              padding: "0 14px",
              border: 0,
              borderRadius: 5,
              background: "var(--accent)",
              color: "var(--bg)",
              fontWeight: 700,
              fontSize: 11,
              cursor: busy || (step === 1 ? !canNext : step === 2 ? !canNext : false) ? "wait" : "pointer",
            }}
          >
            {step === 3 ? t("sync.done") : step === 2 ? t("sync.push", { count: targets.length }) : t("sync.next")}
          </button>
        </div>
      </div>
    </div>
  );
}