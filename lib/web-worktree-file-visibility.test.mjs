import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];

const tempDir = mkdtempSync(join(tmpdir(), "omp-web-wtvis-"));
const usersFile = join(tempDir, "omp-web-users.yml");
const sessionsFile = join(tempDir, "omp-web-sessions.json");

// --- git fixtures: a visible project with one worktree parked outside it ------
const visRoot = mkdtempSync(join(tmpdir(), "omp-web-wtvis-vis-"));
const hidRoot = mkdtempSync(join(tmpdir(), "omp-web-wtvis-hid-"));
const projA = join(visRoot, "projA");
const hiddenWorktree = join(hidRoot, "wt-hidden");

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

mkdirSync(projA, { recursive: true });
git(projA, "init", "--initial-branch=main");
git(projA, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init");
git(projA, "worktree", "add", "-b", "hidden-branch", hiddenWorktree);
writeFileSync(join(hidRoot, "secret.txt"), "top secret\n");
writeFileSync(join(projA, "hello.txt"), "hello\n");

/**
 * Run `fn` with specific OMP_WEB_* values (missing keys are cleared so no
 * developer-shell state leaks in — OMP_WEB_PASSWORD IS set on this host),
 * restoring the originals after.
 */
async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Point both stores at the temp dir and drop every process-global cache. */
async function withStore(fn) {
  await withEnv({ OMP_WEB_USERS_FILE: usersFile, OMP_WEB_SESSIONS_FILE: sessionsFile }, async () => {
    globalThis.__ompWebUsersCache = undefined;
    globalThis.__ompWebSessions = undefined;
    await fn();
  });
}

async function seedUsers(users) {
  const { hashWebPassword, writeWebUsersConfig } = await import("./web-users.ts");
  writeWebUsersConfig({
    users: users.map(({ username, role, password, projects }) => ({
      username,
      role,
      passwordHash: hashWebPassword(password ?? "pw-123456"),
      projects: projects ?? "*",
      tokens: [],
    })),
    sessions: { secret: "", ttlDays: 30 },
  });
}

/** Trusted NextRequest for the given path (loopback host). */
async function makeRequest(pathname, init = {}, host = "localhost:3000") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://${host}${pathname}`, {
    ...init,
    headers: { host, ...(init.headers ?? {}) },
  });
}

/** Drop the process-global allowed-roots cache + in-memory extra roots. */
async function resetAllowedRoots() {
  globalThis.__ompAdditionalAllowedRoots = new Set();
  globalThis.__ompAllowedRootsCache = undefined;
  const { invalidateProjectCache } = await import("./worktree.ts");
  invalidateProjectCache();
}

async function sessionCookie(username) {
  const { createWebSession } = await import("./web-sessions.ts");
  const { raw } = createWebSession(username);
  return `omp-web-session=${raw}`;
}

const loadWorktrees = () => import("../app/api/worktrees/route.ts");
const loadFiles = () => import("../app/api/files/[...path]/route.ts");

function segmentsFor(absPath) {
  return absPath.replace(/^\/+/, "").split("/");
}

async function worktreesGet(cwd, cookie) {
  const { GET } = await loadWorktrees();
  return GET(await makeRequest(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`, {
    headers: { cookie },
  }));
}

async function worktreesPost(body, cookie) {
  const { POST } = await loadWorktrees();
  return POST(await makeRequest("/api/worktrees", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  }));
}

async function filesGet(absPath, { type = "read", cookie } = {}) {
  const { GET } = await loadFiles();
  const segments = segmentsFor(absPath);
  const url = `/api/files/${segments.map(encodeURIComponent).join("/")}?type=${type}`;
  return GET(await makeRequest(url, { headers: { cookie } }), {
    params: Promise.resolve({ path: segments }),
  });
}

async function filesUpload(absDir, cookie) {
  const { POST } = await loadFiles();
  const segments = segmentsFor(absDir);
  const url = `/api/files/${segments.map(encodeURIComponent).join("/")}?type=upload&conflict=error`;
  const form = new FormData();
  form.append("files", new File(["uploaded"], "u.txt", { type: "text/plain" }));
  return POST(await makeRequest(url, { method: "POST", headers: { cookie }, body: form }), {
    params: Promise.resolve({ path: segments }),
  });
}

async function filesUploadCheck(absDir, cookie) {
  const { POST } = await loadFiles();
  const segments = segmentsFor(absDir);
  const url = `/api/files/${segments.map(encodeURIComponent).join("/")}?type=upload-check`;
  return POST(await makeRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ fileNames: ["u.txt"] }),
  }), { params: Promise.resolve({ path: segments }) });
}

test("worktrees GET: hidden-but-globally-allowed cwd is 404 for a user role", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", projects: [visRoot] },
      { username: "boss", role: "admin" },
    ]);
    await resetAllowedRoots();
    const { allowFileRoot } = await import("./file-access.ts");
    allowFileRoot(hidRoot); // globally allowed, hidden for alice

    const res = await worktreesGet(hidRoot, await sessionCookie("alice"));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not visible for this user" });

    // Admin still sees the same cwd.
    const adminRes = await worktreesGet(hidRoot, await sessionCookie("boss"));
    assert.equal(adminRes.status, 200);
  });
});

test("worktrees GET: list omits hidden worktrees and never allowFileRoots them", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", projects: [visRoot] },
      { username: "boss", role: "admin" },
    ]);
    await resetAllowedRoots();
    const { allowFileRoot } = await import("./file-access.ts");
    allowFileRoot(projA);
    allowFileRoot(hidRoot); // where the hidden worktree lives
    const { getAdditionalAllowedRoots } = await import("./allowed-roots.ts");
    const before = new Set(getAdditionalAllowedRoots());

    const res = await worktreesGet(projA, await sessionCookie("alice"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.isGit, true);
    const paths = body.worktrees.map((w) => w.path);
    assert.ok(paths.includes(projA), "main checkout should be listed");
    assert.ok(!paths.includes(hiddenWorktree), "hidden worktree must be filtered out");

    // No hidden path may leak into the in-memory allowlist via allowFileRoot.
    const after = getAdditionalAllowedRoots();
    const added = [...after].filter((root) => !before.has(root));
    for (const root of added) {
      assert.ok(
        root === visRoot || root.startsWith(`${visRoot}/`),
        `unexpected allowFileRoot call for ${root}`,
      );
    }
    assert.ok(!after.has(hiddenWorktree));
  });
});

test("worktrees GET: admin sees every worktree and allowFileRoots them all", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "boss", role: "admin" }]);
    await resetAllowedRoots();
    const { allowFileRoot } = await import("./file-access.ts");
    allowFileRoot(projA);
    allowFileRoot(hidRoot);
    const { getAdditionalAllowedRoots } = await import("./allowed-roots.ts");

    const res = await worktreesGet(projA, await sessionCookie("boss"));
    assert.equal(res.status, 200);
    const paths = (await res.json()).worktrees.map((w) => w.path);
    assert.ok(paths.includes(hiddenWorktree), "admin list is unfiltered");
    assert.ok(getAdditionalAllowedRoots().has(hiddenWorktree), "admin path gets allowFileRooted");
  });
});

test("worktrees POST: succeeds inside a visible project, 404 from a hidden cwd", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "user", projects: [visRoot] }]);
    await resetAllowedRoots();
    const { allowFileRoot } = await import("./file-access.ts");
    allowFileRoot(projA);
    allowFileRoot(hidRoot);

    // Worktree management is allowed inside visible projects (user decision).
    const res = await worktreesPost(
      { cwd: projA, branch: "feature-x" },
      await sessionCookie("alice"),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.branch, "feature-x");
    assert.ok(existsSync(body.path), "worktree directory should exist");
    assert.ok(body.path.startsWith(`${visRoot}/`), "worktree lands under the visible root");

    // From a hidden cwd the request is rejected before any git mutation.
    const hiddenRes = await worktreesPost(
      { cwd: hiddenWorktree, branch: "feature-y" },
      await sessionCookie("alice"),
    );
    assert.equal(hiddenRes.status, 404);
    assert.deepEqual(await hiddenRes.json(), { error: "Not visible for this user" });
  });
});

test("files GET: hidden-but-globally-allowed root → 403 for user, 200 for admin", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", projects: [visRoot] },
      { username: "boss", role: "admin" },
    ]);
    await resetAllowedRoots();
    const { allowFileRoot } = await import("./file-access.ts");
    allowFileRoot(visRoot);
    allowFileRoot(hidRoot);

    const aliceCookie = await sessionCookie("alice");
    const bossCookie = await sessionCookie("boss");

    const secretPath = join(hidRoot, "secret.txt");
    const userRes = await filesGet(secretPath, { cookie: aliceCookie });
    assert.equal(userRes.status, 403);

    const adminRes = await filesGet(secretPath, { cookie: bossCookie });
    assert.equal(adminRes.status, 200);
    assert.equal((await adminRes.json()).content, "top secret\n");

    // The user can still read inside their visible root.
    const visibleRes = await filesGet(join(projA, "hello.txt"), { cookie: aliceCookie });
    assert.equal(visibleRes.status, 200);
    assert.equal((await visibleRes.json()).content, "hello\n");
  });
});

test("files POST: upload gate — 403 into hidden dir for user, 200 into visible dir", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "user", projects: [visRoot] },
      { username: "boss", role: "admin" },
    ]);
    await resetAllowedRoots();
    const { allowFileRoot } = await import("./file-access.ts");
    allowFileRoot(visRoot);
    allowFileRoot(hidRoot);

    const aliceCookie = await sessionCookie("alice");

    const deniedCheck = await filesUploadCheck(hidRoot, aliceCookie);
    assert.equal(deniedCheck.status, 403);

    const deniedUpload = await filesUpload(hidRoot, aliceCookie);
    assert.equal(deniedUpload.status, 403);

    const okUpload = await filesUpload(projA, aliceCookie);
    assert.equal(okUpload.status, 200);
    assert.deepEqual((await okUpload.json()).uploaded, ["u.txt"]);

    const adminUpload = await filesUpload(hidRoot, await sessionCookie("boss"));
    assert.equal(adminUpload.status, 200);
  });
});

test("cleanup: remove temp fixtures", () => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(visRoot, { recursive: true, force: true });
  rmSync(hidRoot, { recursive: true, force: true });
});
