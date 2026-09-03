import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

async function loadSubject() {
  return import("./web-sessions.ts");
}

/** Point the store at a fresh temp file and drop the module cache. */
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-sessions-"));
  const file = join(dir, "sessions.json");
  process.env.OMP_WEB_SESSIONS_FILE = file;
  globalThis.__ompWebSessions = undefined;
  return { dir, file };
}

function restoreStore(dir) {
  delete process.env.OMP_WEB_SESSIONS_FILE;
  globalThis.__ompWebSessions = undefined;
  rmSync(dir, { recursive: true, force: true });
}

function readStore(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function editRecord(file, raw, patch) {
  const key = createHash("sha256").update(raw, "utf8").digest("hex");
  const data = readStore(file);
  data.sessions[key] = { ...data.sessions[key], ...patch };
  writeFileSync(file, JSON.stringify(data, null, 2));
  globalThis.__ompWebSessions = undefined;
}

test("create then lookup roundtrip stores only the hash, never the raw id", async () => {
  const { createWebSession, lookupWebSession } = await loadSubject();
  const store = freshStore();
  try {
    const { raw } = createWebSession("alice");
    assert.ok(raw.length >= 40, "raw id is 32 random bytes in base64url");

    const hit = lookupWebSession(raw);
    assert.deepEqual(hit, { username: "alice" });

    const data = readStore(store.file);
    const key = createHash("sha256").update(raw, "utf8").digest("hex");
    assert.ok(data.sessions[key], "record keyed by sha256 hex of the raw id");
    assert.equal(data.sessions[key].username, "alice");
    assert.ok(!readFileSync(store.file, "utf8").includes(raw), "raw id never persisted");
  } finally {
    restoreStore(store.dir);
  }
});

test("lookup rejects unknown ids", async () => {
  const { lookupWebSession } = await loadSubject();
  const store = freshStore();
  try {
    assert.equal(lookupWebSession("totally-unknown-id"), null);
  } finally {
    restoreStore(store.dir);
  }
});

test("lookup rejects expired sessions and removes them from the store", async () => {
  const { createWebSession, lookupWebSession } = await loadSubject();
  const store = freshStore();
  try {
    const { raw } = createWebSession("bob");
    editRecord(store.file, raw, { expires: Date.now() - 1000 });
    assert.equal(lookupWebSession(raw), null);
    const key = createHash("sha256").update(raw, "utf8").digest("hex");
    assert.ok(!(key in readStore(store.file).sessions), "expired record purged on lookup");
  } finally {
    restoreStore(store.dir);
  }
});

test("revoke kills the session and is a no-op for unknown ids", async () => {
  const { createWebSession, revokeWebSession, lookupWebSession } = await loadSubject();
  const store = freshStore();
  try {
    const { raw } = createWebSession("carol");
    assert.equal(lookupWebSession(raw).username, "carol");
    revokeWebSession(raw);
    assert.equal(lookupWebSession(raw), null);
    assert.doesNotThrow(() => revokeWebSession("never-existed"));
  } finally {
    restoreStore(store.dir);
  }
});

test("sliding TTL refresh advances expires but only rewrites after 1h of idle", async () => {
  const { createWebSession, lookupWebSession } = await loadSubject();
  const store = freshStore();
  try {
    const ttlDays = 2;
    const { raw } = createWebSession("dave", ttlDays);
    const key = createHash("sha256").update(raw, "utf8").digest("hex");

    // Recent lastUsed: no rewrite, expires unchanged from creation.
    const before = readStore(store.file).sessions[key];
    lookupWebSession(raw);
    const afterRecent = readStore(store.file).sessions[key];
    assert.equal(afterRecent.expires, before.expires, "no disk rewrite within the 1h window");
    assert.equal(afterRecent.lastUsed, before.lastUsed);

    // lastUsed older than 1h: refresh advances expires and persists.
    const staleUsed = Date.now() - 2 * 60 * 60 * 1000;
    editRecord(store.file, raw, { lastUsed: staleUsed, expires: Date.now() + 60_000 });
    const refreshed = lookupWebSession(raw, ttlDays);
    assert.equal(refreshed.username, "dave");
    const record = readStore(store.file).sessions[key];
    assert.ok(record.expires > Date.now(), "expires slid into the future");
    assert.ok(record.lastUsed > staleUsed, "lastUsed refreshed on disk");
  } finally {
    restoreStore(store.dir);
  }
});

test("purge removes expired sessions and keeps live ones", async () => {
  const { createWebSession, purgeExpiredWebSessions, lookupWebSession } = await loadSubject();
  const store = freshStore();
  try {
    const live = createWebSession("erin").raw;
    const dead = createWebSession("frank").raw;
    editRecord(store.file, dead, { expires: Date.now() - 1 });

    purgeExpiredWebSessions();
    assert.equal(lookupWebSession(live).username, "erin");
    assert.equal(lookupWebSession(dead), null);
  } finally {
    restoreStore(store.dir);
  }
});

test("cookieAttrs omits Secure for loopback and private-IP hosts, adds it for public hosts", async () => {
  const { cookieAttrs } = await loadSubject();
  const nonPublic = [
    "localhost",
    "127.0.0.1",
    "::1",
    "localhost:30141",
    "[::1]:5010",
    // RFC1918 private IPv4 — fleet remotes serve plain HTTP on these.
    "172.30.3.110",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1:5010",
  ];
  for (const host of nonPublic) {
    const attrs = cookieAttrs(host);
    assert.match(attrs, /^Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/, `${host}: no Secure`);
    assert.ok(!attrs.includes("Secure"), `${host}: no Secure anywhere`);
  }

  const publicAttrs = cookieAttrs("omp.joyai.dev");
  assert.equal(publicAttrs, "Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure");

  // A public (non-RFC1918) IPv4 still gets Secure.
  assert.ok(cookieAttrs("172.15.0.1").endsWith("; Secure"), "public IPv4 keeps Secure");
  assert.ok(cookieAttrs("8.8.8.8").endsWith("; Secure"), "public IPv4 keeps Secure");

  // Unknown host (no request context) defaults to the safe public form.
  assert.ok(cookieAttrs(null).endsWith("; Secure"));

  // Custom TTL flows into Max-Age.
  assert.match(cookieAttrs("omp.joysort.cn", 7), /Max-Age=604800; Secure$/);
});

test("createWebSession returns cookie attrs and the store path honors OMP_WEB_SESSIONS_FILE", async () => {
  const { createWebSession, WEB_SESSION_COOKIE } = await loadSubject();
  const store = freshStore();
  try {
    assert.equal(WEB_SESSION_COOKIE, "omp-web-session");

    const result = createWebSession("gina");
    assert.ok(result.cookieAttrs.startsWith("Path=/; HttpOnly; SameSite=Lax;"), "attrs for Set-Cookie");
    assert.ok(result.cookieAttrs.endsWith("; Secure"), "unknown host defaults to Secure");

    const inTemp = createWebSession("hank", 1, "localhost:3000");
    assert.ok(!inTemp.cookieAttrs.includes("Secure"), "loopback host keeps cookie non-Secure");

    assert.ok(existsSync(store.file), "store created at the env-overridden path");
    assert.equal(Object.keys(readStore(store.file).sessions).length, 2);
  } finally {
    restoreStore(store.dir);
  }
});

// Regression test for #23: two gateway processes (`omp-web.service` and
// `omp-web-dev.service`) share one sessions file. Every mutator used to be a
// lockless read-modify-write, so a writer whose read→write gap overlapped
// another process's write would clobber it with a stale snapshot on its own
// write. The real-world window is a few ms (the issue's own evidence found
// zero collisions across 1999 back-to-back writes), so this test widens one
// writer's gap artificially to make the race deterministic instead of a
// once-in-a-blue-moon flake.
test("cross-process race: a writer with a widened read/write gap must not lose a concurrent writer's session (#23)", async () => {
  const store = freshStore();
  const lockFile = `${store.file}.lock`;
  const libDir = fileURLToPath(new URL(".", import.meta.url));
  const modulePath = join(libDir, "web-sessions.ts");
  try {
    // "process B": a real, unmodified child process performing a normal
    // createWebSession call through the actual module — nothing about it is
    // special-cased for the test.
    const childScript = [
      `import { createWebSession } from ${JSON.stringify(modulePath)};`,
      `const session = createWebSession("bob");`,
      `process.stdout.write(JSON.stringify({ raw: session.raw }));`,
    ].join("\n");
    const childScriptPath = join(store.dir, "child.mjs");
    writeFileSync(childScriptPath, childScript);

    // "process A" (this test): reproduces the exact createWebSession
    // pattern — read, then (widened) gap, then mutate and write — going
    // through the same `<store>.lock` convention the fix uses, so a fixed
    // module correctly blocks it out. Pre-fix, nothing ever looks at this
    // lockfile, so it has no effect and the race proceeds unimpeded.
    let lockFd;
    try {
      lockFd = openSync(lockFile, "wx", 0o600);
    } catch {
      lockFd = null;
    }
    if (lockFd !== null) {
      writeSync(lockFd, String(process.pid));
      closeSync(lockFd);
    }
    const before = existsSync(store.file) ? JSON.parse(readFileSync(store.file, "utf8")) : { sessions: {} };

    const child = spawn(process.execPath, [childScriptPath], {
      env: { ...process.env, OMP_WEB_SESSIONS_FILE: store.file },
      cwd: libDir,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let childOut = "";
    child.stdout.on("data", (chunk) => { childOut += chunk.toString(); });

    // Widen the gap: process A has read but not yet written. Calibrated
    // against a measured ~600ms bun cold-start for the child's full
    // read-modify-write, with ample margin.
    const WIDEN_MS = 2500;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WIDEN_MS);

    const aliceRaw = "alice-widened-window-session";
    const aliceKey = createHash("sha256").update(aliceRaw, "utf8").digest("hex");
    const now = Date.now();
    before.sessions[aliceKey] = { username: "alice", created: now, expires: now + 3_600_000, lastUsed: now };
    writeFileSync(store.file, JSON.stringify(before, null, 2));
    try {
      unlinkSync(lockFile);
    } catch {
      // already gone (e.g. the fix reclaimed and released it) — fine.
    }

    const [code] = await once(child, "exit");
    assert.equal(code, 0, `child process failed: ${childOut}`);
    const { raw: bobRaw } = JSON.parse(childOut);

    globalThis.__ompWebSessions = undefined;
    const { lookupWebSession } = await loadSubject();
    assert.deepEqual(lookupWebSession(aliceRaw), { username: "alice" }, "process A's own session must survive");
    assert.deepEqual(lookupWebSession(bobRaw), { username: "bob" }, "process B's session must not be lost to the race");
  } finally {
    restoreStore(store.dir);
  }
});
