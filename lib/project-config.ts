// Shared project setting persistence for conversation injection controls and Settings → Prompts.
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import { isMap, parseDocument } from "yaml";
import { withFileLockSync, writePrivateFileAtomicSync } from "./atomic-file";

export function projectConfigPath(cwd: string): string {
  const root = realpathSync(cwd);
  const file = join(getProjectAgentDir(root), "config.yml");
  const part = relative(root, file);
  if (part.startsWith("..") || part.startsWith("/")) throw new Error("Project configuration is outside the project");
  for (const path of [dirname(file), file]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("Project configuration must not be a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return file;
}
function readText(file: string): string | null {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function parseConfig(text: string) {
  if (text.length > 1_048_576) throw new Error("Project configuration is too large");
  const doc = parseDocument(text);
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error("Project configuration must be valid YAML with a mapping at the top level");
  return doc;
}
export function readProjectConfigValue(cwd: string, settingPath: string): unknown {
  const text = readText(projectConfigPath(cwd));
  if (text === null) return undefined;
  const node = parseConfig(text).getIn(settingPath.split("."), true);
  return node && typeof node === "object" && "toJSON" in node ? (node as { toJSON(): unknown }).toJSON() : node;
}
export interface ProjectConfigWrite { filePath: string; gitignoreUpdated: boolean }
export function updateProjectConfigValue(cwd: string, settingPath: string, update: (current: unknown) => unknown): ProjectConfigWrite {
  const file = projectConfigPath(cwd);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${file}.lock`, () => {
    projectConfigPath(cwd);
    const text = readText(file);
    const doc = parseConfig(text ?? "");
    const node = doc.getIn(settingPath.split("."), true);
    const current = node && typeof node === "object" && "toJSON" in node ? (node as { toJSON(): unknown }).toJSON() : node;
    const value = update(current);
    if (text === null && value === undefined) return { filePath: file, gitignoreUpdated: false };
    if (value === undefined) doc.deleteIn(settingPath.split("."));
    else doc.setIn(settingPath.split("."), value);
    writePrivateFileAtomicSync(file, doc.toString());
    return { filePath: file, gitignoreUpdated: false };
  });
}

export function writeProjectConfigValue(cwd: string, settingPath: string, value: unknown): ProjectConfigWrite {
  return updateProjectConfigValue(cwd, settingPath, () => value);
}
