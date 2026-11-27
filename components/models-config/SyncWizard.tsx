"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useI18n } from "@/hooks/useI18n";
import type { TranslationParams } from "@/lib/i18n/types";
import type { SyncApplyResult, SyncIssue, SyncSection } from "@/lib/models-config-sync";

/**
 * Three-step fleet sync wizard (issue #141; flow reworked by #145): pick
 * sections → pick targets, each with a preflight status that appears by itself
 * on entry → per-machine content diff, then push. Every call goes through
 * `apiPath()` so the gateway's `/api/fleet/config-sync` orchestration is
 * reached the same way any other proxied route is.
 *
 * The preflight is the gateway's dry run over every machine, so a row shows
 * its readiness whether or not it ends up selected; the push only touches the
 * selected ones.
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
  status: "applied" | "skipped" | "in_sync" | "failed";
  detail: string;
  changed?: boolean;
  warnings?: string[];
  /** Structured preflight findings; absent from an older target. */
  issues?: SyncIssue[];
  /** Content-level diff; absent on failure or from an older target. */
  applied?: SyncApplyResult["applied"];
  backupPaths?: string[];
}

interface SyncRunResponse {
  error?: string;
  dryRun?: boolean;
  sourceMachine?: string;
  excludedOAuthProviders?: string[];
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
  in_sync: "sync.status.inSync",
  failed: "sync.status.failed",
};

type Translate = (key: string, params?: TranslationParams) => string;

type Tone = "ok" | "warn" | "bad" | "dim";

const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--text-muted)",
  warn: "var(--warning, #d29922)",
  bad: "var(--danger)",
  dim: "var(--text-dim)",
};

const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11 };

const SECONDARY_BUTTON: React.CSSProperties = {
  height: 30,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 11,
};

function hasIssues(result: TargetResult): boolean {
  return (result.issues?.length ?? 0) > 0 || (result.warnings?.length ?? 0) > 0;
}

/** `⚠`-marked preflight findings in the UI language; an older target only reports the fixed English lines. */
function TargetIssues({ result }: { result: TargetResult }) {
  const { t } = useI18n();
  if (result.issues && result.issues.length > 0) {
    return (
      <>
        {result.issues.map((issue, index) => (
          <div key={index} style={{ color: TONE_COLOR.warn }}>
            {"⚠ "}
            {issue.kind === "missing_key"
              ? t("sync.issueMissingKey", { key: issue.envVar })
              : t("sync.issueNotLoggedIn", { provider: issue.provider })}
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {(result.warnings ?? []).map((warning) => (
        <div key={warning} style={{ color: TONE_COLOR.warn }}>⚠ {warning}</div>
      ))}
    </>
  );
}

/**
 * One machine's preflight verdict. `expanded` spells the findings out under
 * the verdict (the target list); otherwise they collapse to a count (the diff
 * header on the last step, which lists them separately).
 */
function PreflightStatus({ result, checking, expanded }: { result?: TargetResult; checking: boolean; expanded: boolean }) {
  const { t } = useI18n();
  if (!result) return checking ? <span style={{ color: TONE_COLOR.dim }}>{t("sync.checking")}</span> : null;
  if (result.status === "failed") return <span style={{ color: TONE_COLOR.bad }}>✕ {result.detail}</span>;
  if (hasIssues(result)) {
    return (
      <div style={{ color: TONE_COLOR.warn }}>
        <span>⚠ {expanded ? "" : t("sync.hasIssues", { count: (result.issues ?? result.warnings ?? []).length })}</span>
        {expanded && <TargetIssues result={result} />}
      </div>
    );
  }
  return (
    <span style={{ color: TONE_COLOR.ok }}>
      ✓ {t("sync.ready")} · {result.changed ? t("sync.readyChanges") : t("sync.readyInSync")}
    </span>
  );
}

type Machine = SyncWizardProps["machines"][number];

/** Step 2 body: every machine with its selection box and preflight status. */
export function SyncTargetList({ machines, targets, preflight, checking, onToggle }: {
  machines: readonly Machine[];
  targets: readonly string[];
  preflight: ReadonlyMap<string, TargetResult>;
  checking: boolean;
  onToggle?: (machineId: string) => void;
}) {
  return (
    <>
      {machines.map((machine) => (
        <label
          key={machine.id}
          data-testid={`sync-target-${machine.id}`}
          style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", fontSize: 12.5 }}
        >
          <input
            type="checkbox"
            checked={targets.includes(machine.id)}
            onChange={() => onToggle?.(machine.id)}
            style={{ marginTop: 2 }}
          />
          <span style={{ flexShrink: 0, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {machine.name}
          </span>
          <span style={{ ...MONO, flexShrink: 0, color: "var(--text-dim)", fontSize: 11, paddingTop: 1 }}>{machine.id}</span>
          <span data-testid={`sync-preflight-${machine.id}`} style={{ ...MONO, flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 1.5 }}>
            <PreflightStatus result={preflight.get(machine.id)} checking={checking} expanded />
          </span>
        </label>
      ))}
    </>
  );
}

interface DiffRow {
  label: string;
  text: string;
  names: string[];
}

/** Content-level summary of what the selected sections change on one machine. */
function diffRows(applied: SyncApplyResult["applied"], sections: readonly SyncSection[], t: Translate): DiffRow[] {
  const row = (label: string, { added, updated = [], removed }: { added: string[]; updated?: string[]; removed: string[] }): DiffRow => {
    const names = [...new Set([...added, ...updated, ...removed])];
    return {
      label,
      text: names.length === 0
        ? t("sync.diffInSync")
        : t("sync.diffChanges", { added: added.length, updated: updated.length, removed: removed.length }),
      names,
    };
  };
  const rows: DiffRow[] = [];
  if (sections.includes("providers")) rows.push(row("models.yml", applied.providers));
  if (sections.includes("roles")) {
    rows.push(row("config.yml · modelRoles", applied.roles));
    rows.push(row("config.yml · retry.fallbackChains", applied.fallbackChains));
  }
  if (sections.includes("enabledModels")) rows.push(row("config.yml · enabledModels", applied.enabledModels));
  return rows;
}

/** Step 3 body: one block per selected machine — status, findings, content diff. */
export function SyncDiffSummary({ machines, targets, sections, preflight, pushResults, excludedOAuthProviders = [] }: {
  machines: readonly Machine[];
  targets: readonly string[];
  sections: readonly SyncSection[];
  /** Dry-run results, keyed by machine id. */
  preflight: ReadonlyMap<string, TargetResult>;
  /** Real-run results once pushed; keyed by machine id. */
  pushResults: ReadonlyMap<string, TargetResult>;
  /** OAuth providers whose subscription-login configuration was excluded. */
  excludedOAuthProviders?: readonly string[];
}) {
  const { t } = useI18n();
  return (
    <>
      {targets.map((machineId) => {
        const machine = machines.find((entry) => entry.id === machineId);
        const pushed = pushResults.get(machineId);
        const result = pushed ?? preflight.get(machineId);
        const rows = result?.applied ? diffRows(result.applied, sections, t) : [];
        return (
          <div
            key={machineId}
            data-testid="sync-diff"
            data-machine={machineId}
            data-status={pushed?.status}
            style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", flexShrink: 0 }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
              <span style={{ fontSize: 12.5, fontWeight: 650, color: "var(--text)" }}>{machine?.name ?? machineId}</span>
              <span style={{ ...MONO, color: "var(--text-dim)", fontSize: 11 }}>{machineId}</span>
              <span style={{ flex: 1 }} />
              <span data-testid="sync-diff-status" style={{ ...MONO, color: pushed ? (pushed.status === "failed" ? TONE_COLOR.bad : pushed.status === "skipped" ? TONE_COLOR.warn : "var(--success, #3fb950)") : undefined }}>
                {pushed
                  ? `${t(STATUS_KEYS[pushed.status])}${pushed.status === "failed" || pushed.status === "skipped" ? `: ${pushed.detail}` : ""}`
                  : result
                    ? <PreflightStatus result={result} checking={false} expanded={false} />
                    : t("sync.noPreflightData")}
              </span>
            </div>
            {result && hasIssues(result) && (
              <div style={{ padding: "7px 12px", borderBottom: "1px solid var(--border)", ...MONO, fontSize: 11.5, lineHeight: 1.6 }}>
                <TargetIssues result={result} />
              </div>
            )}
            {rows.map((entry) => (
              <div key={entry.label} style={{ display: "flex", gap: 10, padding: "8px 12px", fontSize: 12.3, lineHeight: 1.6, borderBottom: "1px solid var(--border)" }}>
                <span style={{ ...MONO, width: 190, flexShrink: 0, color: "var(--text-dim)", fontSize: 11.8 }}>{entry.label}</span>
                <span style={{ minWidth: 0, lineHeight: 1.5, wordBreak: "break-word" }}>
                  {entry.text}
                  {entry.names.length > 0 && (
                    <span style={{ ...MONO, color: "var(--text-dim)", fontSize: 11 }}> · {entry.names.join(" · ")}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        );
      })}
      {excludedOAuthProviders.length > 0 ? (
        <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
          {t("sync.excludedActual", { providers: excludedOAuthProviders.join(" / ") })}
        </p>
      ) : null}
    </>
  );
}

export function SyncWizard({ open, onClose, initialSections, machines }: SyncWizardProps) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [sections, setSections] = useState<SyncSection[]>([...initialSections]);
  // `null` = every machine selected, the default (as in the confirmed mockup).
  const [selection, setSelection] = useState<string[] | null>(null);
  const targets = selection ?? machines.map((machine) => machine.id);
  const [running, setRunning] = useState<"preflight" | "push" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The preflight is the dry run over every machine (step 2); pushResults is
  // the real run over the selected ones (step 3).
  const [preflight, setPreflight] = useState<TargetResult[] | null>(null);
  const [pushResults, setPushResults] = useState<TargetResult[] | null>(null);
  const [sourceMachine, setSourceMachine] = useState<string | null>(null);
  const [excludedOAuthProviders, setExcludedOAuthProviders] = useState<string[]>([]);
  // The gateway visits targets one by one, so a preflight can take a while.
  // It never traps the user: stepping back or closing abandons the request.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // A fresh opening re-presets step 1 from the entry point that mounted us.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSections([...initialSections]);
    setSelection(null);
    setRunning(null);
    setPreflight(null);
    setPushResults(null);
    setError(null);
    setExcludedOAuthProviders([]);
  }, [open, initialSections]);

  const run = useCallback(async (mode: "preflight" | "push") => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(mode);
    setError(null);
    try {
      const response = await fetch(apiPath("/api/fleet/config-sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targets: mode === "preflight" ? machines.map((machine) => machine.id) : targets,
          sections,
          dryRun: mode === "preflight",
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as SyncRunResponse;
      if (!response.ok || data.error) {
        setError(data.error ?? `HTTP ${response.status}`);
        return;
      }
      setSourceMachine(data.sourceMachine ?? null);
      setExcludedOAuthProviders(data.excludedOAuthProviders ?? []);
      if (mode === "preflight") setPreflight(data.results ?? []);
      else setPushResults(data.results ?? []);
    } catch (caught) {
      // A superseded or abandoned run is not an error.
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      // Only the run that still owns the slot may release it.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setRunning(null);
      }
    }
  }, [machines, sections, targets]);

  const preflightByMachine = useMemo(() => new Map((preflight ?? []).map((result) => [result.machineId, result])), [preflight]);
  const pushByMachine = useMemo(() => new Map((pushResults ?? []).map((result) => [result.machineId, result])), [pushResults]);

  if (!open) return null;

  const pushing = running === "push";
  const toggleSection = (section: SyncSection) => {
    setSections((current) => current.includes(section)
      ? current.filter((entry) => entry !== section)
      : [...current, section]);
  };

  const toggleTarget = (machineId: string) => {
    setSelection(selection === null
      ? machines.map((machine) => machine.id).filter((id) => id !== machineId)
      : selection.includes(machineId)
        ? selection.filter((id) => id !== machineId)
        : [...selection, machineId]);
  };

  const next = () => {
    if (step === 1) {
      setStep(2);
      // The preflight runs by itself on entry, over every machine, so each row
      // carries its own readiness before anything is pushed.
      if (machines.length > 0) void run("preflight");
      return;
    }
    if (step === 2) {
      setStep(3);
      return;
    }
    if (pushResults) onClose();
    else void run("push");
  };

  const back = () => {
    // Leaving a step abandons an in-flight preflight: it would answer for
    // sections or machines the user is about to change. Stepping back from
    // step 2 also drops its results — the next entry runs it again.
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(null);
    setPushResults(null);
    setError(null);
    if (step === 2) setPreflight(null);
    setStep(Math.max(1, step - 1));
  };

  // Only a push blocks the wizard: it writes on the targets. A preflight in
  // flight just delays the push button on the last step.
  const nextDisabled = step === 1 ? sections.length === 0 : step === 2 ? targets.length === 0 : running !== null;
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
        if (!pushing && event.target === event.currentTarget) onClose();
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
            disabled={pushing}
            aria-label={t("sync.close")}
            style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: pushing ? "wait" : "pointer", fontSize: 16 }}
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

        {/* `flex: 1` + `minHeight: 0` are what make this the scroll region: a
            column flex child defaults to `min-height: auto`, so it grows to its
            content height, the dialog's `max-height` clips it, and `overflow-y:
            auto` never has anything to scroll. Cards keep their natural height
            (they set `flexShrink: 0`) and the body scrolls instead. */}
        <div
          data-testid="sync-body"
          style={{
            padding: "14px 18px",
            overflowY: "auto",
            overscrollBehavior: "contain",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            flex: 1,
            minHeight: 0,
          }}
        >
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
              ) : (
                <SyncTargetList
                  machines={machines}
                  targets={targets}
                  preflight={preflightByMachine}
                  checking={running === "preflight"}
                  onToggle={toggleTarget}
                />
              )}
              {machines.length > 0 ? (
                <button
                  type="button"
                  data-testid="sync-preflight-again"
                  onClick={() => void run("preflight")}
                  disabled={running !== null}
                  style={{ ...SECONDARY_BUTTON, alignSelf: "flex-start", cursor: running !== null ? "wait" : "pointer" }}
                >
                  {t("sync.preflightAgain")}
                </button>
              ) : null}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <SyncDiffSummary
                machines={machines}
                targets={targets}
                sections={sections}
                preflight={preflightByMachine}
                pushResults={pushByMachine}
                excludedOAuthProviders={excludedOAuthProviders}
              />
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

          {error ? (
            <p data-testid="sync-error" style={{ margin: 0, color: "var(--danger)", fontSize: 11 }}>
              {error}
            </p>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={back}
            disabled={step === 1 || pushing}
            style={{ ...SECONDARY_BUTTON, cursor: step === 1 || pushing ? "default" : "pointer" }}
          >
            {t("sync.back")}
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            disabled={pushing}
            style={{ ...SECONDARY_BUTTON, cursor: pushing ? "wait" : "pointer" }}
          >
            {t("sync.cancel")}
          </button>
          <button
            type="button"
            data-testid="sync-next"
            onClick={next}
            disabled={nextDisabled}
            style={{
              height: 30,
              padding: "0 14px",
              border: 0,
              borderRadius: 5,
              background: "var(--accent)",
              color: "var(--bg)",
              fontWeight: 700,
              fontSize: 11,
              cursor: nextDisabled ? "wait" : "pointer",
            }}
          >
            {step === 3 ? (pushResults ? t("sync.done") : t("sync.push", { count: targets.length })) : t("sync.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
