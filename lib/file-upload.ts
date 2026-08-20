import fs from "fs";
import path from "path";

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

const BINARY_UPLOAD_EXTENSIONS: Record<string, true> = {
  zip: true, png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true, ico: true, tiff: true,
  pdf: true, exe: true, dll: true, so: true, dylib: true, jar: true, class: true, war: true, ear: true,
  woff: true, woff2: true, ttf: true, otf: true, eot: true, mp3: true, wav: true, flac: true, ogg: true,
  mp4: true, mov: true, avi: true, mkv: true, webm: true, sqlite: true, db: true, wasm: true, bin: true,
  iso: true, dmg: true, pkg: true, deb: true, rar: true, "7z": true, gz: true, xz: true, bz2: true, zst: true,
};

const UPLOAD_BINARY_HEADER_SNIFF_BYTES = 8192;

/** Extension-based pre-judgment: known-binary file types, checked before reading content. */
export function isBinaryUploadName(name: string): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext in BINARY_UPLOAD_EXTENSIONS;
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
