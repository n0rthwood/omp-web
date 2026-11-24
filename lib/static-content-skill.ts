import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { getOmpSetting, overrideOmpSetting } from "./omp-setting-access";

const BUILTIN_SKILLS_RELATIVE_PATH = "skills";

/**
 * Resolve the package-tree skills parent from this helper's directory, not
 * from a session/project cwd. The cwd fallback is for bundled/dev launches
 * where Bun does not provide import.meta.dir; the web launcher pins that cwd
 * to the package root.
 */
export function resolveBuiltinSkillsDirectory(
  moduleDirectory: string | undefined = import.meta.dir,
  launchDirectory: string = process.cwd(),
): string {
  const candidates = [
    ...(moduleDirectory ? [resolve(moduleDirectory, "..", BUILTIN_SKILLS_RELATIVE_PATH)] : []),
    resolve(launchDirectory, BUILTIN_SKILLS_RELATIVE_PATH),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "static-content", "SKILL.md"))) return candidate;
  }
  throw new Error(`Built-in static-content skill is missing from the package tree (checked: ${candidates.join(", ")})`);
}

/**
 * Append a directory without changing the user's ordering or replacing any
 * configured custom skill directories. A duplicate is left as-is so a user
 * config that already names the package directory stays stable.
 */
export function appendStaticContentSkillDirectory(
  customDirectories: readonly string[] | undefined,
  skillDirectory: string,
): string[] {
  const directories = Array.isArray(customDirectories) ? [...customDirectories] : [];
  return directories.includes(skillDirectory) ? directories : [...directories, skillDirectory];
}

/** Apply the built-in directory only to this session's Settings clone. */
export function injectStaticContentSkill(settings: Settings, moduleDirectory?: string): void {
  const skillDirectory = resolveBuiltinSkillsDirectory(moduleDirectory);
  const configured = getOmpSetting<string[] | undefined>(settings, "skills.customDirectories");
  overrideOmpSetting(
    settings,
    "skills.customDirectories",
    appendStaticContentSkillDirectory(configured, skillDirectory),
  );
}
