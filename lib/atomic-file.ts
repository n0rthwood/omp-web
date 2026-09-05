import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

export interface FileLockOptions {
  /** Max time to wait to acquire the lock before giving up, in ms. */
  timeoutMs?: number;
  /** A held lock older than this is presumed abandoned by a crashed holder
   * and is stolen rather than waited on forever. */
  staleMs?: number;
  /** Delay between acquisition retries while the lock is held and fresh. */
  pollIntervalMs?: number;
}

// A normal critical section here is a few KB of JSON parse/stringify plus an
// atomic rename — sub-millisecond even under load. 5s bounds a caller's wait
// so a contended login can't hang a request forever; 10s (comfortably above
// the 5s wait, so a live-but-slow holder is never mistaken mid-wait for a
// crash) is how long a lock can sit before it's presumed abandoned by a
// process that died inside the critical section and is reclaimed so a crash
// can't wedge every future acquirer.
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 20;

/** Lock paths currently held by this process, for same-process reentrancy. */
const heldLocks = new Set<string>();

function acquireFileLockSync(lockPath: string, options: Required<FileLockOptions>): string {
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + options.timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released between our attempts; retry now
      throw error;
    }
    if (ageMs > options.staleMs) {
      // Previous holder crashed mid-critical-section: reclaim so a dead
      // process can't wedge every future login behind it forever.
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${options.timeoutMs}ms waiting for lock: ${lockPath}`);
    }
    // Synchronous, non-busy-spin sleep: Atomics.wait blocks the thread on a
    // scratch buffer nobody else touches, no dependency required.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.pollIntervalMs);
  }
}

function releaseFileLockSync(lockPath: string, token: string): void {
  try {
    // Only remove the lock if it still holds our token — if it was stolen as
    // stale out from under us (we ran long, another acquirer reclaimed it),
    // it now belongs to whoever holds it and we must not delete their lock.
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Run `fn` while holding an exclusive, cross-process lock on `lockPath` — an
 * `O_CREAT|O_EXCL` lockfile (`fs.openSync(path, "wx")`) next to whatever it
 * protects, no external lock manager or new dependency required.
 *
 * - Bounded wait (`timeoutMs`, default 5s): throws rather than hanging a
 *   request forever if the lock stays held.
 * - Stale takeover (`staleMs`, default 10s): a lock older than this is
 *   assumed abandoned by a crashed holder and reclaimed, so a dead process
 *   can't wedge acquisition permanently.
 * - Always released in `finally`, and only by whoever's token is still on
 *   disk, so a false-stale holder that wakes up late never deletes the new
 *   owner's lock.
 * - Reentrant within one process: a nested call for the same `lockPath` on
 *   the same synchronous call stack reuses the outer lock instead of
 *   deadlocking on itself.
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T {
  if (heldLocks.has(lockPath)) return fn();
  const resolved: Required<FileLockOptions> = {
    timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS,
  };
  const token = acquireFileLockSync(lockPath, resolved);
  heldLocks.add(lockPath);
  try {
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    releaseFileLockSync(lockPath, token);
  }
}
