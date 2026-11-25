import type { ProviderSource } from "./types";
import type { ApiKeyProvider, OAuthProvider, ProviderEntry } from "./types";

/** One provider in the left column, merged across the three config layers. */
export interface ProviderRow {
  id: string;
  name: string;
  sources: ProviderSource[];
  configured: boolean;
  loggedIn: boolean;
  modelCount: number;
  /** `override` = models.yml covers a catalog provider; `custom` = models.yml only. */
  tag?: "override" | "custom";
  oauth?: OAuthProvider;
  apiKey?: ApiKeyProvider;
  config?: ProviderEntry;
}

/** The layer a row is listed under: models.yml first, then subscription, then key. */
export function providerRowGroup(row: ProviderRow): ProviderSource {
  if (row.config) return "config";
  if (row.loggedIn) return "oauth";
  return "api_key";
}

/**
 * Merge the three provider listings into one row per provider id.
 *
 * The catalog and `models.yml` both describe e.g. `zhipu-coding-plan`; keying
 * by id is what removes the duplicate row the old tree showed, and the config
 * layer wins because that is the file this panel edits. Rows with no
 * configuration at all (a catalog provider you have not logged into) are
 * dropped — they are reachable from "+ Add provider" instead.
 */
export function mergeProviderRows(
  oauthProviders: readonly OAuthProvider[],
  apiKeyProviders: readonly ApiKeyProvider[],
  configProviders: Readonly<Record<string, ProviderEntry | undefined>>,
): ProviderRow[] {
  const catalogIds = new Set<string>([
    ...oauthProviders.map((provider) => provider.id),
    ...apiKeyProviders.map((provider) => provider.id),
  ]);
  const byId = new Map<string, ProviderRow>();
  const ensure = (id: string): ProviderRow => {
    const existing = byId.get(id);
    if (existing) return existing;
    const row: ProviderRow = { id, name: id, sources: [], configured: false, loggedIn: false, modelCount: 0 };
    byId.set(id, row);
    return row;
  };

  for (const provider of oauthProviders) {
    const row = ensure(provider.id);
    if (!row.sources.includes("oauth")) row.sources.push("oauth");
    row.oauth = provider;
    row.loggedIn = row.loggedIn || provider.loggedIn;
    if (row.name === row.id) row.name = provider.name;
  }
  for (const provider of apiKeyProviders) {
    const row = ensure(provider.id);
    if (!row.sources.includes("api_key")) row.sources.push("api_key");
    row.apiKey = provider;
    row.configured = row.configured || provider.configured;
    row.modelCount = Math.max(row.modelCount, provider.modelCount);
    if (row.name === row.id) row.name = provider.displayName;
  }
  for (const [id, entry] of Object.entries(configProviders)) {
    if (!entry) continue;
    const row = ensure(id);
    if (!row.sources.includes("config")) row.sources.push("config");
    row.config = entry;
    row.name = id;
    row.tag = catalogIds.has(id) ? "override" : "custom";
  }

  return [...byId.values()].filter((row) => row.config || row.loggedIn || row.configured);
}