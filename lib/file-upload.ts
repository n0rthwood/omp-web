import fs from "fs";
import path from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

const BINARY_UPLOAD_EXTENSIONS = new Set([
  "zip", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff",
  "pdf", "exe", "dll", "so", "dylib", "jar", "class", "war", "ear",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "wav", "flac", "ogg",
  "mp4", "mov", "avi", "mkv", "webm", "sqlite", "db", "wasm", "bin",
  "iso", "dmg", "pkg", "deb", "rar", "7z", "gz", "xz", "bz2", "zst",
]);

const UPLOAD_BINARY_HEADER_SNIFF_BYTES = 8192;

/** Extension-based pre-judgment: known-binary file types, checked before reading content. */
export function isBinaryUploadName(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  return BINARY_UPLOAD_EXTENSIONS.has(ext);
}

/**
 * Content-based binary check for files an extension does not already flag.
 * A NUL byte anywhere in the first 8KB marks the file binary; encoding
 * validity is never checked, so non-UTF-8 text (GBK, Shift-JIS, ...) passes.
 */
export function looksBinaryHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, UPLOAD_BINARY_HEADER_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * First filesystem path in `dir` not already occupied by `name`, suffixing
 * before the extension on collision: file.txt -> file-1.txt -> file-2.txt.
 * The caller still writes with an exclusive flag — this only picks the
 * first guess; a losing race falls back to recomputing from the taken name.
 */
export function nextAvailableUploadPath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  let suffix = 0;
  while (fs.existsSync(path.join(dir, candidate))) {
    suffix += 1;
    candidate = `${base}-${suffix}${ext}`;
  }
  return path.join(dir, candidate);
}

// Same shape as the uploads route's own session-id check (app/api/agent/[id]/uploads) —
// looser than the strict UUID check session-file-references uses, since it must match
// the id that route already used to name the on-disk upload directory.
const UPLOAD_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * True when `filePath` sits inside `sessionId`'s permanent upload directory
 * (~/.omp/agent/uploads/<sessionId>/). Lets a file the user just uploaded to
 * a session be reopened even before the SDK's @-mention pipeline has made it
 * a recognized session reference.
 */
export function isPathInSessionUploadDir(filePath: string, sessionId: string | null): boolean {
  if (sessionId == null || !UPLOAD_SESSION_ID_RE.test(sessionId)) return false;
  const root = path.resolve(path.join(getAgentDir(), "uploads", sessionId));
  const target = path.resolve(filePath);
  if (target === root) return true;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(rootWithSep);
}
