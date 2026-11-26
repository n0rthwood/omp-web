/**
 * Provider label for the model UIs (#147): the display name when the caller
 * knows one, otherwise the raw provider id.
 *
 * The hidden-model popover and the allow-list overview read their names from
 * different sources (the provider-status snapshot, the catalog/OAuth lists), so
 * the lookup is injected and the fallback rule lives here once.
 */
export function providerLabel(provider: string, names?: Record<string, string>): string {
  return names && Object.hasOwn(names, provider) ? names[provider] : provider;
}