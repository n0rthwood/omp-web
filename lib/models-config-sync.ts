/**
 * Fleet declaration-layer sync (issue #141).
 *
 * The sync unit is the *declaration* layer only:
 *   - `models.yml` → `providers` blocks (custom/override providers)
 *   - `config.yml` → `modelRoles`, `enabledModels`, `retry.fallbackChains`
 *
 * Credentials never leave the machine: this module never reads a credential
 * value and never opens `agent.db`. A provider block is withheld when the SDK
 * can OAuth it *and* the block declares no key of its own — that is a
 * subscription login (anthropic, openai-codex, xai-oauth, …). A dual-auth
 * provider written with `apiKey: SOME_ENV_VAR` (zhipu-coding-plan, openrouter,
 * …) is a plain declaration and syncs; the field is a bare environment-variable
 * *name*, and the target's preflight only checks that the name is present,
 * never what it holds.
 *
 * Roles / allow-list entries that reference an OAuth provider are synced
 * verbatim — the target simply falls back through its own
 * `retry.fallbackChains` when it has no login for that provider.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { isMap, parseDocument, stringify as stringifyYaml } from "yaml";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getOmpRuntime, invalidateOmpRuntime } from "@/lib/omp-runtime";

/** Bumped when the payload shape changes; a mismatch refuses the target. */
export const SYNC_SCHEMA_VERSION = 1;

export const SYNC_SECTIONS = ["providers", "roles", "enabledModels"] as const;
export type SyncSection = (typeof SYNC_SECTIONS)[number];

const MODELS_READ_CANDIDATES = ["models.yml", "models.yaml", "models.json"] as const;
const CONFIG_FILES = ["config.yml", "config.yaml"] as const;

/** A models.yml provider block, kept structurally loose on purpose. */
export type SyncProviderBlock = Record<string, unknown>;

export interface SyncExportPayload {
  schemaVersion: number;
  exportedAt: string;
  sourceMachine: string;
  providers: Record<string, SyncProviderBlock>;
  roles: Record<string, string>;
  enabledModels: string[];
  fallbackChains: Record<string, string[]>;
  /** OAuth subscription providers whose blocks were withheld. */
  excludedOAuthProviders: string[];
}

export interface SyncDiff {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * One preflight finding, structured so the wizard can word it in the UI
 * language (issue #145). `SyncApplyResult.warnings` carries the same findings
 * as fixed English lines for cross-version wire compatibility.
 */
export type SyncIssue =
  | { kind: "missing_key"; provider: string; envVar: string }
  | { kind: "not_logged_in"; provider: string };

export interface SyncApplyResult {
  dryRun: boolean;
  schemaVersion: number;
  changed: boolean;
  applied: {
    providers: SyncDiff;
    roles: SyncDiff;
    enabledModels: { added: string[]; removed: string[]; unchanged: string[] };
    fallbackChains: SyncDiff;
  };
  issues: SyncIssue[];
  warnings: string[];
  backupPaths: string[];
}

export class SyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncValidationError";
  }
}

/** Everything the layer needs from the host process. Injectable for tests. */
export interface SyncDeps {
  agentDir: string;
  /** Environment *variable names* only — never values. */
  envKeyNames: readonly string[];
  /** Provider ids the SDK declares as OAuth subscriptions. */
  oauthProviderIds: readonly string[];
  /** Whether the target holds any credential for `provider` (presence only). */
  hasOAuthCredential: (provider: string) => boolean;
  now?: () => Date;
}

/** Order-insensitive deep equality, so a re-applied payload diffs as unchanged. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
    return out;
  }
  return value;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function firstExisting(agentDir: string, names: readonly string[]): string {
  for (const name of names) {
    const path = join(agentDir, name);
    if (existsSync(path)) return path;
  }
  return join(agentDir, names[0]);
}

/** Parse a YAML/JSON mapping, treating an absent or non-mapping file as empty. */
function parseMapping(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) return {};
  const value: unknown = doc.toJS();
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncValidationError(`${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new SyncValidationError(`${field}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SyncValidationError(`${field} must be an array of strings`);
  }
  return value as string[];
}

function chainRecord(value: unknown, field: string): Record<string, string[]> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncValidationError(`${field} must be an object`);
  }
  const out: Record<string, string[]> = {};
  for (const [key, chain] of Object.entries(value)) out[key] = stringArray(chain, `${field}.${key}`);
  return out;
}

/** `~/.omp/agent/.env` key names — the fleet keeps plain keys there. */
export function readEnvKeyNames(agentDir: string): string[] {
  const names = new Set(Object.keys(process.env));
  const text = readText(join(agentDir, ".env"));
  if (text !== null) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const name = trimmed.slice(0, separator).trim().replace(/^export\s+/, "");
      if (name.length > 0) names.add(name);
    }
  }
  return [...names];
}

/** Real host deps: runtime auth storage for presence, SDK registry for OAuth ids. */
export async function defaultSyncDeps(): Promise<SyncDeps> {
  const { agentDir, authStorage } = await getOmpRuntime();
  return {
    agentDir,
    envKeyNames: readEnvKeyNames(agentDir),
    oauthProviderIds: getOAuthProviders().map((provider) => provider.storeCredentialsAs ?? provider.id),
    hasOAuthCredential: (provider) =>
      authStorage.credentials.list(provider).length > 0 || Boolean(authStorage.keys.source(provider)?.concrete),
  };
}

/**
 * Read the declaration layer. Pure with respect to credentials: the result
 * carries provider blocks, role selectors and allow-list globs, nothing else.
 */
export function exportDeclarationLayer(deps: SyncDeps): SyncExportPayload {
  const models = parseMapping(readText(firstExisting(deps.agentDir, MODELS_READ_CANDIDATES)));
  const config = parseMapping(readText(firstExisting(deps.agentDir, CONFIG_FILES)));

  const oauth = new Set(deps.oauthProviderIds);
  const providers: Record<string, SyncProviderBlock> = {};
  const excludedOAuthProviders: string[] = [];
  const configured = models.providers;
  if (configured !== null && typeof configured === "object" && !Array.isArray(configured)) {
    for (const [id, block] of Object.entries(configured)) {
      if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
      // A block is a subscription login — withheld — when the SDK can OAuth it
      // and the block itself declares no key of its own. A dual-auth provider
      // written with `apiKey: SOME_ENV_VAR` (zhipu-coding-plan, openrouter, …)
      // is a plain declaration and syncs like any other; its bare env-var name
      // is not a credential.
      const declaresKey = typeof block.apiKey === "string" && block.apiKey.length > 0;
      if (oauth.has(id) && !declaresKey) {
        excludedOAuthProviders.push(id);
        continue;
      }
      providers[id] = block as SyncProviderBlock;
    }
  }

  const roles: Record<string, string> = {};
  const configuredRoles = config.modelRoles;
  if (configuredRoles !== null && typeof configuredRoles === "object" && !Array.isArray(configuredRoles)) {
    for (const [role, selector] of Object.entries(configuredRoles)) {
      if (typeof selector === "string" && selector.length > 0) roles[role] = selector;
    }
  }

  const enabledModels = Array.isArray(config.enabledModels)
    ? config.enabledModels.filter((entry): entry is string => typeof entry === "string")
    : [];

  const fallbackChains: Record<string, string[]> = {};
  const retry = config.retry;
  const configuredChains = retry !== null && typeof retry === "object" && !Array.isArray(retry)
    ? (retry as Record<string, unknown>).fallbackChains
    : undefined;
  if (configuredChains !== null && typeof configuredChains === "object" && !Array.isArray(configuredChains)) {
    for (const [key, chain] of Object.entries(configuredChains)) {
      if (Array.isArray(chain)) {
        fallbackChains[key] = chain.filter((entry): entry is string => typeof entry === "string");
      }
    }
  }

  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceMachine: process.env.OMP_WEB_MACHINE_NAME?.trim() || hostname(),
    providers,
    roles,
    enabledModels,
    fallbackChains,
    excludedOAuthProviders: excludedOAuthProviders.sort(),
  };
}

export interface SyncApplyRequest {
  payload: unknown;
  sections: unknown;
  dryRun?: unknown;
  prune?: unknown;
}

export interface ParsedSyncRequest {
  payload: SyncExportPayload;
  sections: SyncSection[];
  dryRun: boolean;
  prune: boolean;
}

/** Strict request validation — every failure is a 400, never a partial write. */
export function parseSyncRequest(input: SyncApplyRequest): ParsedSyncRequest {
  const raw = input.payload;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyncValidationError("payload must be an object");
  }
  const body = raw as Record<string, unknown>;
  if (body.schemaVersion !== SYNC_SCHEMA_VERSION) {
    throw new SyncValidationError(`Unsupported schemaVersion: ${String(body.schemaVersion)} (expected ${SYNC_SCHEMA_VERSION})`);
  }
  if (body.providers === null || typeof body.providers !== "object" || Array.isArray(body.providers)) {
    throw new SyncValidationError("payload.providers must be an object");
  }
  const providers: Record<string, SyncProviderBlock> = {};
  for (const [id, block] of Object.entries(body.providers)) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      throw new SyncValidationError(`payload.providers.${id} must be an object`);
    }
    providers[id] = block as SyncProviderBlock;
  }

  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new SyncValidationError("sections must be a non-empty array");
  }
  const sections: SyncSection[] = [];
  for (const entry of input.sections) {
    if (typeof entry !== "string" || !SYNC_SECTIONS.includes(entry as SyncSection)) {
      throw new SyncValidationError(`Unknown section: ${String(entry)}`);
    }
    if (!sections.includes(entry as SyncSection)) sections.push(entry as SyncSection);
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
    throw new SyncValidationError("dryRun must be a boolean");
  }
  if (input.prune !== undefined && typeof input.prune !== "boolean") {
    throw new SyncValidationError("prune must be a boolean");
  }

  return {
    payload: {
      schemaVersion: SYNC_SCHEMA_VERSION,
      exportedAt: typeof body.exportedAt === "string" ? body.exportedAt : "",
      sourceMachine: typeof body.sourceMachine === "string" ? body.sourceMachine : "",
      providers,
      roles: stringRecord(body.roles, "payload.roles"),
      enabledModels: stringArray(body.enabledModels, "payload.enabledModels"),
      fallbackChains: chainRecord(body.fallbackChains, "payload.fallbackChains"),
      excludedOAuthProviders: Array.isArray(body.excludedOAuthProviders)
        ? body.excludedOAuthProviders.filter((entry): entry is string => typeof entry === "string")
        : [],
    },
    sections,
    dryRun: input.dryRun === true,
    prune: input.prune === true,
  };
}

function diffRecord(before: Record<string, unknown>, after: Record<string, unknown>): SyncDiff {
  const diff: SyncDiff = { added: [], updated: [], removed: [], unchanged: [] };
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) diff.added.push(key);
    else if (sameValue(before[key], after[key])) diff.unchanged.push(key);
    else diff.updated.push(key);
  }
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) diff.removed.push(key);
  }
  return diff;
}

function collectIssues(sections: readonly SyncSection[], payload: SyncExportPayload, deps: SyncDeps): SyncIssue[] {
  const issues: SyncIssue[] = [];
  const envKeys = new Set(deps.envKeyNames);
  const oauth = new Set(deps.oauthProviderIds);

  if (sections.includes("providers")) {
    for (const [id, block] of Object.entries(payload.providers)) {
      const apiKey = block.apiKey;
      if (typeof apiKey === "string" && apiKey.length > 0 && !envKeys.has(apiKey)) {
        issues.push({ kind: "missing_key", provider: id, envVar: apiKey });
      }
    }
  }

  const referenced = new Set<string>();
  if (sections.includes("roles")) {
    for (const selector of Object.values(payload.roles)) referenced.add(selector.split("/")[0]);
    for (const chain of Object.values(payload.fallbackChains)) {
      for (const selector of chain) referenced.add(selector.split("/")[0]);
    }
  }
  if (sections.includes("enabledModels")) {
    for (const pattern of payload.enabledModels) {
      const slash = pattern.indexOf("/");
      if (slash > 0) referenced.add(pattern.slice(0, slash));
    }
  }
  for (const provider of [...referenced].sort()) {
    if (oauth.has(provider) && !deps.hasOAuthCredential(provider)) {
      issues.push({ kind: "not_logged_in", provider });
    }
  }
  return issues;
}

/**
 * Merge the payload into the declaration layer.
 *
 * Providers merge per id (remote-only blocks survive unless `prune`), while
 * roles / allow-list / fallback chains are replaced wholesale — the confirmed
 * "whole-section replacement" semantics. `dryRun` computes the full diff and
 * preflight warnings without touching the disk.
 */
export function applyDeclarationLayer(request: ParsedSyncRequest, deps: SyncDeps): SyncApplyResult {
  const now = deps.now ? deps.now() : new Date();
  const modelsPath = firstExisting(deps.agentDir, MODELS_READ_CANDIDATES);
  const configPath = firstExisting(deps.agentDir, CONFIG_FILES);
  const models = parseMapping(readText(modelsPath));
  const config = parseMapping(readText(configPath));

  const currentProviders: Record<string, SyncProviderBlock> = {};
  const configured = models.providers;
  if (configured !== null && typeof configured === "object" && !Array.isArray(configured)) {
    for (const [id, block] of Object.entries(configured)) {
      if (block !== null && typeof block === "object" && !Array.isArray(block)) {
        currentProviders[id] = block as SyncProviderBlock;
      }
    }
  }
  const currentRoles: Record<string, string> = {};
  const configuredRoles = config.modelRoles;
  if (configuredRoles !== null && typeof configuredRoles === "object" && !Array.isArray(configuredRoles)) {
    for (const [role, selector] of Object.entries(configuredRoles)) {
      if (typeof selector === "string" && selector.length > 0) currentRoles[role] = selector;
    }
  }
  const currentEnabled = Array.isArray(config.enabledModels)
    ? config.enabledModels.filter((entry): entry is string => typeof entry === "string")
    : [];
  const currentChains: Record<string, string[]> = {};
  const retry = config.retry;
  const configuredChains = retry !== null && typeof retry === "object" && !Array.isArray(retry)
    ? (retry as Record<string, unknown>).fallbackChains
    : undefined;
  if (configuredChains !== null && typeof configuredChains === "object" && !Array.isArray(configuredChains)) {
    for (const [key, chain] of Object.entries(configuredChains)) {
      if (Array.isArray(chain)) currentChains[key] = chain.filter((entry): entry is string => typeof entry === "string");
    }
  }

  const sections = request.sections;
  const wantProviders = sections.includes("providers");
  const wantRoles = sections.includes("roles");
  const wantEnabled = sections.includes("enabledModels");

  // Providers merge per id; a remote-only block survives unless `prune`.
  const nextProviders = wantProviders
    ? { ...(request.prune ? {} : currentProviders), ...request.payload.providers }
    : currentProviders;
  const nextRoles = wantRoles ? request.payload.roles : currentRoles;
  const nextEnabled = wantEnabled ? request.payload.enabledModels : currentEnabled;
  const nextChains = wantRoles ? request.payload.fallbackChains : currentChains;

  const applied: SyncApplyResult["applied"] = {
    providers: wantProviders
      ? diffRecord(currentProviders, nextProviders)
      : { added: [], updated: [], removed: [], unchanged: Object.keys(currentProviders) },
    roles: wantRoles
      ? diffRecord(currentRoles, nextRoles)
      : { added: [], updated: [], removed: [], unchanged: Object.keys(currentRoles) },
    enabledModels: wantEnabled
      ? {
        added: nextEnabled.filter((entry) => !currentEnabled.includes(entry)),
        removed: currentEnabled.filter((entry) => !nextEnabled.includes(entry)),
        unchanged: nextEnabled.filter((entry) => currentEnabled.includes(entry)),
      }
      : { added: [], removed: [], unchanged: [...currentEnabled] },
    fallbackChains: wantRoles
      ? diffRecord(currentChains, nextChains)
      : { added: [], updated: [], removed: [], unchanged: Object.keys(currentChains) },
  };

  const providerChanges = applied.providers.added.length + applied.providers.updated.length + applied.providers.removed.length;
  const roleChanges = applied.roles.added.length + applied.roles.updated.length + applied.roles.removed.length
    + applied.fallbackChains.added.length + applied.fallbackChains.updated.length + applied.fallbackChains.removed.length;
  const allowListChanges = applied.enabledModels.added.length + applied.enabledModels.removed.length;
  // Every requested section counts: a run whose first section is already in
  // sync must still write the section that did change.
  const changed = (wantProviders && providerChanges > 0)
    || (wantRoles && roleChanges > 0)
    || (wantEnabled && allowListChanges > 0);

  const issues = collectIssues(sections, request.payload, deps);
  // `warnings` stays the cross-version wire form (an older gateway or target
  // only understands the English line); the wizard words `issues` itself.
  const warnings = issues.map((issue) => issue.kind === "missing_key"
    ? `${issue.envVar} missing — provider ${issue.provider} will sync but run degraded`
    : `${issue.provider} not logged in — roles/allow-list entries fall back through retry.fallbackChains`);
  const backupPaths: string[] = [];

  if (!request.dryRun && changed) {
    const modelsText = readText(modelsPath);
    if (modelsText !== null) {
      const backup = `${modelsPath}.bak.sync-${now.toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(modelsPath, backup);
      backupPaths.push(backup);
    }
    const configText = readText(configPath);
    if (configText !== null) {
      const backup = `${configPath}.bak.sync-${now.toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(configPath, backup);
      backupPaths.push(backup);
    }

    const nextModels: Record<string, unknown> = { ...models };
    if (wantProviders) nextModels.providers = nextProviders;
    mkdirSync(dirname(modelsPath), { recursive: true });
    writePrivateFileAtomicSync(modelsPath, stringifyYaml(nextModels, { lineWidth: 0 }));

    const nextConfig: Record<string, unknown> = { ...config };
    if (wantRoles) {
      nextConfig.modelRoles = nextRoles;
      nextConfig.retry = {
        ...(config.retry !== null && typeof config.retry === "object" && !Array.isArray(config.retry)
          ? config.retry as Record<string, unknown>
          : {}),
        fallbackChains: nextChains,
      };
    }
    if (wantEnabled) nextConfig.enabledModels = nextEnabled;
    mkdirSync(dirname(configPath), { recursive: true });
    writePrivateFileAtomicSync(configPath, stringifyYaml(nextConfig, { lineWidth: 0 }));

    // The registry caches models.yml and Settings caches config.yml at
    // construction; drop both so the next request rebuilds against the edit.
    invalidateModelsCache();
    invalidateOmpRuntime();
  }

  return {
    dryRun: request.dryRun,
    schemaVersion: SYNC_SCHEMA_VERSION,
    changed,
    applied,
    issues,
    warnings,
    backupPaths,
  };
}