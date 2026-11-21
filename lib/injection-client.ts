// #116: browser helpers shared by the injection card and the settings panel.
import { apiPath } from "./api-path";
import type { InjectionClassification } from "./injection-sources";
import type { InjectionSettingPatch, InjectionSettingResult, InjectionSettingsResponse } from "./settings-api";

/** window event that opens the injection settings panel (detail: { cwd? }). */
export const OPEN_INJECTION_SETTINGS_EVENT = "omp:open-injection-settings";

export function openInjectionSettings(cwd?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_INJECTION_SETTINGS_EVENT, { detail: { cwd } }));
}

/** window event fired after any successful injection-setting write. */
export const INJECTION_SETTINGS_CHANGED_EVENT = "omp:injection-settings-changed";

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export async function fetchInjectionSettings(cwd: string | null): Promise<InjectionSettingsResponse> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  return parse<InjectionSettingsResponse>(await fetch(apiPath(`/api/settings/injections${query}`), { cache: "no-store" }));
}

export async function patchInjectionSetting(patch: InjectionSettingPatch): Promise<InjectionSettingResult> {
  const result = await parse<InjectionSettingResult>(await fetch(apiPath("/api/settings/injections"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
  window.dispatchEvent(new CustomEvent(INJECTION_SETTINGS_CHANGED_EVENT));
  return result;
}

/** The PATCH that turns a classified injection off at `scope`. */
export function disablePatch(
  injection: InjectionClassification,
  scope: "global" | "project",
  cwd: string | undefined,
): InjectionSettingPatch | null {
  const setting = injection.setting;
  if (!setting) return null;
  const base = { path: setting.path, scope, cwd: scope === "project" ? cwd : undefined };
  if (setting.kind === "append-rule") return injection.rule ? { ...base, appendRule: injection.rule } : null;
  return { ...base, value: setting.offValue };
}
