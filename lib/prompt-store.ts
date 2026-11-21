import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { getPackageDir } from "@oh-my-pi/pi-coding-agent/config";
import { buildSystemPrompt, discoverSystemPromptOverride } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { withFileLockSync, writePrivateFileAtomicSync } from "./atomic-file";
import { PROMPT_KEYS, type PromptCatalog, type PromptKey, type PromptProfileMarker, type PromptSaveRequest, type PromptScopeState, type PromptSource, type PromptValues } from "./prompt-types";

export const PROMPT_PROFILE_ENTRY = "omp-web:prompt-profile";
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_PROFILE_BYTES = MAX_SOURCE_BYTES * 4 + 4096;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPO_ROOT = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd();

export class PromptStoreError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export interface ManagedPromptProfile { marker: PromptProfileMarker; values: PromptValues }
export interface PromptSessionManager {
  getEntries(): readonly unknown[];
  appendCustomEntry(type: string, data: unknown): unknown;
}

export function promptDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readText(file: string, maxBytes = MAX_PROFILE_BYTES): string | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PromptStoreError(`Prompt source must be a regular file: ${file}`);
    if (stat.size > maxBytes) throw new PromptStoreError(`Prompt source is too large: ${file}`);
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function valuesFrom(value: unknown): PromptValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PromptStoreError("Invalid prompt profile");
  const record = value as Record<string, unknown>;
  const result: PromptValues = {};
  for (const key of Object.keys(record)) {
    if (!(PROMPT_KEYS as readonly string[]).includes(key)) throw new PromptStoreError(`Unknown prompt source: ${key}`);
    const text = record[key];
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_SOURCE_BYTES || text.includes("\0")) throw new PromptStoreError(`Invalid prompt text: ${key}`);
    result[key as PromptKey] = text;
  }
  return result;
}

export function promptProfilePath(agentDir: string, cwd: string | null): string {
  if (!cwd) return join(agentDir, "omp-web-prompts.json");
  const root = realpathSync(cwd);
  const directory = join(root, ".omp");
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) {
    throw new PromptStoreError("Project .omp must be a real directory", 403);
  }
  return join(directory, "omp-web-prompts.json");
}

export function readPromptScope(file: string): PromptScopeState {
  const text = readText(file);
  if (text === null) return { path: file, etag: promptDigest(""), values: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new PromptStoreError(`Invalid JSON in prompt profile: ${file}`); }
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) throw new PromptStoreError(`Unsupported prompt profile schema: ${file}`);
  const baseOrigin = (parsed as { baseOrigin?: PromptScopeState["baseOrigin"] }).baseOrigin;
  return { path: file, etag: promptDigest(text), values: valuesFrom((parsed as { values?: unknown }).values), ...(baseOrigin && typeof baseOrigin.sdkVersion === "string" && typeof baseOrigin.templateHash === "string" ? { baseOrigin } : {}) };
}

export function resolvePromptDefaults(agentDir: string, cwd: string | null): { global: PromptScopeState; project: PromptScopeState | null; values: PromptValues; revision: string } {
  const global = readPromptScope(promptProfilePath(agentDir, null));
  const project = cwd ? readPromptScope(promptProfilePath(agentDir, cwd)) : null;
  const values = { ...global.values, ...project?.values };
  return { global, project, values, revision: promptDigest(JSON.stringify(values)) };
}

/** Uses the real SDK renderer with explicit empty example resources: no host/model call. */
export async function renderPromptExample(content: string): Promise<string> {
  if (!content.trim()) throw new PromptStoreError("Base template must not be empty. Remove the override to inherit the SDK template.");
  try {
    const built = await buildSystemPrompt({
      cwd: "/example/project", systemPromptTemplate: content, contextFiles: [], skills: [], rules: [], alwaysApplyRules: [],
      tools: new Map(), toolNames: [], personality: "none", activeRepoContext: null, includeWorkspaceTree: false,
      workspaceTree: { rootPath: "/example/project", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
    });
    return built.systemPrompt[0] ?? "";
  } catch (error) { throw new PromptStoreError(`Invalid base template: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function savePromptDefaults(input: PromptSaveRequest, agentDir = getAgentDir()): Promise<void> {
  if (input.scope !== "global" && input.scope !== "project") throw new PromptStoreError("Invalid prompt scope");
  if (input.scope === "project" && !input.cwd) throw new PromptStoreError("Select a project first");
  if (typeof input.etag !== "string" || !input.values || typeof input.values !== "object" || Array.isArray(input.values)) throw new PromptStoreError("Invalid prompt update");
  const changes: Partial<Record<PromptKey, string | null>> = {};
  for (const [key, value] of Object.entries(input.values)) {
    if (!(PROMPT_KEYS as readonly string[]).includes(key)) throw new PromptStoreError(`Unknown prompt source: ${key}`);
    if (value !== null) valuesFrom({ [key]: value });
    changes[key as PromptKey] = value;
  }
  if (typeof changes.baseTemplate === "string") await renderPromptExample(changes.baseTemplate);
  const file = promptProfilePath(agentDir, input.scope === "project" ? input.cwd! : null);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  withFileLockSync(`${file}.lock`, () => {
    const current = readPromptScope(file);
    if (input.etag !== current.etag) throw new PromptStoreError("Prompt settings changed elsewhere. Compare or reload before saving.", 409);
    const next = { ...current.values };
    for (const key of PROMPT_KEYS) {
      if (!Object.hasOwn(changes, key)) continue;
      if (changes[key] === null) delete next[key];
      else next[key] = changes[key]!;
    }
    const sdk = sdkPaths();
    const baseOrigin = next.baseTemplate === undefined ? undefined : current.baseOrigin ?? { sdkVersion: sdk.version, templateHash: promptDigest(readText(join(sdk.root, "src", "prompts", "system", "system-prompt.md"), MAX_SOURCE_BYTES) ?? "") };
    const serialized = JSON.stringify({ schemaVersion: 1, values: next, ...(baseOrigin ? { baseOrigin } : {}) }, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_PROFILE_BYTES) throw new PromptStoreError("Combined prompt profile is too large after JSON encoding");
    writePrivateFileAtomicSync(file, serialized);
  });
}

function validMarker(value: unknown): value is PromptProfileMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<PromptProfileMarker>;
  return marker.schemaVersion === 1 && typeof marker.profileId === "string" && PROFILE_ID.test(marker.profileId)
    && typeof marker.digest === "string" && /^[a-f0-9]{64}$/.test(marker.digest) && typeof marker.savedAt === "string";
}

export function readPromptMarker(entries: readonly unknown[]): PromptProfileMarker | null {
  const markers = entries.filter((entry) => !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === PROMPT_PROFILE_ENTRY);
  if (!markers.length) return null;
  const data = (markers[markers.length - 1] as { data?: unknown }).data;
  if (!validMarker(data)) throw new PromptStoreError("Conversation prompt profile metadata is invalid", 409);
  return data;
}

function snapshotsDir(agentDir: string): string {
  const directory = join(agentDir, "omp-web-prompt-snapshots");
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new PromptStoreError("Prompt snapshot directory must not be a symbolic link", 409);
  return directory;
}

export function loadPromptSnapshot(marker: PromptProfileMarker, agentDir = getAgentDir()): ManagedPromptProfile {
  if (!validMarker(marker)) throw new PromptStoreError("Invalid conversation prompt profile", 409);
  const text = readText(join(snapshotsDir(agentDir), `${marker.profileId}.json`));
  if (text === null || promptDigest(text) !== marker.digest) throw new PromptStoreError("Conversation prompt profile is unavailable or changed. Its saved instructions were not replaced with current defaults.", 409);
  let parsed: { schemaVersion?: number; values?: unknown };
  try { parsed = JSON.parse(text); } catch { throw new PromptStoreError("Conversation prompt profile is corrupt", 409); }
  if (parsed.schemaVersion !== 1) throw new PromptStoreError("Unsupported conversation prompt profile", 409);
  return { marker, values: valuesFrom(parsed.values) };
}

/** Existing conversations without a marker deliberately stay SDK-managed. */
export async function bindPromptProfile(manager: PromptSessionManager, cwd: string, genuinelyNew: boolean, agentDir = getAgentDir()): Promise<ManagedPromptProfile | null> {
  const previous = readPromptMarker(manager.getEntries());
  if (previous) return loadPromptSnapshot(previous, agentDir);
  if (!genuinelyNew) return null;
  const { values } = resolvePromptDefaults(agentDir, cwd);
  if (values.baseTemplate !== undefined) await renderPromptExample(values.baseTemplate);
  const directory = snapshotsDir(agentDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const text = JSON.stringify({ schemaVersion: 1, values });
  if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) throw new PromptStoreError("Combined conversation prompt profile is too large after JSON encoding");
  const marker: PromptProfileMarker = { schemaVersion: 1, profileId: randomUUID(), digest: promptDigest(text), savedAt: new Date().toISOString() };
  writePrivateFileAtomicSync(join(directory, `${marker.profileId}.json`), text);
  manager.appendCustomEntry(PROMPT_PROFILE_ENTRY, marker);
  return { marker, values };
}

/** Empty and deep forks inherit the same immutable source snapshot, never today's defaults. */
export function inheritPromptProfile(source: PromptSessionManager, target: PromptSessionManager): void {
  const marker = readPromptMarker(source.getEntries());
  if (marker && !readPromptMarker(target.getEntries())) target.appendCustomEntry(PROMPT_PROFILE_ENTRY, marker);
}

function sdkPaths(): { root: string; version: string } {
  // The SDK module is externalized by Next; its own resolver retains the real
  // package location, unlike webpack's createRequire/require.resolve stubs.
  const root = getPackageDir();
  if (!root) throw new PromptStoreError("Installed SDK prompt assets are unavailable", 503);
  return { root, version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string };
}

function bundledSources(root: string): PromptSource[] {
  const sources: PromptSource[] = [];
  const walk = (directory: string, group: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file, group);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relative = file.slice(root.length + 1).replaceAll("\\", "/");
        sources.push({ id: `sdk:${relative}`, label: entry.name, group, path: file, content: readText(file, MAX_SOURCE_BYTES) ?? undefined, format: "template", readOnlyReason: "SDK-owned template. Inspect the source; use managed overrides or additions to customize without patching the SDK." });
      }
    }
  };
  walk(join(root, "src", "prompts"), "SDK instruction templates");
  for (const area of ["compress", "cleanse", "live", "if-bench"]) walk(join(root, "src", area, "prompts"), "Auxiliary model calls");
  const base = sources.find((source) => source.path === join(root, "src", "prompts", "system", "system-prompt.md"));
  if (base) { base.id = "sdk:base"; base.label = "Installed SDK base template"; }
  return sources;
}

export async function readPromptCatalog(cwd: string | null, agentDir = getAgentDir()): Promise<PromptCatalog> {
  const defaults = resolvePromptDefaults(agentDir, cwd);
  const sdk = sdkPaths();
  const sdkTemplateHash = promptDigest(readText(join(sdk.root, "src", "prompts", "system", "system-prompt.md"), MAX_SOURCE_BYTES) ?? "");
  const sources = bundledSources(sdk.root);
  const permittedRoots = [agentDir, ...(cwd ? [cwd] : [])].filter(existsSync).map((root) => realpathSync(root));
  const native = (file: string, label: string, format: PromptSource["format"], reason: string): PromptSource => {
    try {
      const target = realpathSync(file);
      if (!permittedRoots.some((root) => target === root || target.startsWith(root + sep))) throw new Error("outside selected source roots");
      return { id: `native:${file}`, label, path: file, content: readText(file, MAX_SOURCE_BYTES) ?? undefined, format, group: "Native project and user sources", readOnlyReason: reason + " Raw file only; @imports are not expanded by this inspector." };
    } catch {
      return { id: `native:unavailable:${sources.length}`, label, format, group: "Native project and user sources", readOnlyReason: "Source unavailable: outside the selected project/account roots, symbolic link, or unreadable. Expanded imported content is not exposed." };
    }
  };
  // Global-only inspection must not implicitly discover the web server's cwd.
  if (cwd) {
    const nativeOverride = await discoverSystemPromptOverride(cwd);
    if (nativeOverride) sources.unshift(native(nativeOverride.path, "Native system override", nativeOverride.kind === "template" ? "template" : "markdown", defaults.values.baseTemplate !== undefined ? "Shadowed by the managed base template." : "SDK-discovered source; edits follow native SDK reload timing."));
    const contextFiles = await loadCapability<{ path: string }>(contextFileCapability.id, { cwd });
    for (const file of contextFiles.items) sources.push(native(file.path, file.path.split(/[\\/]/).pop() ?? "Context file", "markdown", "SDK context source; use native controls to edit it."));
  }
  for (const name of ["PERSONALITY.md", "APPEND_SYSTEM.md", ...(!cwd ? ["SYSTEM.md", "SYSTEM_TEMPLATE.md", "AGENTS.md"] : [])]) {
    const file = join(agentDir, name);
    if (existsSync(file)) sources.push(native(file, name, name === "SYSTEM_TEMPLATE.md" ? "template" : "markdown", name === "APPEND_SYSTEM.md" ? "CLI discovery source; omp-web uses managed Additional instructions instead." : "Native source; edits follow SDK reload timing and template precedence."));
  }
  sources.push({ id: "runtime:extensions", label: "Extensions, MCP, tools and memory", group: "Generated runtime instructions", format: "markdown", readOnlyReason: "Generated for each session by its enabled tools, memory backend, MCP servers and extension hooks. Inspect observed blocks in Current conversation; arbitrary hook authors cannot be inferred from text." });
  const presetValues: PromptValues = {};
  for (const [key, file] of [["append", "working-style.md"], ["planningGuidance", "planning.md"], ["afterPlanApproval", "after-plan-approval.md"]] as const) {
    const content = readText(join(REPO_ROOT, "prompts", "claude-inspired", file), MAX_SOURCE_BYTES);
    if (content !== null) presetValues[key] = content;
  }
  const effective = Object.fromEntries(PROMPT_KEYS.map((key) => [key, { value: defaults.values[key] ?? null, scope: Object.hasOwn(defaults.project?.values ?? {}, key) ? "project" : Object.hasOwn(defaults.global.values, key) ? "global" : "sdk" }])) as PromptCatalog["effective"];
  return { cwd, sdkVersion: sdk.version, sdkTemplateHash, revision: defaults.revision, scopes: { global: defaults.global, project: defaults.project }, effective, sources, presets: Object.keys(presetValues).length === 3 ? [{ id: "claude-inspired-omp-workflow-v1", label: "Claude-inspired omp workflow", description: "Original omp-specific working, planning and approval guidance based on reviewed Claude Code concepts. Adds guidance without replacing your base template or tool permissions. Saving is opt-in.", values: presetValues }] : [], appliesTo: "new-conversations" };
}
