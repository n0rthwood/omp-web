export type SettingsValue = boolean | string | number | string[] | Record<string, number> | null;

export interface SettingsOption {
  value: string;
  label: string;
  description?: string;
}

export type SettingsFieldType =
  | "boolean"
  | "select"
  | "text"
  | "secret"
  | "multiselect"
  | "providerLimits";

export interface SettingsField {
  path: string;
  tab: string;
  group?: string;
  label: string;
  description: string;
  type: SettingsFieldType;
  value: SettingsValue;
  defaultValue: SettingsValue;
  configured: boolean;
  options?: SettingsOption[];
  ordered?: boolean;
  condition?: string;
}

export interface SettingsTab {
  id: string;
  label: string;
  groups: string[];
}

export interface WebThemePalette {
  name: string;
  colorScheme: "dark" | "light";
  variables: Record<string, string>;
}

export interface WebThemeConfig {
  names: { dark: string; light: string };
  palettes: { dark: WebThemePalette; light: WebThemePalette };
}

export interface SettingsResponse {
  tabs: SettingsTab[];
  fields: SettingsField[];
  availableThemes: Array<{ name: string; colorScheme: "dark" | "light" }>;
  theme: WebThemeConfig;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  enabled?: boolean;
  timeout?: number;
  type?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: Record<string, unknown>;
  oauth?: Record<string, unknown>;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  editable?: boolean;
  source?: {
    path: string;
    provider: string;
    level: "user" | "project" | "native";
  };
}

export interface McpScopeConfig {
  scope: "user" | "project";
  path: string;
  servers: McpServerEntry[];
  error?: string;
}

export interface McpConfigResponse {
  user: McpScopeConfig;
  project: McpScopeConfig | null;
}

/** #116: one injection switch with its per-layer values (`/api/settings/injections`). */
export interface InjectionSwitchState {
  path: string;
  kind: "value" | "append-rule";
  /** `kind: "value"` only: the value that turns the injection off. */
  offValue?: boolean | string;
  effect: "next-turn" | "new-session";
  sourceIds: string[];
  label: string;
  description: string;
  options?: string[];
  defaultValue: SettingsValue;
  /** Raw value in `~/.omp/agent/config.yml` (null = unset). */
  global: SettingsValue;
  /** Raw value in `<cwd>/.omp/config.yml` (null = unset or no cwd). */
  project: SettingsValue;
  /** Effective value for `cwd` (or the global scope without one). */
  effective: SettingsValue;
}

export interface InjectionSettingsResponse {
  cwd: string | null;
  projectConfigPath: string | null;
  switches: InjectionSwitchState[];
}

export interface InjectionSettingPatch {
  path: string;
  scope: "global" | "project";
  /** Required for `scope: "project"`. */
  cwd?: string;
  /** Set this value (`kind: "value"` switches). */
  value?: boolean | string;
  /** Append a rule name (`ttsr.disabledRules`). */
  appendRule?: string;
  /** Remove a rule name (`ttsr.disabledRules`). */
  removeRule?: string;
  /** Drop the scope's own value so the lower layer / default applies. */
  clear?: boolean;
}

export interface InjectionSettingResult {
  state: InjectionSwitchState;
  /** The config file the write landed in. */
  writtenPath: string;
  /** Project scope only: `.omp/` was appended to the project's .gitignore. */
  gitignoreUpdated: boolean;
}
