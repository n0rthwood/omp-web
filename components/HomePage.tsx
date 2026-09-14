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
import { apiPath, machineStorageKey } from "@/lib/api-path";
import { useI18n } from "@/hooks/useI18n";
import { useMachines } from "@/lib/machine-context";
import { useSessionList } from "@/lib/session-list-context";
import { HomeCalendar } from "./HomeCalendar";
import { HomeSessionRow, type HomeSessionRowEntry } from "./HomeSessionRow";
import { useNavigation } from "./NavigationProvider";

const RECENT_LIMIT = 6;
const AGGREGATE_GROUP_SESSION_LIMIT = 8;
const EXPANDED_PROJECT_GROUPS_STORAGE_KEY = "omp-web:home-expanded-project-groups";



interface MachineProjects {
  machineId: string;
  machineName: string;
  offline: boolean;
  /** Project root → sessions, most-recently-active project first. */
  projects: Map<string, SessionInfo[]>;
  lastActivityByProject: Map<string, string>;
}

type AggregateSessionEntry = HomeSessionRowEntry;

interface AggregateProjectGroup {
  /** Project basename — the visual grouping key. Session buckets stay keyed
   *  by (machineId, projectRoot) via `AggregateSessionEntry`, so two
   *  machines sharing a path are never merged into one session array (issue
   *  #38) — only clustered under a shared heading, disambiguated per-row by
   *  the machine tag. */
  key: string;
  displayName: string;
  sessions: AggregateSessionEntry[];
  machineCount: number;
  lastActivity: string;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1) || trimmed;
}

function loadExpandedProjectGroups(storageKey: string): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((key): key is string => typeof key === "string"))
      : null;
  } catch {
    return null;
  }
}

function saveExpandedProjectGroups(storageKey: string, expandedGroups: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...expandedGroups]));
  } catch {
    // Ignore storage quota and privacy-mode errors.
  }
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.1s ease-in-out" }}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function LoaderIcon({ size = 14 }: { size?: number }) {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}


export function HomePage() {
  const { locale, t, setLocale, supportedLocales } = useI18n();
  const { machines, loading: machinesLoading } = useMachines();
  const { fetchSessionsFor } = useSessionList();
  const [groups, setGroups] = useState<MachineProjects[] | null>(null);
  const groupsRef = useRef<MachineProjects[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const loadGenerationRef = useRef(0);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const languageWrapperRef = useRef<HTMLDivElement | null>(null);
  const { navigate } = useNavigation();
  const [viewMode, setViewMode] = useState<"aggregate" | "single-machine">("aggregate");
  const expandedGroupStorageKey = machineStorageKey(EXPANDED_PROJECT_GROUPS_STORAGE_KEY);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string> | null>(null);
  const [shownAllGroupKeys, setShownAllGroupKeys] = useState<Set<string>>(() => new Set<string>());
  const aggregateGroupRefs = useRef(new Map<string, HTMLElement>());
  const [expandedGroupsStorageKey, setExpandedGroupsStorageKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newConvError, setNewConvError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [chooserKey, setChooserKey] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    if (machinesLoading) return;
    const generation = ++loadGenerationRef.current;
    if (force) setRefreshing(true);
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
          const prev = groupsRef.current?.find((g) => g.machineId === machine.id);
          if (prev && prev.projects.size > 0) return { ...prev, machineName: base.machineName, offline: true };
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
    groupsRef.current = results;
    setGroups(results);
    setRefreshing(false);
  }, [machines, machinesLoading, fetchSessionsFor]);

  const createConversation = useCallback(
    async (machineId: string, projectRoot: string, machineName: string) => {
      setCreating(true);
      setNewConvError(null);
      try {
        const res = await fetch(apiPath("/api/agent/new", machineId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: projectRoot, type: "ensure_session" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.success || !data.sessionId) {
          const reason = data?.error ?? `Request failed (${res.status})`;
          setNewConvError(t("home.newConversationFailed", { name: machineName, reason }));
          return;
        }
        navigate({ machineId, project: projectRoot, session: data.sessionId }, { history: "push" });
      } catch (err) {
        setNewConvError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setCreating(false);
      }
    },
    [navigate, t],
  );

  const setPickerOpen = (key: string | null) => {
    if (chooserKey === key) return;
    setChooserKey(key);
  };

  // Close the New Conversation picker on outside pointer or Escape.
  useEffect(() => {
    if (chooserKey === null) return;
    const onPointer = (event: PointerEvent) => {
      const ref = aggregateGroupRefs.current.get(chooserKey);
      const target = event.target as Node;
      if (ref && ref.contains(target)) return;
      setChooserKey(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChooserKey(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [chooserKey]);

  useEffect(() => {
    void load(reloadKey > 0);
  }, [load, reloadKey]);

  // Auto-select the machine (first online one with projects) once groups load.
  useEffect(() => {
    if (!groups || groups.length === 0) return;
    if (groups.some((g) => g.machineId === selectedMachineId)) return;
    const best =
      groups.find((g) => !g.offline && g.projects.size > 0)
      ?? groups.find((g) => g.projects.size > 0)
      ?? groups[0];
    setSelectedMachineId(best.machineId);
    setSelectedProject(null);
  }, [groups, selectedMachineId]);

  const selectedGroup = useMemo(
    () => groups?.find((g) => g.machineId === selectedMachineId) ?? null,
    [groups, selectedMachineId],
  );
  const projectRoots = useMemo(
    () => (selectedGroup ? [...selectedGroup.projects.keys()] : []),
    [selectedGroup],
  );

  // Auto-select the machine's most-recent project (Map preserves recency order).
  useEffect(() => {
    if (!selectedGroup) return;
    if (projectRoots.length === 0) {
      if (selectedProject !== null) setSelectedProject(null);
      return;
    }
    if (!selectedProject || !selectedGroup.projects.has(selectedProject)) {
      setSelectedProject(projectRoots[0]);
    }
  }, [selectedGroup, projectRoots, selectedProject]);

  const selectedSessions = useMemo(
    () => (selectedGroup && selectedProject ? selectedGroup.projects.get(selectedProject) ?? [] : []),
    [selectedGroup, selectedProject],
  );

  const recentEntries = useMemo<AggregateSessionEntry[]>(() => {
    if (!groups) return [];
    const entries: AggregateSessionEntry[] = [];
    for (const group of groups) {
      for (const [projectRoot, sessions] of group.projects) {
        entries.push(...sessions.map((session) => ({
          session,
          machineId: group.machineId,
          machineName: group.machineName,
          machineOffline: group.offline,
          projectRoot,
        })));
      }
    }
    return entries
      .sort((a, b) => b.session.modified.localeCompare(a.session.modified))
      .slice(0, RECENT_LIMIT);
  }, [groups]);

  const aggregateGroups = useMemo<AggregateProjectGroup[]>(() => {
    if (!groups) return [];
    const byName = new Map<string, AggregateSessionEntry[]>();
    for (const group of groups) {
      for (const [root, sessions] of group.projects) {
        const entries: AggregateSessionEntry[] = sessions.map((session) => ({
          session,
          machineId: group.machineId,
          machineName: group.machineName,
          machineOffline: group.offline,
          projectRoot: root,
        }));
        const name = basename(root);
        const bucket = byName.get(name);
        if (bucket) bucket.push(...entries);
        else byName.set(name, entries);
      }
    }
    const result: AggregateProjectGroup[] = [];
    for (const [displayName, sessions] of byName) {
      sessions.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
      const machineCount = new Set(sessions.map((entry) => entry.machineId)).size;
      result.push({ key: displayName, displayName, sessions, machineCount, lastActivity: sessions[0]?.session.modified ?? "" });
    }
    result.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return result;
  }, [groups]);
  useEffect(() => {
    if (groups === null || aggregateGroups.length === 0 || expandedGroupsStorageKey === expandedGroupStorageKey) return;

    const knownGroupKeys = new Set(aggregateGroups.map((group) => group.key));
    const persistedGroups = loadExpandedProjectGroups(expandedGroupStorageKey);
    const restoredGroups = persistedGroups
      ? new Set([...persistedGroups].filter((key) => knownGroupKeys.has(key)))
      : new Set(aggregateGroups.slice(0, 1).map((group) => group.key));

    setExpandedGroupsStorageKey(expandedGroupStorageKey);
    setExpandedGroupKeys(restoredGroups);
    setShownAllGroupKeys(new Set<string>());
  }, [aggregateGroups, expandedGroupStorageKey, expandedGroupsStorageKey, groups]);

  useEffect(() => {
    if (expandedGroupKeys === null || expandedGroupsStorageKey !== expandedGroupStorageKey) return;
    saveExpandedProjectGroups(expandedGroupStorageKey, expandedGroupKeys);
  }, [expandedGroupKeys, expandedGroupStorageKey, expandedGroupsStorageKey]);

  const toggleAggregateGroup = useCallback((key: string) => {
    setExpandedGroupKeys((current) => {
      const next = new Set(current ?? aggregateGroups.slice(0, 1).map((group) => group.key));
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setShownAllGroupKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, [aggregateGroups]);

  const expandAndScrollToAggregateGroup = useCallback((key: string) => {
    setExpandedGroupKeys((current) => {
      const initial = current ?? new Set(aggregateGroups.slice(0, 1).map((group) => group.key));
      if (initial.has(key)) return initial;
      const next = new Set(initial);
      next.add(key);
      return next;
    });
    requestAnimationFrame(() => {
      aggregateGroupRefs.current.get(key)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [aggregateGroups]);


  // Close the language dropdown on outside click or Escape.
  useEffect(() => {
    if (!languageMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (languageWrapperRef.current && !languageWrapperRef.current.contains(e.target as Node)) {
        setLanguageMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLanguageMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [languageMenuOpen]);

  const chipRowStyle: React.CSSProperties = {
    display: "flex",
    gap: 6,
    overflowX: "auto",
    paddingBottom: 2,
    scrollbarWidth: "thin",
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
  flexShrink: 0,
  height: 26,
  padding: "0 11px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  cursor: "pointer",
  background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "var(--bg-hover)",
  color: active ? "var(--accent)" : "var(--text-muted)",
  border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "var(--border)"}`,
  whiteSpace: "nowrap",
  });

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)",
      display: "flex", flexDirection: "column",
    }}>
      <header style={{
        flexShrink: 0,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        padding: "14px 20px 10px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {t("home.title")}
          </h1>
          <div style={{ flex: 1 }} />
          <div
            role="group"
            aria-label={t("home.viewMode")}
            title={t("home.viewMode")}
            style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", flexShrink: 0 }}
          >
            {(["aggregate", "single-machine"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
                style={{
                  height: 28,
                  padding: "0 10px",
                  fontSize: 12,
                  cursor: "pointer",
                  border: "none",
                  background: viewMode === mode ? "var(--accent)" : "var(--bg-hover)",
                  color: viewMode === mode ? "#fff" : "var(--text-muted)",
                  fontWeight: viewMode === mode ? 600 : 500,
                }}
              >
                {t(mode === "aggregate" ? "home.viewAggregate" : "home.viewSingleMachine")}
              </button>
            ))}
          </div>
          <div ref={languageWrapperRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setLanguageMenuOpen((open) => !open)}
              title={t("common.language")}
              aria-label={t("common.language")}
              aria-haspopup="menu"
              aria-expanded={languageMenuOpen}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, padding: 0, borderRadius: 7,
                background: languageMenuOpen ? "var(--bg-selected)" : "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: languageMenuOpen ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m5 8 6 6" />
                <path d="m4 14 6-6 2-3" />
                <path d="M2 5h12" />
                <path d="M7 2h1" />
                <path d="m22 22-5-10-5 10" />
                <path d="M14 18h6" />
              </svg>
            </button>
            {languageMenuOpen && (
              <div
                role="menu"
                aria-label={t("common.language")}
                style={{
                  position: "absolute", top: "calc(100% + 4px)", right: 0,
                  minWidth: 160, maxWidth: "calc(100vw - 40px)",
                  background: "var(--bg-panel)", border: "1px solid var(--border)",
                  borderRadius: 7, overflow: "hidden", padding: 4, zIndex: 200,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                }}
              >
                {supportedLocales.map((plugin) => (
                  <button
                    key={plugin.id}
                    type="button"
                    onClick={() => {
                      setLocale(plugin.id as typeof locale);
                      setLanguageMenuOpen(false);
                    }}
                    role="menuitemradio"
                    aria-checked={locale === plugin.id}
                    style={{
                      display: "flex", alignItems: "center",
                      width: "100%", height: 34, padding: "0 10px",
                      border: "none", borderRadius: 4,
                      background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                      color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span>{plugin.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              title={t("home.refresh")}
              aria-label={t("home.refresh")}
              disabled={refreshing}
              style={{
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: refreshing ? "var(--accent)" : "var(--text-muted)",
                cursor: refreshing ? "progress" : "pointer",
                height: 28,
                padding: refreshing ? 0 : "0 12px",
                borderRadius: 7,
                fontSize: 12.5,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {refreshing ? <LoaderIcon size={16} /> : t("home.refresh")}
            </button>
        </div>
        <div style={chipRowStyle}>
          {groups?.map((group) => (
            <div
              key={group.machineId}
              style={{
                display: "flex",
                flexShrink: 0,
                height: 28,
                borderRadius: 999,
                overflow: "hidden",
                background: viewMode === "single-machine" && group.machineId === selectedMachineId
                  ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                  : "var(--bg-hover)",
                color: viewMode === "single-machine" && group.machineId === selectedMachineId ? "var(--accent)" : "var(--text-muted)",
                border: `1px solid ${viewMode === "single-machine" && group.machineId === selectedMachineId ? "color-mix(in srgb, var(--accent) 45%, var(--border))" : "var(--border)"}`,
              }}
            >
              <button
                type="button"
                onClick={() => { setSelectedMachineId(group.machineId); setSelectedProject(null); setViewMode("single-machine"); }}
                title={group.offline ? `${group.machineName} (${t("home.machineOffline")})` : group.machineName}
                aria-pressed={viewMode === "single-machine" && group.machineId === selectedMachineId}
                style={{
                  minWidth: 0, height: "100%", padding: "0 11px", border: "none",
                  background: "transparent", color: "inherit", cursor: "pointer",
                  fontSize: 12, fontWeight: viewMode === "single-machine" && group.machineId === selectedMachineId ? 600 : 500,
                  whiteSpace: "nowrap", opacity: group.offline ? 0.55 : 1,
                }}
              >
                {group.machineName}
                {group.offline && <span style={{ color: "var(--danger)", marginLeft: 6 }}>·</span>}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate({ machineId: group.machineId, project: null, session: null }, { history: "push" });
                }}
                disabled={group.offline}
                aria-disabled={group.offline}
                aria-label={t("home.openMachine", { name: group.machineName })}
                title={group.offline ? t("home.machineOffline") : t("home.openMachine", { name: group.machineName })}
                style={{
                  width: 28, minWidth: 28, height: 28, padding: 0,
                  border: "none", borderLeft: "1px solid var(--border)",
                  background: "transparent", color: "inherit",
                  cursor: group.offline ? "not-allowed" : "pointer",
                  opacity: group.offline ? 0.5 : 1,
                  fontSize: 14, lineHeight: 1,
                }}
              >
                ↗
              </button>
            </div>
          ))}
          {groups === null && <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "8px 0", width: "100%" }}><LoaderIcon size={16} /></span>}
        </div>
        {viewMode === "single-machine" && (
        <div style={{ ...chipRowStyle, marginTop: 6 }}>
          {selectedGroup && projectRoots.length > 0 && projectRoots.map((root) => {
            const count = selectedGroup.projects.get(root)?.length ?? 0;
            const last = selectedGroup.lastActivityByProject.get(root);
            return (
              <button
                key={root}
                type="button"
                onClick={() => setSelectedProject(root)}
                title={`${selectedGroup.machineName} · ${root}`}
                aria-pressed={root === selectedProject}
                style={chipStyle(root === selectedProject)}
              >
                {basename(root)} {count}
                {last && <span style={{ color: "var(--text-dim)", marginLeft: 6, fontWeight: 400 }}>
                  {formatRelativeTime(new Date(last), locale)}
                </span>}
              </button>
            );
          })}
          {selectedGroup?.offline && (
            <span style={{ fontSize: 11.5, color: "var(--danger)", alignSelf: "center" }}>
              {t("home.machineOffline")}
            </span>
          )}
          {selectedGroup && !selectedGroup.offline && projectRoots.length === 0 && (
            <span style={{ fontSize: 12.5, color: "var(--text-dim)", alignSelf: "center" }}>
              {t("home.noProjects")}
            </span>
          )}
        </div>
        )}
      </header>
      <main style={{ flex: 1, overflowY: "auto", width: "100%", maxWidth: 1440, margin: "0 auto", padding: "16px 20px 60px" }}>
        {newConvError && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 7,
              border: "1px solid var(--danger)",
              background: "var(--bg-hover)",
              marginBottom: 16,
            }}
          >
            <span style={{ flex: 1, fontSize: 13, color: "var(--danger)" }}>{newConvError}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setNewConvError(null)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: 0,
              }}
            >×</button>
          </div>
        )}
        {viewMode === "aggregate" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <section
              aria-label={t("home.recentActivity")}
              style={{
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 9,
                padding: 12,
              }}
            >
              <h2 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                {t("home.recentActivity")}
              </h2>
              {recentEntries.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {recentEntries.map((entry) => (
                    <HomeSessionRow
                      key={`${entry.machineId}:${entry.session.id}`}
                      entry={entry}
                      showProjectTag
                      showMachineTag
                      onSelect={(selectedEntry) => navigate(
                        {
                          machineId: selectedEntry.machineId,
                          project: selectedEntry.projectRoot,
                          session: selectedEntry.session.id,
                        },
                        { history: "push" },
                      )}
                    />
                  ))}
                </div>
              ) : (
                <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "12px 0" }}>
                  {groups === null ? <div style={{ display: "flex", justifyContent: "center" }}><LoaderIcon size={18} /></div> : t("accessNotice.noVisibleSessions")}
                </div>
              )}
            </section>

            {aggregateGroups.length > 0 && (
              <div style={chipRowStyle}>
                {aggregateGroups.map((group) => {
                  const isExpanded = expandedGroupKeys?.has(group.key) ?? (group.key === aggregateGroups[0]?.key);
                  return (
                    <button
                      key={group.key}
                      type="button"
                      onClick={() => expandAndScrollToAggregateGroup(group.key)}
                      aria-pressed={isExpanded}
                      title={group.displayName}
                      style={chipStyle(isExpanded)}
                    >
                      <span>{group.displayName} {group.sessions.length}</span>
                      {group.lastActivity && (
                        <span style={{ color: "var(--text-dim)", marginLeft: 6, fontWeight: 400 }}>
                          {formatRelativeTime(new Date(group.lastActivity), locale)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {aggregateGroups.map((group) => {
              const isExpanded = expandedGroupKeys?.has(group.key) ?? (group.key === aggregateGroups[0]?.key);
              const isShowingAll = shownAllGroupKeys.has(group.key);
              const contentId = `home-project-group-${encodeURIComponent(group.key)}`;
              const pairKeys = new Set<string>();
              const pairs: {
                machineId: string;
                machineName: string;
                machineOffline: boolean;
                projectRoot: string;
              }[] = [];
              for (const s of group.sessions) {
                const key = `${s.machineId}\u0000${s.projectRoot}`;
                if (pairKeys.has(key)) continue;
                pairKeys.add(key);
                pairs.push({ machineId: s.machineId, machineName: s.machineName, machineOffline: s.machineOffline, projectRoot: s.projectRoot });
              }
              pairs.sort((a, b) => a.machineName.localeCompare(b.machineName));
              const ncTarget = `${pairs[0].machineName} · ${pairs[0].projectRoot}`;
              return (
                <section
                  key={group.key}
                  ref={(element) => {
                    if (element) aggregateGroupRefs.current.set(group.key, element);
                    else aggregateGroupRefs.current.delete(group.key);
                  }}
                  aria-label={group.displayName}
                  style={{ scrollMarginTop: 16 }}
                >
                  <div style={{ marginBottom: isExpanded ? 8 : 0 }}>
                    <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)", display: "flex", alignItems: "baseline", position: "relative" }}>
                      <button
                        type="button"
                        onClick={() => toggleAggregateGroup(group.key)}
                        aria-expanded={isExpanded}
                        aria-controls={contentId}
                        title={t(isExpanded ? "home.collapseProject" : "home.expandProject", { project: group.displayName })}
                        style={{
                          display: "inline-flex",
                          alignItems: "baseline",
                          gap: 10,
                          flexWrap: "wrap",
                          padding: 0,
                          border: "none",
                          background: "transparent",
                          color: "inherit",
                          cursor: "pointer",
                          font: "inherit",
                          textAlign: "left",
                        }}
                      >
                        <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {group.displayName}
                        </span>
                        <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--text-dim)" }}>
                          {t("home.sessionCount", { count: String(group.sessions.length) })}
                          {group.machineCount > 1 && <> · {t("home.machineCountLabel", { count: String(group.machineCount) })}</>}
                        </span>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          style={{ transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.1s" }}
                        >
                          <path d="m3 6 5 5 5-5" />
                        </svg>
                      </button>
                      <div style={{ flex: 1 }} />
                      <div style={{ position: "relative", display: "inline-flex", flexShrink: 0, marginLeft: 8 }}>
                        <button
                          type="button"
                          disabled={creating || (pairs.length === 1 && pairs[0].machineOffline)}
                          title={pairs.length === 1 ? ncTarget : t("home.newConversation")}
                          aria-label={pairs.length === 1 ? ncTarget : t("home.newConversation")}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (pairs.length === 1) {
                              if (pairs[0].machineOffline) return;
                              void createConversation(pairs[0].machineId, pairs[0].projectRoot, pairs[0].machineName);
                            } else {
                              setPickerOpen(chooserKey === group.key ? null : group.key);
                            }
                          }}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            height: 24,
                            padding: "0 10px",
                            fontSize: 12,
                            fontWeight: 500,
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "var(--bg-hover)",
                            color: "var(--accent)",
                            cursor: creating ? "progress" : "pointer",
                          }}
                        >
                          {creating ? <LoaderIcon size={12} /> : <PlusIcon />}
                          <span>{t("home.newConversation")}</span>
                          {pairs.length > 1 && <ChevronIcon open={chooserKey === group.key} />}
                        </button>
                        {pairs.length > 1 && chooserKey === group.key && (
                          <div
                            role="menu"
                            style={{
                              position: "absolute",
                              top: "110%",
                              right: 0,
                              zIndex: 20,
                              minWidth: 300,
                              maxWidth: "46vw",
                              background: "var(--bg-panel)",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
                              padding: 6,
                              overflowY: "auto",
                            }}
                          >
                            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", padding: "2px 6px 6px" }}>
                              {t("home.newConversationChoose")}
                            </div>
                            {pairs.map((pair) => (
                              <button
                                key={`${pair.machineId}\u0000${pair.projectRoot}`}
                                type="button"
                                role="menuitem"
                                disabled={creating || pair.machineOffline}
                          title={`${pair.machineName} · ${pair.projectRoot}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setPickerOpen(null);
                                  void createConversation(pair.machineId, pair.projectRoot, pair.machineName);
                                }}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  width: "100%",
                                  padding: "6px 8px",
                                  border: "none",
                                  borderRadius: 6,
                                  background: "transparent",
                                  color: "inherit",
                                  cursor: creating || pair.machineOffline ? "progress" : "pointer",
                                  textAlign: "left",
                                  fontSize: 13,
                                }}
                              >
                                <span style={{ color: pair.machineOffline ? "var(--danger)" : "var(--accent)", flexShrink: 0, fontWeight: 500 }}>＋</span>
                                <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                                  {pair.machineName}
                                  {pair.machineOffline && <> · {t("home.machineOffline")}</>}
                                </span>
                                <span style={{ flexShrink: 0, color: "var(--text-dim)", marginLeft: 4 }}>·</span>
                                <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }}>
                                  {pair.projectRoot}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </h2>
                  </div>
                  <div id={contentId}>
                    {isExpanded && (
                      <>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {(isShowingAll ? group.sessions : group.sessions.slice(0, AGGREGATE_GROUP_SESSION_LIMIT)).map((entry) => (
                            <HomeSessionRow
                              key={`${entry.machineId}:${entry.session.id}`}
                              entry={entry}
                              showProjectTag={false}
                              showMachineTag
                              onSelect={(selectedEntry) => navigate(
                                {
                                  machineId: selectedEntry.machineId,
                                  project: selectedEntry.projectRoot,
                                  session: selectedEntry.session.id,
                                },
                                { history: "push" },
                              )}
                            />
                          ))}
                        </div>
                        {!isShowingAll && group.sessions.length > AGGREGATE_GROUP_SESSION_LIMIT && (
                          <button
                            type="button"
                            onClick={() => {
                              setShownAllGroupKeys((current) => {
                                if (current.has(group.key)) return current;
                                const next = new Set(current);
                                next.add(group.key);
                                return next;
                              });
                            }}
                            style={{
                              marginTop: 6,
                              padding: "4px 8px",
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              background: "var(--bg-hover)",
                              color: "var(--accent)",
                              cursor: "pointer",
                              fontSize: 11.5,
                            }}
                          >
                            {t("home.showAllConversations", { count: String(group.sessions.length) })}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </section>
              );
            })}
            {aggregateGroups.length === 0 && (
              <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "24px 0" }}>
                {groups === null ? <div style={{ display: "flex", justifyContent: "center" }}><LoaderIcon size={18} /></div> : t("home.aggregateEmpty")}
              </div>
            )}
          </div>
        ) : selectedGroup && selectedProject ? (
          <HomeCalendar
            machineId={selectedGroup.machineId}
            machineName={selectedGroup.machineName}
            project={selectedProject}
            sessions={selectedSessions}
          />
        ) : (
          <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "24px 0" }}>
            {groups === null ? <div style={{ display: "flex", justifyContent: "center" }}><LoaderIcon size={18} /></div> : t("home.noProjects")}
          </div>
        )}
      </main>
    </div>
  );
}
