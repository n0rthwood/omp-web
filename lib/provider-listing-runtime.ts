import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { providerEntries } from "@oh-my-pi/pi-catalog/compat/providers";
import type { ProviderCredentialType, ProviderListingInput } from "@/lib/provider-listing";
import { getOmpRuntime } from "@/lib/omp-runtime";

/**
 * Adapter between omp's runtime services and the pure listing helpers in
 * `lib/provider-listing.ts`.
 *
 * omp splits what pi kept in one `ModelRuntime`: the model catalog lives in
 * `ModelRegistry` / `@oh-my-pi/pi-catalog`, OAuth capability lives in the
 * `pi-ai` OAuth registry, and credentials live in `AuthStorage` (SQLite). This
 * folds those three back into the flat shape the listing helpers expect.
 */
export async function collectProviderListingInputs(): Promise<ProviderListingInput[]> {
  const { modelRegistry, authStorage } = await getOmpRuntime();
  const models = modelRegistry.getAll();

  const modelCounts = new Map<string, number>();
  for (const model of models) {
    modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
  }

  // An OAuth login may store its credential under a different provider id
  // (e.g. `openai-codex-device` ⇒ `openai-codex`); key by the id the model
  // catalog actually uses so a logged-in provider is not listed twice.
  const oauthByProvider = new Map<string, { id: string; name: string }>();
  for (const provider of getOAuthProviders()) {
    if (!provider.available) continue;
    oauthByProvider.set(provider.storeCredentialsAs ?? provider.id, {
      id: provider.id,
      name: provider.name,
    });
  }

  const descriptorsById = new Map(PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.providerId, descriptor]));
  // Catalog seeds carry the base URL and API kind the add-provider flow
  // prefills; the first seed is representative because a provider entry shares
  // one endpoint across its models.
  const catalogById = new Map<string, { baseUrl?: string; api?: string; envVar?: string }>();
  for (const [id, entry] of Object.entries(providerEntries())) {
    const seed = entry.seed?.models[0];
    catalogById.set(id, {
      ...(seed?.baseUrl ? { baseUrl: seed.baseUrl } : {}),
      ...(seed?.api ? { api: seed.api } : {}),
      ...(entry.envVars?.[0] ? { envVar: entry.envVars[0] } : {}),
    });
  }
  const ids = new Set<string>([
    ...modelCounts.keys(),
    ...oauthByProvider.keys(),
    ...descriptorsById.keys(),
  ]);

  const credentialTypes = new Map<string, ProviderCredentialType>();
  for (const id of ids) {
    const stored = authStorage.credentials.list(id);
    const type: ProviderCredentialType | undefined = stored.some((entry) => entry.credential.type === "oauth")
      ? "oauth"
      : stored.length > 0
        ? "api_key"
        : undefined;
    if (type) credentialTypes.set(id, type);
  }

  // A credential that was disabled — a failed refresh, a deleted key — stays
  // behind as a tombstone. The summaries carry no secret: provider and cause.
  const tombstoned = new Set((await authStorage.credentials.listDisabled()).map((row) => row.provider));

  return [...ids].sort().map((id) => {
    const oauth = oauthByProvider.get(id);
    const origin = authStorage.keys.source(id);
    return {
      id,
      name: oauth?.name ?? id,
      // Every catalog provider accepts a bearer key; OAuth-only logins do not.
      hasApiKeyLogin: descriptorsById.has(id) || modelCounts.has(id),
      hasOAuth: Boolean(oauth),
      ...(oauth?.name ? { oauthName: oauth.name } : {}),
      status: {
        configured: Boolean(origin?.concrete),
        ...(origin?.kind ? { source: origin.kind } : {}),
        ...(origin?.envVar ? { envVar: origin.envVar } : {}),
      },
      ...(credentialTypes.has(id) ? { credentialType: credentialTypes.get(id) } : {}),
      ...(tombstoned.has(id) ? { hasCredentialHistory: true } : {}),
      modelCount: modelCounts.get(id) ?? 0,
      ...catalogById.get(id),
    };
  });
}

/** OAuth login ids keyed by the provider whose credentials they store. */
export function resolveOAuthLoginId(provider: string): string | undefined {
  for (const candidate of getOAuthProviders()) {
    if (!candidate.available) continue;
    if ((candidate.storeCredentialsAs ?? candidate.id) === provider) return candidate.id;
  }
  return undefined;
}
