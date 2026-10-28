"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPath, LOCAL_MACHINE_ID } from "@/lib/api-path";
import { useMachineHealth, type SwitcherHealth } from "@/hooks/useMachineHealth";

// ---- API shapes -----------------------------------------------------------
// Local duplicates of the issue #85 service-control route contract
// (GET/POST /api/service/restart, machine-scoped via apiPath). The backend
// owns the canonical types in lib/api-types.ts; if these drift, typecheck
// will not catch it — keep them byte-compatible with the route.

/** One detached service-control run as reported by GET /api/service/restart. */
interface ServiceRunStatus {
  run_id: string | null;
  pid: number | null;
  running: boolean;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  log_path: string | null;
  log_tail: string[];
  mode: string | null;
}

/** GET /api/service/restart body (availability + current/last run). */
interface ServiceControlInfo {
  available: boolean;
  reason?: string;
  status?: ServiceRunStatus;
}

/** POST /api/service/restart 202 body. */
interface ServiceStartAck {
  started: boolean;
  run_id: string;
  pid: number;
}

/** POST /api/service/restart 400/409/502/503 body. */
interface ServiceErrorBody {
  error: string;
  status?: ServiceRunStatus;
}

/** The machine-list projection this modal needs; SafeMachine and UserVisibleMachine both satisfy it. */
export interface ServiceControlMachine {
  id: string;
  name: string;
  isLocal: boolean;
}

type Mode = "restart" | "upgrade";
type Phase =
  | "configure" // target + mode + warnings + two-step confirm
  | "running" // run accepted (or adopted from a 409); polling its status
  | "waiting" // status poll failed — waiting for the target service to answer again
  | "done"; // final status (exit code + tail) on screen

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function statusColor(status: SwitcherHealth | undefined): string {
  if (!status || status.state === "loading") return "var(--text-dim)";
  if (status.state === "online") return "var(--success)";
  if (status.state === "unauthorized") return "var(--warning)";
  return "var(--danger)";
}

function statusLabel(status: SwitcherHealth | undefined): string {
  if (!status || status.state === "loading") return "Checking";
  if (status.state === "online") return "Online";
  if (status.state === "unauthorized") return "Unauthorized";
  return "Offline";
}

/**
 * Fleet service restart/upgrade control (issue #85, UI half).
 *
 * Opened from the admin-only sidebar button next to the settings gear. The
 * run itself is executed by a detached backend run; this modal only triggers
 * it and watches: poll the run status every 2s, and when the target's service
 * stops answering (it is restarting), wait for it to come back — reloading
 * the page when the target is the machine serving it.
 */
export function ServiceControlModal({
  machines,
  onClose,
}: {
  machines: readonly ServiceControlMachine[];
  onClose: () => void;
}) {
  // machines is never empty — MachineProvider seeds [localMachine] and keeps
  // the local entry first on every refresh.
  const [targetId, setTargetId] = useState(() => machines[0]?.id ?? LOCAL_MACHINE_ID);
  const [mode, setMode] = useState<Mode>("restart");
  const [phase, setPhase] = useState<Phase>("configure");
  // null while checking; fail-closed: the confirm stays disabled until it is { ok: true }.
  const [availability, setAvailability] = useState<{ ok: true } | { ok: false; reason: string } | null>(null);
  const [info, setInfo] = useState<{ version: string | null; hostname: string | null; liveSessions: number | null }>({
    version: null,
    hostname: null,
    liveSessions: null,
  });
  const [armed, setArmed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const [status, setStatus] = useState<ServiceRunStatus | null>(null);

  const { health } = useMachineHealth(machines);

  const target = machines.find((machine) => machine.id === targetId) ?? machines[0] ?? null;
  const isGateway = machines.some((machine) => !machine.isLocal);
  // The machine serving THIS page is always the local entry: remotes are only
  // ever reached through the gateway's proxy, so restarting one cannot take
  // the page down. (Equals "machine id === current machine id" in the direct
  // browsing case, and stays correct when a remote workspace is open.)
  const isSelf = Boolean(target?.isLocal);
  // Every request goes through the resolved target so a stale selection
  // (machine list refreshed mid-modal) falls back to local, not a dead id.
  const effectiveTargetId = target?.id ?? LOCAL_MACHINE_ID;

  // Two-step confirm (MachinesConfig pattern): any change of target or mode
  // re-arms the safety latch.
  useEffect(() => {
    setArmed(false);
  }, [targetId, mode]);

  // Availability + per-target extras. Lazy, sequential, best-effort — the
  // modal never blocks on the extras; failures read as "unknown".
  useEffect(() => {
    if (phase !== "configure") return;
    const controller = new AbortController();
    setAvailability(null);
    setInfo({ version: null, hostname: null, liveSessions: null });
    void (async () => {
      try {
        const response = await fetch(apiPath("/api/service/restart", effectiveTargetId), {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({})) as Partial<ServiceControlInfo> & { error?: string };
        if (controller.signal.aborted) return;
        if (response.ok && body.available === true) {
          setAvailability({ ok: true });
        } else {
          setAvailability({ ok: false, reason: body.reason ?? body.error ?? `HTTP ${response.status}` });
        }
      } catch (caught) {
        if (!controller.signal.aborted) setAvailability({ ok: false, reason: errorMessage(caught) });
      }
      try {
        const response = await fetch(apiPath("/api/health", effectiveTargetId), { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const body = await response.json().catch(() => null) as { ompWebVersion?: string; hostname?: string } | null;
          if (!controller.signal.aborted && body) {
            setInfo((current) => ({ ...current, version: body.ompWebVersion ?? null, hostname: body.hostname ?? null }));
          }
        }
      } catch {
        // Unknown version — fine.
      }
      try {
        const response = await fetch(apiPath("/api/agent/running", effectiveTargetId), { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const body = await response.json().catch(() => null) as { runningSessionIds?: string[] } | null;
          const runningIds = body?.runningSessionIds;
          if (!controller.signal.aborted && Array.isArray(runningIds)) {
            setInfo((current) => ({ ...current, liveSessions: runningIds.length }));
          }
        }
      } catch {
        // Unknown live-session count — fine.
      }
    })();
    return () => controller.abort();
  }, [effectiveTargetId, phase]);

  // Run-status polling: every 2s while the run endpoint answers. The first
  // failed poll means the target's service is going down — hand over to the
  // waiting/recovery loop instead of hammering a dying endpoint.
  useEffect(() => {
    if (phase !== "running") return;
    const controller = new AbortController();
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(apiPath("/api/service/restart", effectiveTargetId), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json().catch(() => ({})) as Partial<ServiceControlInfo>;
        if (cancelled) return;
        if (body.status) {
          setStatus(body.status);
          if (!body.status.running) setPhase("done");
        }
      } catch {
        if (!cancelled) setPhase("waiting");
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [phase, effectiveTargetId]);

  // Recovery: the target service was restarting. Probe its /api/health until
  // it answers; for a remote, then fetch the final run status once. For the
  // machine serving this page, the app state died with it — reload.
  useEffect(() => {
    if (phase !== "waiting") return;
    const controller = new AbortController();
    let cancelled = false;
    const probeUrl = isSelf ? "/api/health" : apiPath("/api/health", effectiveTargetId);
    const intervalMs = isSelf ? 2_000 : 3_000;
    const probe = async () => {
      try {
        const response = await fetch(probeUrl, { cache: "no-store", signal: controller.signal });
        if (!response.ok || cancelled) return;
        if (isSelf) {
          window.location.reload();
          return;
        }
        const finalResponse = await fetch(apiPath("/api/service/restart", effectiveTargetId), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (cancelled) return;
        if (finalResponse.ok) {
          const body = await finalResponse.json().catch(() => ({})) as Partial<ServiceControlInfo>;
          if (body.status) setStatus(body.status);
        }
        if (!cancelled) setPhase("done");
      } catch {
        // Still down — the next tick retries.
      }
    };
    const timer = window.setInterval(() => { void probe(); }, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [phase, effectiveTargetId, isSelf]);

  const submit = useCallback(async () => {
    if (posting || phase !== "configure" || !target || !availability?.ok) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setPosting(true);
    setPostError(null);
    try {
      const response = await fetch(apiPath("/api/service/restart", target.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({})) as Partial<ServiceStartAck> & Partial<ServiceErrorBody>;
      if (response.status === 202 && body.started === true) {
        setStatus({
          run_id: body.run_id ?? null,
          pid: body.pid ?? null,
          running: true,
          exit_code: null,
          started_at: null,
          ended_at: null,
          log_path: null,
          log_tail: [],
          mode,
        });
        setPhase("running");
        return;
      }
      if (response.status === 409) {
        // A run is already in progress: adopt and watch it instead of making
        // the user re-arm the confirm for an action that cannot start.
        if (body.status) {
          setConflictNote("A service run is already in progress — showing its progress.");
          setStatus(body.status);
          setPhase("running");
        } else {
          setPostError(body.error ?? "A service run is already in progress.");
        }
        return;
      }
      setPostError(body.error ?? `HTTP ${response.status}`);
    } catch (caught) {
      setPostError(errorMessage(caught));
    } finally {
      setPosting(false);
    }
  }, [armed, availability, mode, phase, posting, target]);

  const liveKnown = info.liveSessions !== null;
  const liveCount = info.liveSessions ?? 0;
  const warnColor = liveKnown && liveCount > 0 ? "var(--danger)" : "var(--warning)";
  const configuring = phase === "configure";
  const confirmLabel = posting
    ? "Starting…"
    : armed
      ? mode === "upgrade" ? "Confirm upgrade?" : "Confirm restart?"
      : mode === "upgrade" ? "Upgrade & restart" : "Restart only";
  const metaBits = [
    info.version ? `omp-web ${info.version}` : null,
    info.hostname ?? null,
  ].filter(Boolean) as string[];
  const tail = status?.log_tail?.length ? status.log_tail.slice(-10) : [];

  const renderTargetRow = (machine: ServiceControlMachine) => {
    const selected = machine.id === target?.id;
    const dot = health[machine.id];
    return (
      <button
        key={machine.id}
        type="button"
        role="option"
        aria-selected={selected}
        disabled={!configuring}
        onClick={() => { setTargetId(machine.id); }}
        style={{
          width: "100%", minHeight: 32, padding: "5px 8px",
          display: "flex", alignItems: "center", gap: 7,
          border: 0, borderBottom: "1px solid var(--border)",
          background: selected ? "var(--bg-selected)" : "transparent",
          color: selected ? "var(--text)" : "var(--text-muted)",
          cursor: configuring ? "pointer" : "default",
          font: "10px var(--font-mono)", textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: statusColor(dot) }} />
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {machine.isLocal ? `This machine · ${machine.name}` : machine.name}
        </span>
        {machine.isLocal
          ? <span style={{ color: statusColor(dot), fontSize: 9 }}>{statusLabel(dot)}</span>
          : <span style={{ color: "var(--text-dim)", fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{machine.id}</span>}
      </button>
    );
  };

  const renderModeRow = (value: Mode, label: string, description: string) => {
    const selected = mode === value;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={!configuring}
        onClick={() => { setMode(value); }}
        style={{
          width: "100%", padding: "7px 8px",
          display: "flex", alignItems: "flex-start", gap: 7,
          border: 0, borderBottom: "1px solid var(--border)",
          background: selected ? "var(--bg-selected)" : "transparent",
          color: selected ? "var(--text)" : "var(--text-muted)",
          cursor: configuring ? "pointer" : "default",
          font: "10px var(--font-mono)", textAlign: "left",
        }}
      >
        <span aria-hidden="true" style={{ marginTop: 2, width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", border: "1.5px solid " + (selected ? "var(--accent)" : "var(--text-dim)"), background: selected ? "var(--accent)" : "transparent" }} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontWeight: selected ? 700 : 500 }}>{label}</span>
          <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", lineHeight: 1.4 }}>{description}</span>
        </span>
      </button>
    );
  };

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.4)",
      }}
      onMouseDown={(event) => {
        if (!posting && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="service-control-title"
        style={{
          width: 460,
          maxWidth: "100%",
          maxHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg-panel)",
          boxShadow: "0 12px 36px rgba(0,0,0,0.24)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--border)" }}>
          <div id="service-control-title" style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            Service restart / upgrade
          </div>
          {configuring && target && (
            <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {target.isLocal ? `This machine · ${target.name}` : target.name}
              {metaBits.length > 0 ? ` — ${metaBits.join(" · ")}` : ""}
            </div>
          )}
        </div>

        <div style={{ minHeight: 0, overflowY: "auto", padding: "14px 18px" }}>
          {configuring && (
            <>
              {isGateway ? (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 6 }}>Target</div>
                  <div role="listbox" aria-label="Restart target" style={{ overflow: "hidden", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)" }}>
                    {machines.map(renderTargetRow)}
                  </div>
                </div>
              ) : (
                <div style={{ padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", font: "10px var(--font-mono)", color: "var(--text-muted)" }}>
                  {target ? `This machine · ${target.name}` : "This machine"}
                  {metaBits.length > 0 ? <span style={{ color: "var(--text-dim)" }}> — {metaBits.join(" · ")}</span> : null}
                </div>
              )}

              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 6 }}>Action</div>
                <div role="radiogroup" aria-label="Service action" style={{ overflow: "hidden", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)" }}>
                  {renderModeRow("restart", "Restart only", "Restart the omp-web systemd service.")}
                  {renderModeRow("upgrade", "Upgrade & restart", "Install the latest omp-web package via apt, then restart the service.")}
                </div>
              </div>

              <div style={{ marginTop: 12, padding: "8px 10px", border: `1px solid ${warnColor}`, borderRadius: 5, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ color: warnColor, fontSize: 12, lineHeight: 1.5 }}>
                  Restarting terminates all live agent sessions on this machine
                  {liveKnown ? ` — Live sessions: ${liveCount}` : "."}
                </div>
                {isSelf && (
                  <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                    This page is served by this machine — it will disconnect and recover automatically.
                  </div>
                )}
                {mode === "upgrade" && (
                  <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                    The upgrade runs apt before restarting and can take several minutes.
                  </div>
                )}
              </div>

              {availability && !availability.ok && (
                <div role="alert" style={{ marginTop: 10, color: "var(--danger)", fontSize: 12, lineHeight: 1.5 }}>
                  Not available: {availability.reason}
                </div>
              )}
              {postError && (
                <div role="alert" style={{ marginTop: 10, color: "var(--danger)", fontSize: 12, lineHeight: 1.5 }}>
                  {postError}
                </div>
              )}
            </>
          )}

          {!configuring && (
            <>
              {conflictNote && (
                <div style={{ marginBottom: 10, padding: "8px 10px", border: "1px solid var(--warning)", borderRadius: 5, color: "var(--warning)", fontSize: 12, lineHeight: 1.5 }}>
                  {conflictNote}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, font: "11px var(--font-mono)", color: "var(--text-muted)", flexWrap: "wrap" }}>
                {status?.run_id && <span title="Run id">run {status.run_id}</span>}
                {status?.mode && <span style={{ color: "var(--text-dim)" }}>{status.mode}</span>}
                <span
                  style={{
                    color: phase === "done"
                      ? status && status.exit_code === 0
                        ? "var(--success)"
                        : "var(--danger)"
                      : "var(--text)",
                    fontWeight: 600,
                  }}
                >
                  {phase === "running"
                    ? "Running…"
                    : phase === "waiting"
                      ? isSelf ? "Waiting for the service to come back — the page will reload…" : "Waiting for the service to come back…"
                      : status
                        ? `Finished — exit code ${status.exit_code ?? "unknown"}`
                        : "Finished"}
                </span>
              </div>
              {(tail.length > 0 || phase !== "done") && (
                <div
                  style={{
                    marginTop: 10,
                    padding: "8px 10px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    lineHeight: 1.5,
                    whiteSpace: "pre",
                    overflowX: "auto",
                    maxHeight: 200,
                    overflowY: "auto",
                  }}
                  aria-label="Run log tail"
                >
                  {tail.length > 0 ? tail.join("\n") : "Waiting for output…"}
                </div>
              )}
            </>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={posting}
            style={{
              height: 32,
              padding: "0 12px",
              border: "1px solid var(--border)",
              borderRadius: 5,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: posting ? "not-allowed" : "pointer",
              fontSize: 12,
            }}
          >
            {configuring ? "Cancel" : "Close"}
          </button>
          {configuring && (
            <button
              type="button"
              onClick={() => { void submit(); }}
              disabled={posting || !availability?.ok || !target}
              style={{
                height: 32,
                padding: "0 12px",
                border: "1px solid var(--danger)",
                borderRadius: 5,
                background: "var(--danger)",
                color: "white",
                cursor: posting || !availability?.ok || !target ? "not-allowed" : "pointer",
                opacity: posting || !availability?.ok || !target ? 0.7 : 1,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
