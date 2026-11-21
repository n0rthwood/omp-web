"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import { useI18n } from "@/hooks/useI18n";
import { useMachines } from "@/lib/machine-context";
import { apiPath } from "@/lib/api-path";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRemarkPlugins } from "@/lib/markdown";
import { PROMPT_KEYS, type PromptCatalog, type PromptInspection, type PromptKey, type PromptPreview, type PromptSaveRequest, type PromptScope } from "@/lib/prompt-types";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { InjectionSettingsPanel } from "./InjectionSettingsPanel";
import styles from "./PromptsConfig.module.css";

export type PromptWorkspaceView = "defaults" | "current" | "injections";
export interface PromptsConfigHandle { requestLeave(action: () => void): void }
interface Props { cwd?: string | null; sessionId: string | null; initialView?: PromptWorkspaceView }
type Changes = Partial<Record<PromptKey, string | null>>;

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(value.error ?? `HTTP ${response.status}`), { status: response.status });
  return value;
}
function editorText(text: string): string { return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"); }
function restoredText(text: string, original: string): string {
  const newline = original.includes("\r\n") ? "\r\n" : original.includes("\r") && !original.includes("\n") ? "\r" : "\n";
  return (original.startsWith("\uFEFF") ? "\uFEFF" : "") + text.replace(/\r\n?/g, "\n").replace(/\n/g, newline);
}

/** Markdown never passes through an HTML parser: instruction XML remains visible, not executable markup. */
function PromptMarkdown({ source, cwd }: { source: string; cwd?: string | null }) {
  return <div className={`markdown-body ${styles.markdown}`}><ReactMarkdown urlTransform={(url, key) => key === "src" && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url) ? url : defaultUrlTransform(url)} remarkPlugins={markdownRemarkPlugins} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]} components={{
    code({ className, children }) {
      const text = String(children), language = className?.replace("language-", "") ?? "";
      if (language === "mermaid") return <MermaidBlock code={text.replace(/\n$/, "")} />;
      return language || text.includes("\n") ? <CodeBlock code={text.replace(/\n$/, "")} lang={language} /> : <code>{children}</code>;
    },
    pre({ children }) { return <>{children}</>; },
    a({ children, ...props }) { delete props.node; return <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>; },
    img({ src, alt, ...props }) {
      delete props.node;
      const path = typeof src === "string" ? resolveLocalFileHref(src, cwd ?? undefined) : null;
      const imageSrc = path ? apiPath(`/api/files/${encodeFilePathForApi(path)}?type=read`) : src;
      // Prompt preview follows the existing MarkdownBody image/file API path.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
  }}>{source}</ReactMarkdown></div>;
}

export const PromptsConfig = forwardRef<PromptsConfigHandle, Props>(function PromptsConfig({ cwd = null, sessionId, initialView = "defaults" }, ref) {
  const { t } = useI18n();
  const machines = useMachines();
  const machineName = machines.machines.find((machine) => machine.id === machines.machineId)?.name ?? machines.machineId;
  const [view, setView] = useState<PromptWorkspaceView>(initialView);
  const [catalog, setCatalog] = useState<PromptCatalog | null>(null);
  const [inspection, setInspection] = useState<PromptInspection | null>(null);
  const [scope, setScope] = useState<PromptScope>("global");
  const [selected, setSelected] = useState<PromptKey | string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview" | "split">("edit");
  const [changes, setChanges] = useState<Changes>({});
  const [draftETag, setDraftETag] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showDiff, setShowDiff] = useState(false);
  const [showUpstream, setShowUpstream] = useState(false);
  const [conflictETag, setConflictETag] = useState<string | null>(null);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [expanded, setExpanded] = useState(false);
  const dirty = Object.keys(changes).length > 0;
  const storageKey = `omp:prompt-draft:${machines.machineId}:${cwd ?? "global"}`;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      setCatalog(await responseJson<PromptCatalog>(await fetch(apiPath(`/api/prompts${query}`), { cache: "no-store" })));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [cwd]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    try {
      const draft = sessionStorage.getItem(storageKey);
      if (draft) {
        const recovered = JSON.parse(draft) as { changes: Changes; scope: PromptScope; etag?: string };
        if ((recovered.scope === "global" || recovered.scope === "project") && recovered.changes && Object.keys(recovered.changes).every((key) => PROMPT_KEYS.includes(key as PromptKey))) {
          setScope(recovered.scope); setChanges(recovered.changes); setDraftETag(recovered.etag ?? null); setNote(t("prompts.recovered"));
        }
      }
    } catch { /* Private browser sessions can disable storage. */ }
  // Recovered only on mounting this machine/project workspace.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => {
    try { if (dirty) sessionStorage.setItem(storageKey, JSON.stringify({ scope, changes, etag: draftETag ?? catalog?.scopes[scope]?.etag })); else sessionStorage.removeItem(storageKey); } catch { /* Editing works without storage. */ }
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [catalog, changes, dirty, draftETag, scope, storageKey]);
  const requestLeave = useCallback((action: () => void) => { if (saving) return; if (dirty) setPendingLeave(() => action); else action(); }, [dirty, saving]);
  useImperativeHandle(ref, () => ({ requestLeave }), [requestLeave]);
  useEffect(() => {
    if (view !== "current" || !sessionId) return;
    let cancelled = false;
    setInspection(null); setError("");
    void fetch(apiPath(`/api/prompts/session?sessionId=${encodeURIComponent(sessionId)}`), { cache: "no-store" }).then(responseJson<PromptInspection>).then((data) => { if (!cancelled) setInspection(data); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [sessionId, view]);
  const key = PROMPT_KEYS.includes(selected as PromptKey) ? selected as PromptKey : null;
  const scoped = catalog?.scopes[scope];
  const saved = key ? scoped?.values[key] : undefined;
  const pending = key && Object.prototype.hasOwnProperty.call(changes, key) ? changes[key] : undefined;
  const own = key ? Object.prototype.hasOwnProperty.call(changes, key) ? pending !== null : saved !== undefined : false;
  const effective = key && catalog ? catalog.effective[key] : null;
  const source = catalog?.sources.find((item) => item.id === selected);
  const baseDefault = catalog?.sources.find((item) => item.id === "sdk:base")?.content ?? "";
  const inherited = key ? (scope === "project" ? catalog?.scopes.global.values[key] : undefined) ?? (key === "baseTemplate" ? baseDefault : "") : "";
  const sourceText = key ? own ? pending ?? saved ?? "" : inherited : source?.content ?? "";
  const scopeText = scoped?.values[key ?? "append"] ?? "";
  const labels = useMemo(() => Object.fromEntries(PROMPT_KEYS.map((id) => [id, t(`prompts.${id}`)])) as Record<PromptKey, string>, [t]);
  const changeResource = (resource: PromptKey, value: string | null) => {
    if (saving) return;
    if (!dirty) setDraftETag(scoped?.etag ?? null);
    setChanges((current) => {
      const next = { ...current };
      if (value === (catalog?.scopes[scope]?.values[resource] ?? null)) delete next[resource]; else next[resource] = value;
      return next;
    });
    setNote(""); setPreview(null);
  };
  const save = async (): Promise<boolean> => {
    if (!catalog || !scoped || !dirty) return true;
    setSaving(true); setError(""); setNote("");
    try {
      const request: PromptSaveRequest = { cwd, scope, etag: draftETag ?? scoped.etag, values: changes };
      const next = await responseJson<PromptCatalog>(await fetch(apiPath("/api/prompts"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
      setCatalog(next); setChanges({}); setDraftETag(null); setConflictETag(null);
      setNote(scope === "global" && Object.keys(changes).some((id) => next.effective[id as PromptKey].scope === "project") ? t("prompts.savedShadowed") : t("prompts.saved"));
      return true;
    } catch (cause) {
      if (cause && typeof cause === "object" && "status" in cause && cause.status === 409) setConflictETag(draftETag ?? scoped.etag);
      setError(cause instanceof Error ? cause.message : String(cause)); return false;
    }
    finally { setSaving(false); }
  };
  const renderExample = async () => {
    if (!key) return;
    setError("");
    try { setPreview(await responseJson<PromptPreview>(await fetch(apiPath("/api/prompts/preview"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, key, content: sourceText }) }))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const applyPreset = (id: string) => {
    const preset = catalog?.presets.find((item) => item.id === id);
    if (!preset) return;
    requestLeave(() => { setChanges(preset.values); setDraftETag(scoped?.etag ?? null); setSelected("planningGuidance"); setView("defaults"); setNote(t("prompts.presetStaged")); });
  };
  return <div className={`${styles.workspace} ${expanded ? styles.expanded : ""}`}>
    <header className={styles.header}><div><h2>{t("prompts.title")}</h2><p className={styles.muted}>{machineName} · {cwd ?? t("prompts.global")} {catalog && <>· SDK {catalog.sdkVersion}</>}</p></div><button onClick={() => setExpanded((value) => !value)}>{t(expanded ? "prompts.collapse" : "prompts.expand")}</button></header>
    <div className={styles.tabs} role="tablist" aria-label={t("prompts.title")}>{(["defaults", "current", "injections"] as const).map((tab) => <button key={tab} role="tab" aria-selected={view === tab} disabled={tab === "current" && !sessionId} onClick={() => requestLeave(() => setView(tab))}>{t(`prompts.${tab}`)}</button>)}</div>
    {error && <div className={styles.error} role="alert">{error}<div className={styles.actions}><button onClick={() => void load()}>{t("prompts.refreshStored")}</button><span>{t("prompts.draftKept")}</span></div></div>}
    {conflictETag !== null && <div className={styles.notice} role="status"><p>{t("prompts.conflict")}</p><div className={styles.actions}><button onClick={() => void load()}>{t("prompts.refreshStored")}</button><button onClick={() => setShowDiff(true)}>{t("prompts.changes")}</button><button disabled={loading || !scoped || scoped.etag === conflictETag} onClick={() => { setDraftETag(scoped?.etag ?? null); setConflictETag(null); setError(""); setNote(t("prompts.reviewLatest")); }}>{t("prompts.reviewLatestAction")}</button></div></div>}
    {note && <p className={styles.notice} role="status">{note}</p>}
    <div className={styles.body} inert={saving}>
      {view === "injections" ? <InjectionSettingsPanel cwd={cwd} /> : view === "current" ? <section>
        <h3>{t("prompts.current")}</h3><code>{sessionId}</code>
        {!inspection && !error && <p>{t("prompts.loading")}</p>}
        {inspection && <><p className={styles.notice}>{inspection.status === "unavailable" ? t("prompts.profileUnavailable") : inspection.profile ? `${t("prompts.revision")}: ${inspection.profile.digest.slice(0, 16)} · ${inspection.profile.savedAt}` : t("prompts.legacy")}</p><p className={styles.muted}>{inspection.observation} {inspection.note}</p>
          {inspection.status === "managed" && inspection.managedValues && <section>
            <h3>{t("prompts.pinnedSources")}</h3><p className={styles.muted}>{t("prompts.pinnedSourcesNote")}</p>
            {PROMPT_KEYS.map((resource) => {
              const value = inspection.managedValues?.[resource];
              return <details className={styles.sourceDetails} key={resource}><summary>{labels[resource]} · {t(resource === "baseTemplate" ? "prompts.template" : "prompts.markdown")}</summary>
                {typeof value === "string" ? <>{value.length === 0 && <p>{t("prompts.pinnedEmpty")}</p>}<pre>{value}</pre></> : <p>{t(resource === "baseTemplate" ? "prompts.pinnedNativeBase" : "prompts.pinnedNoAddition")}</p>}
              </details>;
            })}
          </section>}
          <h3>{t("prompts.systemBlocks")}</h3>{inspection.systemPromptBlocks?.length ? inspection.systemPromptBlocks.map((block, index) => <details className={styles.sourceDetails} key={index}><summary>{t("prompts.block")} {index + 1}</summary><pre>{block}</pre></details>) : <p>{t("prompts.unavailable")}</p>}
          <h3>{t("prompts.instructions")}</h3>{inspection.instructions.map((message, index) => <details className={styles.sourceDetails} key={message.id ?? index}><summary>{message.source} · {message.role}</summary><pre>{message.content}</pre><button onClick={() => requestLeave(() => setView("injections"))}>{t("prompts.availableInjectionControls")}</button></details>)}
          <button onClick={() => setView("defaults")}>{t("prompts.editDefaults")}</button></>}
      </section> : loading && !catalog ? <p>{t("prompts.loading")}</p> : catalog && <>
        {!selected ? <><p className={styles.muted}>{t("prompts.introduction")}</p><div className={styles.preset}>{catalog.presets.map((preset) => <div key={preset.id}><strong>{preset.label}</strong><p>{preset.description}</p><button onClick={() => applyPreset(preset.id)}>{t("prompts.usePreset")}</button></div>)}</div>
          <div className={styles.inventory}>{PROMPT_KEYS.map((id) => <button key={id} onClick={() => { setSelected(id); setPreview(null); }}><span><strong>{labels[id]}</strong><small>{t(`prompts.${id}Note`)}</small></span><span className={styles.badge}>{catalog.effective[id].scope === "sdk" ? t("prompts.usingDefault") : t(`prompts.${catalog.effective[id].scope}`)}</span></button>)}</div>
          <h3>{t("prompts.otherSources")}</h3><div className={styles.inventory}>{catalog.sources.map((item) => <button key={item.id} onClick={() => { setSelected(item.id); setPreview(null); }}><span><strong>{item.label}</strong><small>{item.group}</small></span><span className={styles.badge}>{t("prompts.readOnly")}</span></button>)}</div>
        </> : <>
          <div className={styles.sourceHeading}><div><button className={styles.link} onClick={() => { setSelected(null); setPreview(null); }}>{t("prompts.allSources")}</button><h3>{key ? labels[key] : source?.label}</h3></div><select aria-label={t("prompts.source")} value={selected} onChange={(event) => { setSelected(event.target.value); setPreview(null); }}>{PROMPT_KEYS.map((id) => <option key={id} value={id}>{labels[id]}</option>)}{catalog.sources.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
          {key ? <><div className={styles.scope}><button aria-pressed={scope === "global"} onClick={() => requestLeave(() => { setScope("global"); setChanges({}); setDraftETag(null); })}>{t("prompts.global")}</button><button aria-pressed={scope === "project"} disabled={!catalog.scopes.project} title={!catalog.scopes.project ? t("prompts.selectProject") : undefined} onClick={() => requestLeave(() => { setScope("project"); setChanges({}); setDraftETag(null); })}>{t("prompts.project")}</button><span className={styles.muted}>{t("prompts.effective")}: {t(`prompts.${effective?.scope === "sdk" ? "usingDefault" : effective?.scope ?? "usingDefault"}`)}</span></div>
            <p className={styles.notice}>{t(`prompts.${key}Note`)}</p>
            <div className={styles.actions}>{!own ? <button onClick={() => changeResource(key, sourceText)}>{t(key === "baseTemplate" ? "prompts.createOverride" : "prompts.addInstructions")}</button> : <button onClick={() => changeResource(key, null)}>{t("prompts.removeOverride")}</button>}<span className={styles.badge}>{t(key === "baseTemplate" ? "prompts.template" : "prompts.markdown")}</span></div>
          </> : <p className={styles.notice}>{source?.readOnlyReason}</p>}
          <div className={styles.editorToolbar}><div className={styles.modes}>{(["edit", "preview", "split"] as const).map((choice) => <button key={choice} className={choice === "split" ? styles.splitButton : undefined} aria-pressed={mode === choice} onClick={() => setMode(choice)}>{t(`prompts.${choice}`)}</button>)}</div><div className={styles.actions}>{key === "baseTemplate" && <button onClick={() => void renderExample()}>{t("prompts.example")}</button>}{key && <button aria-pressed={showDiff} onClick={() => setShowDiff((value) => !value)}>{t("prompts.changes")}</button>}</div></div>
          <div className={`${styles.editor} ${mode === "preview" ? styles.previewOnly : mode === "split" ? styles.split : styles.editOnly}`}>
            <textarea aria-label={key ? `${labels[key]} ${t("prompts.source")}` : source?.label} spellCheck={false} value={editorText(sourceText)} readOnly={!key || !own || saving} onChange={(event) => { if (key) changeResource(key, restoredText(event.target.value, sourceText)); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (dirty) void save(); } }} />
            <div className={styles.previewPane}><PromptMarkdown source={editorText(sourceText)} cwd={cwd} /></div>
          </div>
          {preview && <details open className={styles.sourceDetails}><summary>{t("prompts.example")} · {preview.note}</summary><pre>{preview.text}</pre></details>}
          {showDiff && key && <div className={styles.diff}><div><strong>{t("prompts.stored")}</strong><pre>{scopeText || t("prompts.inherit")}</pre></div><div><strong>{t("prompts.draft")}</strong><pre>{sourceText}</pre></div></div>}
          <details className={styles.sourceDetails}><summary>{t("prompts.sourceDetails")}</summary><code>{key ? scoped?.path : source?.path ?? t("prompts.generated")}</code><p>{t("prompts.revision")}: {catalog.revision}</p>{key === "baseTemplate" && <><p>{t("prompts.baseOrigin")}: SDK {scoped?.baseOrigin?.sdkVersion ?? catalog.sdkVersion}{scoped?.baseOrigin && (scoped.baseOrigin.sdkVersion !== catalog.sdkVersion || (catalog.sdkTemplateHash && scoped.baseOrigin.templateHash !== catalog.sdkTemplateHash)) && <strong> · {t("prompts.baseUpdate")}</strong>}</p><button onClick={() => setShowUpstream((value) => !value)}>{t("prompts.compareInstalled")}</button></>}<p>{t("prompts.previewNote")}</p></details>
          {key === "baseTemplate" && showUpstream && <div className={styles.diff}><div><strong>{t("prompts.ownedBase")}</strong><pre>{sourceText}</pre></div><div><strong>{t("prompts.installedBase")} · SDK {catalog.sdkVersion}</strong><pre>{baseDefault}</pre></div></div>}
        </>}
      </>}
    </div>
    {view === "defaults" && <footer className={styles.footer}><div><strong>{dirty ? t("prompts.unsaved") : t("prompts.newConversations")}</strong><p>{t("prompts.existingUnchanged")}</p></div><div className={styles.actions}>{dirty && <button disabled={saving} onClick={() => { setChanges({}); setDraftETag(null); setConflictETag(null); setNote(""); }}>{t("prompts.discard")}</button>}<button className={styles.primary} disabled={!dirty || saving} onClick={() => void save()}>{t(saving ? "prompts.saving" : "prompts.save")}</button></div></footer>}
    {pendingLeave && <div className={styles.guardBackdrop}><div className={styles.guard} role="alertdialog" aria-modal="true" aria-label={t("prompts.unsaved")}><h3>{t("prompts.unsaved")}</h3><p>{t("prompts.leaveMessage")}</p><div className={styles.actions}><button onClick={() => setPendingLeave(null)}>{t("prompts.keepEditing")}</button><button disabled={saving} onClick={() => { const action = pendingLeave; setChanges({}); setDraftETag(null); setConflictETag(null); setPendingLeave(null); action(); }}>{t("prompts.discardContinue")}</button><button className={styles.primary} disabled={saving} onClick={() => void save().then((ok) => { if (ok) { const action = pendingLeave; setPendingLeave(null); action(); } })}>{t("prompts.saveContinue")}</button></div></div></div>}
  </div>;
});
