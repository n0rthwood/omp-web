// #116: server side of the injection settings panel and the per-card
// "disable globally / for this project" buttons.
//
// Global writes go through omp's own Settings (same path as PATCH
// /api/settings); project writes edit `<cwd>/.omp/config.yml` through
// lib/project-config.ts because the SDK only persists project `modelRoles`.
import "@oh-my-pi/pi-coding-agent/config/all-settings";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { injectionSwitches, INJECTION_SOURCES, type InjectionSwitch } from "./injection-sources";
import { getOmpRuntime, invalidateOmpRuntime } from "./omp-runtime";
import { ompSetting, setOmpSetting } from "./omp-setting-access";
import { projectConfigPath, readProjectConfigValue, updateProjectConfigValue, writeProjectConfigValue } from "./project-config";
import type { InjectionSettingPatch, InjectionSettingResult, InjectionSettingsResponse, InjectionSwitchState, SettingsValue } from "./settings-api";

/** TTSR rule names are file stems; refuse anything that is not. */
const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export class InjectionSettingError extends Error {}

function rawAt(record: unknown, segments: readonly string[]): unknown {
  let current = record;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function serializable(value: unknown): SettingsValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return null;
}

function switchFor(path: string): InjectionSwitch {
  const entry = injectionSwitches().find((candidate) => candidate.path === path);
  if (!entry) throw new InjectionSettingError("Not an injection setting");
  return entry;
}

function stateFor(entry: InjectionSwitch, global: Settings, scoped: Settings, cwd: string | null): InjectionSwitchState {
  const setting = ompSetting(entry.path);
  const enumValues = (setting as { enumValues?: readonly string[] }).enumValues;
  return {
    path: entry.path,
    kind: entry.setting.kind,
    offValue: entry.setting.kind === "value" ? entry.setting.offValue : undefined,
    effect: entry.effect,
    sourceIds: entry.sourceIds,
    label: setting.ui?.label ?? entry.path,
    description: setting.ui?.description ?? entry.sourceIds.map((id) => INJECTION_SOURCES[id].label).join(", "),
    options: enumValues ? [...enumValues] : undefined,
    defaultValue: serializable(setting.default),
    global: serializable(rawAt(global.getGlobalSettings(), entry.path.split("."))),
    project: cwd ? serializable(readProjectConfigValue(cwd, entry.path)) : null,
    effective: serializable(setting.get(scoped)),
  };
}

/** Current global / project / effective value of every mapped switch. */
export async function readInjectionSettings(cwd: string | null): Promise<InjectionSettingsResponse> {
  const { settings } = await getOmpRuntime();
  const scoped = cwd && settings.getCwd() !== cwd ? await settings.cloneForCwd(cwd) : settings;
  return {
    cwd,
    projectConfigPath: cwd ? projectConfigPath(cwd) : null,
    switches: injectionSwitches().map((entry) => stateFor(entry, settings, scoped, cwd)),
  };
}

function validateValue(entry: InjectionSwitch, value: unknown): boolean | string {
  const setting = ompSetting(entry.path);
  if (setting.type === "boolean") {
    if (typeof value !== "boolean") throw new InjectionSettingError("Expected a boolean");
    return value;
  }
  if (setting.type === "enum") {
    const allowed = (setting as { enumValues?: readonly string[] }).enumValues ?? [];
    if (typeof value !== "string" || !allowed.includes(value)) throw new InjectionSettingError("Invalid option");
    return value;
  }
  throw new InjectionSettingError("Unsupported setting type");
}

function ruleList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Apply one panel/card write. `cwd` must already be validated against the
 * allowed file roots by the caller. Returns the switch's new state.
 */
export async function applyInjectionSetting(patch: InjectionSettingPatch, cwd: string | null): Promise<InjectionSettingResult> {
  const entry = switchFor(patch.path);
  if (patch.scope !== "global" && patch.scope !== "project") throw new InjectionSettingError("Invalid scope");
  if (patch.scope === "project" && !cwd) throw new InjectionSettingError("Project scope requires a cwd");

  const { settings } = await getOmpRuntime();
  let next: unknown;
  if (patch.clear === true) {
    next = undefined;
  } else if (entry.setting.kind === "append-rule") {
    const rule = patch.appendRule ?? patch.removeRule;
    if (typeof rule !== "string" || !RULE_NAME.test(rule)) throw new InjectionSettingError("Invalid rule name");
    // A project list replaces the global one in omp's merge, so seed a new
    // project list from the effective value — otherwise globally disabled
    // rules would silently come back for this project.
    const base = patch.scope === "global"
      ? ruleList(rawAt(settings.getGlobalSettings(), entry.path.split(".")))
      : ruleList(readProjectConfigValue(cwd!, entry.path) ?? ompSetting(entry.path).get(await settings.cloneForCwd(cwd!)));
    next = patch.appendRule !== undefined
      ? [...new Set([...base, rule])]
      : base.filter((item) => item !== rule);
  } else {
    next = validateValue(entry, patch.value);
  }

  let gitignoreUpdated = false;
  let writtenPath: string;
  if (patch.scope === "global") {
    if (next === undefined) settings.unsetGlobalValue(ompSetting(entry.path));
    else setOmpSetting(settings, entry.path, next);
    await settings.flush();
    writtenPath = "~/.omp/agent/config.yml";
  } else {
    const written = entry.setting.kind === "append-rule" && patch.clear !== true
      ? updateProjectConfigValue(cwd!, entry.path, (current) => {
        const base = ruleList(current ?? next);
        return patch.appendRule !== undefined ? [...new Set([...base, patch.appendRule])] : base.filter((item) => item !== patch.removeRule);
      })
      : writeProjectConfigValue(cwd!, entry.path, next);
    gitignoreUpdated = written.gitignoreUpdated;
    writtenPath = written.filePath;
    // Project layers are cached by cloneForCwd consumers; rebuild on next use.
    invalidateOmpRuntime();
  }
  const fresh = await getOmpRuntime();
  const scoped = cwd && fresh.settings.getCwd() !== cwd ? await fresh.settings.cloneForCwd(cwd) : fresh.settings;
  return { state: stateFor(entry, fresh.settings, scoped, cwd), writtenPath, gitignoreUpdated };
}
