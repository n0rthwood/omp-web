import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["OMP_WEB_PASSWORD", "OMP_WEB_USERS_FILE", "OMP_WEB_SESSIONS_FILE"];

const tempDir = mkdtempSync(join(tmpdir(), "omp-web-login-"));
const usersFile = join(tempDir, "omp-web-users.yml");
const sessionsFile = join(tempDir, "omp-web-sessions.json");

/**
 * Run `fn` with specific OMP_WEB_* values (missing keys are cleared so no
 * developer-shell state leaks in), restoring the originals after.
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
async function withStore(extraEnv, fn) {
  if (typeof fn !== "function") {
    fn = extraEnv;
    extraEnv = {};
  }
  await withEnv(
    { OMP_WEB_USERS_FILE: usersFile, OMP_WEB_SESSIONS_FILE: sessionsFile, ...extraEnv },
    async () => {
      globalThis.__ompWebUsersCache = undefined;
      globalThis.__ompWebSessions = undefined;
      globalThis.__ompWebLoginRateLimit = undefined;
      await fn();
    },
  );
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

/** Trusted NextRequest for the given path (loopback host unless overridden). */
async function makeRequest(pathname, init = {}, host = "localhost:3000") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(`http://${host}${pathname}`, {
    ...init,
    headers: { host, ...(init.headers ?? {}) },
  });
}

const loadLogin = () => import("../app/api/auth/web-login/route.ts");
const loadMe = () => import("../app/api/auth/web-me/route.ts");
const loadLogout = () => import("../app/api/auth/web-logout/route.ts");

function loginPost(body, headers = {}) {
  return makeRequest("/api/auth/web-login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function extractSessionRaw(setCookie) {
  assert.ok(setCookie, "expected a Set-Cookie header");
  return setCookie.split(";")[0].slice("omp-web-session=".length);
}

test("login sets a session cookie and returns the safe user", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "user", password: "hunter2", projects: ["/srv/proj"] }]);
    const { POST } = await loadLogin();

    const res = await POST(await loginPost({ username: "alice", password: "hunter2" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const body = await res.json();
    assert.deepEqual(body, {
      user: { username: "alice", role: "user", visibleProjects: ["/srv/proj"] },
    });

    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /^omp-web-session=[^;]+;/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/); // 30d ttl from the config

    // The cookie value must be a live session for the user.
    const { lookupWebSession } = await import("./web-sessions.ts");
    const session = lookupWebSession(extractSessionRaw(setCookie));
    assert.equal(session?.username, "alice");
  });
});

test("login on a public host adds the Secure cookie attribute", async () => {
  await withStore({ OMP_WEB_ALLOWED_HOSTS: "omp.joyai.dev" }, async () => {
    await seedUsers([{ username: "alice", role: "admin", password: "hunter2" }]);
    const { POST } = await loadLogin();

    const res = await POST(
      await makeRequest(
        "/api/auth/web-login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "hunter2" }),
        },
        "omp.joyai.dev",
      ),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie"), /; Secure$/);
  });
});

test("the login page sanitizes the next redirect target", async () => {
  const { sanitizeNextPath } = await import("./login-next-path.ts");
  assert.equal(sanitizeNextPath("/chat"), "/chat");
  assert.equal(sanitizeNextPath("/?x=1"), "/?x=1");
  assert.equal(sanitizeNextPath(undefined), "/");
  assert.equal(sanitizeNextPath(""), "/");
  assert.equal(sanitizeNextPath(42), "/");
  assert.equal(sanitizeNextPath("https://evil.example"), "/");
  assert.equal(sanitizeNextPath("//evil.example"), "/");
  assert.equal(sanitizeNextPath("/\\evil.example"), "/");
  assert.equal(sanitizeNextPath("relative/path"), "/");
});

test("the login page renders the form with a sanitized next", async () => {
  const page = await import("../app/login/page.tsx");
  const { LoginForm } = await import("../app/login/LoginForm.tsx");

  const el = await page.default({ searchParams: Promise.resolve({ next: "//evil.example" }) });
  assert.equal(el.type, LoginForm);
  assert.equal(el.props.next, "/");

  const safe = await page.default({ searchParams: Promise.resolve({ next: "/?x=1" }) });
  assert.equal(safe.props.next, "/?x=1");
});

test("wrong password and unknown username both return a uniform 401", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "admin", password: "hunter2" }]);
    const { POST } = await loadLogin();

    for (const credentials of [
      { username: "alice", password: "wrong" },
      { username: "nobody", password: "hunter2" },
    ]) {
      const res = await POST(await loginPost(credentials));
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("set-cookie"), null);
      assert.deepEqual(await res.json(), { error: "Invalid credentials" });
    }
  });
});

test("five consecutive failures lock the username out; other users unaffected", async () => {
  await withStore(async () => {
    await seedUsers([
      { username: "alice", role: "admin", password: "hunter2" },
      { username: "bob", role: "user", password: "hunter2" },
    ]);
    const { POST } = await loadLogin();

    for (let i = 0; i < 5; i += 1) {
      const res = await POST(await loginPost({ username: "alice", password: "nope" }));
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Invalid credentials" });
    }

    // Even the CORRECT password is rejected while locked out.
    const locked = await POST(await loginPost({ username: "alice", password: "hunter2" }));
    assert.equal(locked.status, 401);
    assert.deepEqual(await locked.json(), { error: "Too many attempts, try again shortly" });

    // Lockout is per-username.
    const bob = await POST(await loginPost({ username: "bob", password: "hunter2" }));
    assert.equal(bob.status, 200);
  });
});

test("a successful login clears the failure counter", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "admin", password: "hunter2" }]);
    const { POST } = await loadLogin();

    for (let i = 0; i < 4; i += 1) {
      await POST(await loginPost({ username: "alice", password: "nope" }));
    }
    assert.equal((await POST(await loginPost({ username: "alice", password: "hunter2" }))).status, 200);
    // Counter restarted at zero: four more failures still do not lock out.
    for (let i = 0; i < 4; i += 1) {
      await POST(await loginPost({ username: "alice", password: "nope" }));
    }
    assert.equal((await POST(await loginPost({ username: "alice", password: "hunter2" }))).status, 200);
  });
});

test("web-me: null user when unauthenticated, real user with a session cookie, flag when disabled", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "user", password: "hunter2", projects: ["/srv/proj"] }]);
    const { POST: login } = await loadLogin();
    const { GET: me } = await loadMe();

    // Unauthenticated, auth enabled.
    const anon = await me(await makeRequest("/api/auth/web-me"));
    assert.equal(anon.status, 200);
    assert.equal(anon.headers.get("cache-control"), "no-store");
    assert.deepEqual(await anon.json(), { user: null, authRequired: true });

    // Valid session cookie.
    const loginRes = await login(await loginPost({ username: "alice", password: "hunter2" }));
    const raw = extractSessionRaw(loginRes.headers.get("set-cookie"));
    const authed = await me(
      await makeRequest("/api/auth/web-me", { headers: { cookie: `omp-web-session=${raw}` } }),
    );
    assert.equal(authed.status, 200);
    assert.deepEqual(await authed.json(), {
      user: { username: "alice", role: "user", visibleProjects: ["/srv/proj"] },
      authRequired: true,
    });

    // Garbage cookie does not authenticate.
    const garbage = await me(
      await makeRequest("/api/auth/web-me", { headers: { cookie: "omp-web-session=not-a-session" } }),
    );
    assert.deepEqual(await garbage.json(), { user: null, authRequired: true });
  });

  // Auth entirely disabled (no users, no env password): the synthetic
  // __anonymous admin is reported so clients keep the full (admin) UI.
  await withStore({ OMP_WEB_PASSWORD: undefined }, async () => {
    await seedUsers([]);
    const { GET: me } = await loadMe();
    const res = await me(await makeRequest("/api/auth/web-me"));
    assert.deepEqual(await res.json(), {
      user: { username: "__anonymous", role: "admin", visibleProjects: "*" },
      authRequired: false,
    });
  });
});

test("logout revokes the session and expires the cookie", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "admin", password: "hunter2" }]);
    const { POST: login } = await loadLogin();
    const { GET: me } = await loadMe();
    const { POST: logout } = await loadLogout();

    const loginRes = await login(await loginPost({ username: "alice", password: "hunter2" }));
    const raw = extractSessionRaw(loginRes.headers.get("set-cookie"));
    const cookieHeader = `omp-web-session=${raw}`;

    const res = await logout(
      await makeRequest("/api/auth/web-logout", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: "{}",
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { ok: true });

    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie.startsWith("omp-web-session=;"));
    assert.match(setCookie, /Max-Age=0/);
    assert.match(setCookie, /Path=\//);

    // The old cookie no longer resolves a user.
    const after = await me(await makeRequest("/api/auth/web-me", { headers: { cookie: cookieHeader } }));
    assert.deepEqual(await after.json(), { user: null, authRequired: true });

    const { lookupWebSession } = await import("./web-sessions.ts");
    assert.equal(lookupWebSession(raw), null);
  });
});

test("login and logout reject untrusted requests and non-JSON bodies", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "admin", password: "hunter2" }]);
    const { POST: login } = await loadLogin();
    const { POST: logout } = await loadLogout();

    // Cross-origin browser request → trust gate fires before anything else.
    const crossOrigin = await login(
      await loginPost({ username: "alice", password: "hunter2" }, { origin: "https://evil.example" }),
    );
    assert.equal(crossOrigin.status, 403);
    assert.deepEqual(await crossOrigin.json(), { error: "Untrusted API request" });

    // Missing JSON content type → 415 (repo idiom).
    const noJson = await login(await makeRequest("/api/auth/web-login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ username: "alice", password: "hunter2" }),
    }));
    assert.equal(noJson.status, 415);

    // Logout is state-changing → same guards.
    const crossOriginLogout = await logout(
      await makeRequest("/api/auth/web-logout", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: "{}",
      }),
    );
    assert.equal(crossOriginLogout.status, 403);
  });
});

test("login validates the request body", async () => {
  await withStore(async () => {
    await seedUsers([{ username: "alice", role: "admin", password: "hunter2" }]);
    const { POST } = await loadLogin();

    for (const body of [{}, { username: "alice" }, { password: "hunter2" }, { username: 1, password: "x" }]) {
      const res = await POST(await loginPost(body));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Username and password are required" });
    }
  });
});

test("env-backed migration admin logs in with OMP_WEB_PASSWORD", async () => {
  await withStore({ OMP_WEB_PASSWORD: "env-secret-pw" }, async () => {
    await seedUsers([]); // no file users → migration bridge active
    const { POST } = await loadLogin();

    const res = await POST(await loginPost({ username: "omp", password: "env-secret-pw" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      user: { username: "omp", role: "admin", visibleProjects: "*" },
    });

    const wrong = await POST(await loginPost({ username: "omp", password: "nope" }));
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "Invalid credentials" });
  });
});

test("cleanup: remove temp store files", () => {
  rmSync(tempDir, { recursive: true, force: true });
});
