"use client";

/**
 * The Home landing page (issue #15). Replaces the whole app surface — no
 * sidebar, no file panel: it renders as a sibling of `AppShellBody`, which
 * owns all of those. Top section: quick access grouped by machine → project
 * (visible projects only — the gateway's #14 proxy filter shapes remote
 * lists for non-admins). Bottom section: once a project is selected, its
 * weekly conversation calendar (`HomeCalendar`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { mostRecentProjectRoots } from "@/lib/project-recency";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { useMachines } from "@/lib/machine-context";
import { useSessionList } from "@/lib/session-list-context";
import { HomeCalendar } from "./HomeCalendar";

interface MachineProjects {
  machineId: string;
  machineName: string;
  offline: boolean;
  /** Project root → sessions, most-recently-active project first. */
  projects: Map<string, SessionInfo[]>;
  lastActivityByProject: Map<string, string>;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1) || trimmed;
}

export function HomePage() {
  const { locale, t } = useI18n();
  const { machines, loading: machinesLoading } = useMachines();
  const { fetchSessionsFor } = useSessionList();
  const [groups, setGroups] = useState<MachineProjects[] | null>(null);
  const [selected, setSelected] = useState<{ machineId: string; project: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async (force: boolean) => {
    if (machinesLoading) return;
    const generation = ++loadGenerationRef.current;
    const results = await Promise.all(
      machines.map(async (machine): Promise<MachineProjects> => {
        const base: MachineProjects = {
          machineId: machine.id,
          machineName: machine.name || machine.id,
          offline: false,
          projects: new Map(),
          lastActivityByProject: new Map(),
        };
        let sessions: SessionInfo[];
        try {
          sessions = await fetchSessionsFor(machine.id, force);
        } catch {
          return { ...base, offline: true };
        }
        const byProject = new Map<string, SessionInfo[]>();
        for (const session of sessions) {
          const root = session.projectRoot ?? session.cwd;
          const bucket = byProject.get(root);
          if (bucket) bucket.push(session);
          else byProject.set(root, [session]);
        }
        const ordered = mostRecentProjectRoots(sessions);
        const projects = new Map<string, SessionInfo[]>();
        const lastActivityByProject = new Map<string, string>();
        for (const root of ordered) {
          const inProject = byProject.get(root) ?? [];
          projects.set(root, inProject);
          const newest = inProject.reduce((best, s) => (s.modified > best ? s.modified : best), inProject[0].modified);
          lastActivityByProject.set(root, newest);
        }
        return { ...base, projects, lastActivityByProject };
      }),
    );
    if (generation !== loadGenerationRef.current) return;
    setGroups(results);
  }, [machines, machinesLoading, fetchSessionsFor]);

  useEffect(() => {
    void load(reloadKey > 0);
  }, [load, reloadKey]);

  const selectedGroup = useMemo(
    () => groups?.find((g) => g.machineId === selected?.machineId) ?? null,
    [groups, selected],
  );
  const selectedSessions = useMemo(
    () => (selected && selectedGroup ? selectedGroup.projects.get(selected.project) ?? [] : []),
    [selected, selectedGroup],
  );

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)",
      overflowY: "auto",
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "48px 28px 80px" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {t("home.welcome.title")}
          </h1>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            title={t("home.refresh")}
            style={{
              background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text-muted)",
              cursor: "pointer", height: 30, padding: "0 12px", borderRadius: 7, fontSize: 12.5, flexShrink: 0,
            }}
          >
            {t("home.refresh")}
          </button>
        </header>
        <p style={{ margin: "0 0 8px", color: "var(--text-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
          {t("home.welcome.body")}
        </p>

        {selected ? (
          <>
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={{
                background: "none", border: "none", color: "var(--accent)", cursor: "pointer",
                fontSize: 12.5, padding: "8px 0 0",
              }}
            >
              ‹ {t("home.quickAccess")}
            </button>
            <div style={{ margin: "24px 0 0", color: "var(--text-dim)", fontSize: 12.5 }}>
              {selectedGroup?.machineName} · {selected.project}
            </div>
            <HomeCalendar machineId={selected.machineId} project={selected.project} sessions={selectedSessions} />
          </>
        ) : (
          <>
            <h2 style={{ margin: "28px 0 10px", color: "var(--text-muted)", fontSize: 13, fontWeight: 600, letterSpacing: "0.01em" }}>
              {t("home.quickAccess")}
            </h2>
            {groups === null && <div style={{ color: "var(--text-dim)", fontSize: 13 }}>…</div>}
            {groups?.map((group) => (
              <div key={group.machineId} style={{ marginBottom: 22 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{group.machineName}</span>
                  {group.offline && (
                    <span style={{ fontSize: 11.5, color: "var(--danger)", border: "1px solid var(--danger)", borderRadius: 999, padding: "0 7px" }}>
                      {t("home.machineOffline")}
                    </span>
                  )}
                </div>
                {group.projects.size === 0 && !group.offline && (
                  <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>{t("home.noProjects")}</div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
                  {[...group.projects.entries()].map(([root, projectSessions]) => {
                    const last = group.lastActivityByProject.get(root) ?? projectSessions[0]?.modified;
                    return (
                      <button
                        key={root}
                        type="button"
                        onClick={() => setSelected({ machineId: group.machineId, project: root })}
                        title={`${group.machineName} · ${root}`}
                        aria-label={t("home.openProject")}
                        style={{
                          textAlign: "left", background: "var(--bg-panel)", border: "1px solid var(--border)",
                          borderRadius: 10, padding: "12px 14px", cursor: "pointer",
                          display: "flex", flexDirection: "column", gap: 4,
                        }}
                        onMouseEnter={(event) => { event.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 40%, var(--border))"; }}
                        onMouseLeave={(event) => { event.currentTarget.style.borderColor = "var(--border)"; }}
                      >
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {basename(root)}
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                          {projectSessions.length} · {last ? formatRelativeTime(new Date(last), locale) : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
