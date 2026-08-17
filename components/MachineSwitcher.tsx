"use client";

import { useEffect, useRef, useState } from "react";
import { apiPath } from "@/lib/api-path";
import { useMachines } from "@/lib/machine-context";
import { useNavigation } from "./NavigationProvider";
import type { SafeMachine, UserVisibleMachine } from "@/lib/api-types";

type SwitcherHealth = {
  state: "loading" | "online" | "offline" | "unauthorized";
  reason?: string;
};

function displayStatus(status: SwitcherHealth | undefined): string {
  if (!status || status.state === "loading") return "Checking";
  if (status.state === "online") return "Online";
  if (status.state === "unauthorized") return "Unauthorized";
  return "Offline";
}

function statusColor(status: SwitcherHealth | undefined): string {
  if (!status || status.state === "loading") return "var(--text-dim)";
  if (status.state === "online") return "var(--success)";
  if (status.state === "unauthorized") return "var(--warning)";
  return "var(--danger)";
}

async function probe(machine: SafeMachine | UserVisibleMachine, signal: AbortSignal): Promise<SwitcherHealth> {
  try {
    const response = await fetch(apiPath("/api/health", machine.id), { cache: "no-store", signal });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (response.status === 401 || response.status === 403) return { state: "unauthorized", reason: body.error ?? "The configured credential was rejected." };
    if (!response.ok || !body.ok) return { state: "offline", reason: body.error ?? `HTTP ${response.status}` };
    return { state: "online" };
  } catch (caught) {
    return { state: "offline", reason: caught instanceof DOMException && caught.name === "AbortError" ? "Connection timed out." : caught instanceof Error ? caught.message : String(caught) };
  }
}

export function MachineSwitcher({ onManageMachines }: { onManageMachines: () => void }) {
  const { machineId, machines, loading } = useMachines();
  const { navigate } = useNavigation();
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<Record<string, SwitcherHealth>>({});
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentMachine = machines.find((machine) => machine.id === machineId) ?? machines[0];
  const remote = Boolean(currentMachine && !currentMachine.isLocal);
  const singleMachine = machines.length <= 1;

  useEffect(() => {
    if (!machines.length) return;
    const controllers = machines.map(() => new AbortController());
    const timers = controllers.map((controller) => window.setTimeout(() => controller.abort(), 6_000));
    void Promise.all(machines.map((machine, index) => probe(machine, controllers[index].signal).then((status) => [machine.id, status] as const)))
      .then((results) => setHealth(Object.fromEntries(results)))
      .finally(() => timers.forEach((timer) => window.clearTimeout(timer)));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      controllers.forEach((controller) => controller.abort());
    };
  }, [machines]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  const selectMachine = (id: string) => {
    // Machine switch drops project/session — cross-machine ids are meaningless.
    navigate({ machineId: id, project: null, session: null }, { history: "push" });
    setDismissedError(null);
    setOpen(false);
  };

  const currentStatus = currentMachine ? health[currentMachine.id] : undefined;
  const showCurrentError = remote && currentStatus?.state !== "online" && currentStatus?.state !== "loading" && dismissedError !== currentMachine.id;

  if (!currentMachine) return null;

  return (
    <div ref={rootRef} style={{ position: "relative", marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={loading}
          onClick={() => setOpen((value) => !value)}
          title={singleMachine ? "Local machine" : `Machine: ${currentMachine.name}`}
          style={{ minWidth: 0, flex: 1, height: 28, padding: "0 8px", display: "flex", alignItems: "center", gap: 7, border: remote ? "1px solid var(--accent)" : "1px solid var(--border)", borderRadius: 6, background: remote ? "var(--bg-selected)" : "transparent", color: remote ? "var(--accent)" : "var(--text-muted)", cursor: loading ? "wait" : "pointer", font: "10px var(--font-mono)", textAlign: "left" }}
        >
          <span aria-hidden="true" style={{ width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: statusColor(currentStatus) }} />
          <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentMachine.name}</span>
          {remote && <span style={{ fontSize: 8, letterSpacing: "0.06em", textTransform: "uppercase" }}>Remote machine</span>}
          {!singleMachine && <span aria-hidden="true">⌄</span>}
        </button>
        {singleMachine && <button type="button" onClick={onManageMachines} title="Manage machines" style={{ height: 28, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: "pointer", font: "10px var(--font-mono)" }}>Manage machines</button>}
      </div>
      {showCurrentError && <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 6, padding: "6px 7px", border: "1px solid var(--danger)", borderRadius: 5, color: "var(--danger)", font: "10px/1.35 var(--font-mono)" }}>
        <span style={{ minWidth: 0, flex: 1 }}>{currentMachine.name} is {displayStatus(currentStatus).toLowerCase()}: {currentStatus?.reason}</span>
        <button type="button" aria-label={`Dismiss ${currentMachine.name} connection error`} onClick={() => setDismissedError(currentMachine.id)} style={{ padding: 0, border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>
      </div>}
      {open && !singleMachine && <div role="listbox" aria-label="Choose machine" style={{ position: "absolute", zIndex: 20, top: 34, left: 0, right: 0, overflow: "hidden", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-panel)", boxShadow: "0 10px 28px color-mix(in srgb, var(--text) 16%, transparent)" }}>
        {machines.map((machine) => {
          const status = health[machine.id];
          const active = machine.id === currentMachine.id;
          return <button key={machine.id} type="button" role="option" aria-selected={active} onClick={() => selectMachine(machine.id)} style={{ width: "100%", minHeight: 34, padding: "6px 8px", display: "flex", alignItems: "center", gap: 7, border: 0, borderBottom: "1px solid var(--border)", background: active ? "var(--bg-selected)" : "transparent", color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", font: "10px var(--font-mono)", textAlign: "left" }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: statusColor(status) }} />
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{machine.name}</span>
            <span style={{ color: statusColor(status), fontSize: 9 }}>{displayStatus(status)}</span>
          </button>;
        })}
        <button type="button" onClick={() => { setOpen(false); onManageMachines(); }} style={{ width: "100%", height: 32, border: 0, background: "var(--bg)", color: "var(--accent)", cursor: "pointer", font: "700 10px var(--font-mono)", textAlign: "left", padding: "0 8px" }}>Manage machines</button>
      </div>}
    </div>
  );
}
