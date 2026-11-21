/** Browser-safe prompt workspace contracts. Managed defaults affect new conversations. */
export const PROMPT_KEYS = ["baseTemplate", "append", "planningGuidance", "afterPlanApproval"] as const;
export type PromptKey = typeof PROMPT_KEYS[number];
export type PromptValues = Partial<Record<PromptKey, string>>;
export type PromptScope = "global" | "project";
export interface PromptScopeState { etag: string; values: PromptValues; path: string; baseOrigin?: { sdkVersion: string; templateHash: string } }
export interface PromptSource {
  id: string;
  label: string;
  group: string;
  content?: string;
  path?: string;
  format: "markdown" | "template";
  readOnlyReason: string;
}
export interface PromptCatalog {
  cwd: string | null;
  sdkVersion: string;
  sdkTemplateHash: string;
  revision: string;
  scopes: { global: PromptScopeState; project: PromptScopeState | null };
  effective: Record<PromptKey, { value: string | null; scope: PromptScope | "sdk" }>;
  sources: PromptSource[];
  presets: Array<{ id: string; label: string; description: string; values: PromptValues }>;
  appliesTo: "new-conversations";
}
export interface PromptSaveRequest {
  cwd?: string | null;
  scope: PromptScope;
  etag: string;
  values: Partial<Record<PromptKey, string | null>>;
}
export interface PromptPreview { text: string; kind: "example" | "literal"; note: string }
export interface PromptProfileMarker {
  schemaVersion: 1;
  profileId: string;
  digest: string;
  savedAt: string;
}
export interface PromptInspection {
  sessionId: string;
  profile: PromptProfileMarker | null;
  status: "managed" | "legacy" | "unavailable";
  /** Raw pinned sources: returned only by the admin-owned inspector endpoint. */
  managedValues?: PromptValues | null;
  systemPromptBlocks: string[] | null;
  observation: string;
  instructions: Array<{ id?: string; role: string; source: string; content: string }>;
  note?: string;
}
