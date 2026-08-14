"use client";

import { useCallback, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import styles from "./SettingsConfig.module.css";

type WebRole = "admin" | "user";

type ListedUser = {
  username: string;
  role: WebRole;
  projects: string[] | "*";
  tokens: { name: string; created: string }[];
  envBacked?: boolean;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
  });
  const result = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}


// One absolute path per line, or a single "*" line for full visibility.
function parseProjectsText(text: string): string[] | "*" | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === "*") return "*";
  if (lines.some((line) => line === "*" || !line.startsWith("/"))) return null;
  return lines;
}

function userUrl(username: string, suffix = ""): string {
  return `/api/web-users/${encodeURIComponent(username)}${suffix}`;
}

export function WebUsersConfig() {
  const [users, setUsers] = useState<ListedUser[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Editor form state (create + edit share the role/projects fields).
  const [newUsername, setNewUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<WebRole>("user");
  const [projectsText, setProjectsText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Token state.
  const [tokenName, setTokenName] = useState("");
  const [rawToken, setRawToken] = useState<{ name: string; raw: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await request<{ users: ListedUser[] }>("/api/web-users", { cache: "no-store" });
      setUsers(result.users);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentUser = users?.find((user) => user.username === selected) ?? null;

  // Resync the editor form whenever the selection (or the reloaded user record) changes.
  useEffect(() => {
    setConfirmDelete(false);
    setRawToken(null);
    setCopied(false);
    setTokenName("");
    setPassword("");
    setRole(currentUser?.role ?? "user");
    setProjectsText(currentUser ? (currentUser.projects === "*" ? "*" : currentUser.projects.join("\n")) : "");
  }, [currentUser]);

  const startCreate = () => {
    setSelected(null);
    setCreating(true);
    setConfirmDelete(false);
    setRawToken(null);
    setTokenName("");
    setNewUsername("");
    setPassword("");
    setRole("user");
    setProjectsText("");
    setError(null);
  };

  const createUser = async () => {
    const username = newUsername.trim().toLowerCase();
    if (!username || !password || busy) return;
    const projects = parseProjectsText(projectsText);
    if (!projects) {
      setError('projects must be "*" or one absolute path per line');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request("/api/web-users", { method: "POST", body: JSON.stringify({ username, password, role, projects }) });
      setCreating(false);
      setSelected(username);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveUser = async () => {
    if (!currentUser || busy) return;
    const projects = parseProjectsText(projectsText);
    if (!projects) {
      setError('projects must be "*" or one absolute path per line');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(userUrl(currentUser.username), {
        method: "PATCH",
        body: JSON.stringify({ role, projects, ...(password ? { password } : {}) }),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const deleteUser = async () => {
    if (!currentUser || busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request(userUrl(currentUser.username), { method: "DELETE" });
      setSelected(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const createToken = async () => {
    if (!currentUser || busy) return;
    const name = tokenName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const result = await request<{ name: string; raw: string; created: string }>(
        userUrl(currentUser.username, "/tokens"),
        { method: "POST", body: JSON.stringify({ name }) },
      );
      setRawToken({ name: result.name, raw: result.raw });
      setCopied(false);
      setTokenName("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async (name: string) => {
    if (!currentUser || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request(userUrl(currentUser.username, `/tokens/${encodeURIComponent(name)}`), { method: "DELETE" });
      if (rawToken?.name === name) setRawToken(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copyRaw = async () => {
    if (!rawToken) return;
    try {
      await copyText(rawToken.raw);
      setCopied(true);
    } catch {
      setError("Copy failed — select the token text manually.");
    }
  };

  const roleSelect = () => (
    <select className={styles.select} value={role} onChange={(event) => setRole(event.target.value as WebRole)}>
      <option value="user">user — sees only listed projects</option>
      <option value="admin">admin — full access</option>
    </select>
  );

  const projectsField = () => (
    <textarea
      className={styles.jsonEditor}
      style={{ minHeight: 120 }}
      value={projectsText}
      spellCheck={false}
      placeholder={"*\n/home/me/project-a\n/home/me/project-b"}
      onChange={(event) => setProjectsText(event.target.value)}
    />
  );

  return (
    <div className={styles.scrollContent}>
      <header className={styles.contentHeader}>
        <h2 className={styles.contentTitle}>Web users</h2>
        <p className={styles.contentDescription}>
          Accounts that can sign in to this omp-web instance. Admins manage users and see every project; user accounts only see the projects listed for them. Visibility is enforced server-side per request but is not a sandbox.
        </p>
      </header>
      <div className={styles.settingsBody}>
        {!users ? (
          <div className={styles.empty}>{error ?? "Loading web users…"}</div>
        ) : (
          <div className={styles.mcpLayout}>
            <aside className={styles.mcpList}>
              <div className={styles.serverRows}>
                {users.length ? users.map((user) => (
                  <div
                    key={user.username}
                    className={styles.serverRow}
                    data-active={!creating && selected === user.username}
                  >
                    <button
                      type="button"
                      className={styles.serverSelect}
                      title={`${user.role} · ${user.projects === "*" ? "all projects" : user.projects.length === 0 ? "no projects" : user.projects.length === 1 ? user.projects[0] : `${user.projects.length} projects`}`}
                      onClick={() => {
                        setCreating(false);
                        setSelected(user.username);
                        setError(null);
                      }}
                    >
                      <span className={styles.statusDot} data-off={user.role !== "admin"} />
                      <span className={styles.serverName}>{user.username}</span>
                      {user.tokens.length > 0 && <span className={styles.sourceBadge}>{user.tokens.length} token{user.tokens.length === 1 ? "" : "s"}</span>}
                      {user.envBacked && <span className={styles.sourceBadge}>env · read-only</span>}
                    </button>
                  </div>
                )) : <div className={styles.serverListEmpty}>No users yet.</div>}
              </div>
              <button type="button" className={styles.addServer} onClick={startCreate}>+ Add user</button>
            </aside>
            <section className={styles.mcpEditor}>
              {creating ? (
                <>
                  <div className={styles.editorHeader}>
                    <input
                      className={styles.textInput}
                      placeholder="username (lowercase a-z, 0-9, - or _)"
                      value={newUsername}
                      spellCheck={false}
                      onChange={(event) => setNewUsername(event.target.value)}
                    />
                  </div>
                  <div className={styles.settingLabel} style={{ marginTop: 10 }}>Password</div>
                  <input
                    type="password"
                    className={styles.textInput}
                    value={password}
                    autoComplete="new-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <div className={styles.settingLabel} style={{ marginTop: 10 }}>Role</div>
                  {roleSelect()}
                  <div className={styles.settingLabel} style={{ marginTop: 10 }}>Projects</div>
                  {projectsField()}
                  <div className={styles.editorActions}>
                    <div>{error && <div className={styles.error}>{error}</div>}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => setCreating(false)}>Cancel</button>
                      <button type="button" className={styles.primaryButton} disabled={busy || !newUsername.trim() || !password} onClick={() => void createUser()}>
                        {busy ? "Creating…" : "Create user"}
                      </button>
                    </div>
                  </div>
                </>
              ) : currentUser ? (
                <>
                  <div className={styles.editorHeader}>
                    <input className={styles.textInput} value={currentUser.username} readOnly />
                    {!currentUser.envBacked && (
                      <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void deleteUser()}>
                        {confirmDelete ? "Confirm delete?" : "Delete"}
                      </button>
                    )}
                  </div>
                  {currentUser.envBacked ? (
                    <div className={styles.readOnlyNotice}>
                      Read-only · this account is backed by the OMP_WEB_PASSWORD environment variable (migration bridge). Create a file-backed admin here, then remove the env variable.
                    </div>
                  ) : (
                    <>
                      <div className={styles.settingLabel}>Role</div>
                      {roleSelect()}
                      <div className={styles.settingLabel} style={{ marginTop: 10 }}>Projects — one absolute path per line, or * for all</div>
                      {projectsField()}
                      <div className={styles.settingLabel} style={{ marginTop: 10 }}>Reset password</div>
                      <input
                        type="password"
                        className={styles.textInput}
                        placeholder="leave blank to keep the current password"
                        value={password}
                        autoComplete="new-password"
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <div className={styles.editorActions}>
                        <div>{error && <div className={styles.error}>{error}</div>}</div>
                        <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void saveUser()}>
                          {busy ? "Saving…" : "Save user"}
                        </button>
                      </div>
                    </>
                  )}
                  {!currentUser.envBacked && (
                    <div style={{ marginTop: 22 }}>
                      <div className={styles.settingLabel}>API tokens</div>
                      <div className={styles.saveState}>Bearer tokens for CLI access. The raw value is shown only once, at creation.</div>
                      {currentUser.tokens.length ? currentUser.tokens.map((token) => (
                        <div key={token.name} className={styles.serverRow} style={{ justifyContent: "space-between", marginTop: 4 }}>
                          <span className={styles.serverName} title={`created ${token.created}`}>{token.name}</span>
                          <button type="button" className={styles.dangerButton} style={{ height: 25 }} disabled={busy} onClick={() => void revokeToken(token.name)}>Revoke</button>
                        </div>
                      )) : <div className={styles.saveState} style={{ marginTop: 4 }}>No tokens.</div>}
                      <div className={styles.editorHeader} style={{ marginTop: 10 }}>
                        <input
                          className={styles.textInput}
                          placeholder="token name"
                          value={tokenName}
                          spellCheck={false}
                          onChange={(event) => setTokenName(event.target.value)}
                        />
                        <button type="button" className={styles.primaryButton} disabled={busy || !tokenName.trim()} onClick={() => void createToken()}>
                          Create token
                        </button>
                      </div>
                      {rawToken && (
                        <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
                          <div className={styles.error}>Token “{rawToken.name}” created — store it now, it will not be shown again.</div>
                          <div className={styles.editorHeader} style={{ marginTop: 8 }}>
                            <input className={styles.textInput} value={rawToken.raw} readOnly onFocus={(event) => event.currentTarget.select()} />
                            <button type="button" className={styles.primaryButton} onClick={() => void copyRaw()}>{copied ? "Copied" : "Copy"}</button>
                            <button type="button" className={styles.dangerButton} onClick={() => setRawToken(null)}>Dismiss</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {currentUser.envBacked && error && <div className={styles.error} style={{ marginTop: 10 }}>{error}</div>}
                </>
              ) : (
                <div className={styles.empty}>Select a user or add one.</div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
