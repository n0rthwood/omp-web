import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

async function loadSubject() {
  return import("./web-users.ts");
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
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

function tempUsersFile() {
  const dir = mkdtempSync(join(tmpdir(), "web-users-"));
  return { dir, file: join(dir, "omp-web-users.yml") };
}

test("hashes passwords with the scrypt format and verifies them", async () => {
  const { hashWebPassword, verifyWebPassword } = await loadSubject();

  const hash = hashWebPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(verifyWebPassword("correct horse battery staple", hash), true);
  assert.equal(verifyWebPassword("wrong password", hash), false);
  assert.equal(verifyWebPassword("", hash), false);

  // Fresh salt per hash.
  assert.notEqual(hashWebPassword("same"), hashWebPassword("same"));

  // Malformed stored hashes never verify.
  assert.equal(verifyWebPassword("correct horse battery staple", "scrypt$1$2$3$4$5"), false);
  assert.equal(verifyWebPassword("correct horse battery staple", "plaintext"), false);
});

test("writes and re-reads the yaml users file via OMP_WEB_USERS_FILE", async () => {
  const { dir, file } = tempUsersFile();
  try {
    await withEnv({ OMP_WEB_USERS_FILE: file, OMP_WEB_PASSWORD: undefined }, async () => {
      const subject = await loadSubject();
      const passwordHash = subject.hashWebPassword("hunter2");
      const config = {
        users: [
          {
            username: "alice",
            role: "admin",
            passwordHash,
            projects: "*",
            tokens: [],
          },
          {
            username: "bob",
            role: "user",
            passwordHash,
            projects: ["/home/joysort/omp/ompweb", "/srv/data"],
            tokens: [],
          },
        ],
        sessions: { secret: "", ttlDays: 30 },
      };
      subject.writeWebUsersConfig(config);

      assert.equal(existsSync(file), true);
      // Atomic private write: 0600.
      assert.equal(statSync(file).mode & 0o777, 0o600);

      const reread = subject.readWebUsersConfig();
      assert.equal(reread.users.length, 2);
      assert.deepEqual(reread.users[0], config.users[0]);
      assert.deepEqual(reread.users[1], config.users[1]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-reads the file when its mtime changes", async () => {
  const { dir, file } = tempUsersFile();
  try {
    await withEnv({ OMP_WEB_USERS_FILE: file, OMP_WEB_PASSWORD: undefined }, async () => {
      const subject = await loadSubject();
      subject.writeWebUsersConfig({
        users: [{ username: "alice", role: "admin", passwordHash: subject.hashWebPassword("p"), projects: "*", tokens: [] }],
        sessions: { secret: "", ttlDays: 30 },
      });
      assert.equal(subject.readWebUsersConfig().users[0].username, "alice");

      // External edit (hand-edited yaml): cache must invalidate on mtime change.
      writeFileSync(file, "users: []\nsessions:\n  secret: abc\n  ttlDays: 7\n", "utf8");
      const reread = subject.readWebUsersConfig();
      assert.equal(reread.users.length, 0);
      assert.equal(reread.sessions.ttlDays, 7);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env-backed migration admin appears only when env password set and file has no users", async () => {
  const { dir, file } = tempUsersFile();
  try {
    const subject = await loadSubject();
    await withEnv({ OMP_WEB_USERS_FILE: file, OMP_WEB_PASSWORD: undefined }, async () => {
      // No users, no env password: nothing effective, auth disabled.
      assert.deepEqual(subject.getEffectiveWebUsers(), []);
      assert.equal(subject.authEnabled(), false);
    });

    await withEnv({ OMP_WEB_USERS_FILE: file, OMP_WEB_PASSWORD: "env-secret" }, async () => {
      const effective = subject.getEffectiveWebUsers();
      assert.equal(effective.length, 1);
      const omp = effective[0];
      assert.equal(omp.username, "omp");
      assert.equal(omp.role, "admin");
      assert.equal(omp.passwordHash, null);
      assert.deepEqual(omp.projects, "*");
      assert.equal(omp.envBacked, true);

      // Env-backed user verifies against the env password, timing-safely.
      assert.equal(subject.verifyWebPassword("env-secret", null), true);
      assert.equal(subject.verifyWebPassword("nope", null), false);

      // Never persisted.
      assert.equal(subject.readWebUsersConfig().users.length, 0);
      assert.equal(existsSync(file), false);

      // Once the file gains a real user, the synthetic admin disappears.
      subject.writeWebUsersConfig({
        users: [{ username: "alice", role: "admin", passwordHash: subject.hashWebPassword("p"), projects: "*", tokens: [] }],
        sessions: { secret: "", ttlDays: 30 },
      });
      const afterMigration = subject.getEffectiveWebUsers();
      assert.equal(afterMigration.length, 1);
      assert.equal(afterMigration[0].username, "alice");
      assert.equal(afterMigration[0].envBacked, false);
    });

    // Env removed, file still has users: auth stays enabled without the bridge.
    await withEnv({ OMP_WEB_USERS_FILE: file, OMP_WEB_PASSWORD: undefined }, async () => {
      assert.equal(subject.authEnabled(), true);
      assert.equal(subject.verifyWebPassword("env-secret", null), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token lifecycle: raw web_ token returned once, sha256 stored, bearer lookup works", async () => {
  const { dir, file } = tempUsersFile();
  try {
    await withEnv({ OMP_WEB_USERS_FILE: file, OMP_WEB_PASSWORD: undefined }, async () => {
      const subject = await loadSubject();
      subject.writeWebUsersConfig({
        users: [{ username: "alice", role: "user", passwordHash: subject.hashWebPassword("p"), projects: ["/srv"], tokens: [] }],
        sessions: { secret: "", ttlDays: 30 },
      });

      const created = subject.createWebUserToken("alice", "laptop");
      assert.ok(created);
      assert.match(created.raw, /^web_[A-Za-z0-9_-]{43}$/);

      // Only the sha256 hex of the raw token is stored.
      const stored = subject.readWebUsersConfig().users[0].tokens;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].name, "laptop");
      assert.equal(stored[0].tokenHash, createHash("sha256").update(created.raw, "utf8").digest("hex"));
      assert.match(stored[0].created, /^\d{4}-\d{2}-\d{2}T/);

      // Bearer lookup resolves the owning user.
      const resolved = subject.verifyWebBearerToken(created.raw);
      assert.equal(resolved.username, "alice");
      assert.equal(resolved.role, "user");
      assert.deepEqual(resolved.projects, ["/srv"]);

      // Unknown / malformed tokens resolve nothing.
      assert.equal(subject.verifyWebBearerToken("web_" + "A".repeat(43)), null);
      assert.equal(subject.verifyWebBearerToken(""), null);
      assert.equal(subject.verifyWebBearerToken("garbage"), null);

      // Tokens for unknown users are rejected.
      assert.equal(subject.createWebUserToken("ghost", "x"), null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validates usernames against [a-z0-9_-]{1,32}", async () => {
  const { isValidWebUsername } = await loadSubject();
  assert.equal(isValidWebUsername("omp"), true);
  assert.equal(isValidWebUsername("a-b_c9"), true);
  assert.equal(isValidWebUsername("x".repeat(32)), true);
  assert.equal(isValidWebUsername(""), false);
  assert.equal(isValidWebUsername("x".repeat(33)), false);
  assert.equal(isValidWebUsername("Alice"), false);
  assert.equal(isValidWebUsername("has space"), false);
  assert.equal(isValidWebUsername("dot.name"), false);
});

test("auto-generates a 32-byte session secret with ttlDays default 30 on first write", async () => {
  const { dir, file } = tempUsersFile();
  try {
    await withEnv({ OMP_WEB_USERS_FILE: file, OMP_WEB_PASSWORD: undefined }, async () => {
      const subject = await loadSubject();
      subject.writeWebUsersConfig({ users: [], sessions: { secret: "", ttlDays: 30 } });

      const raw = parseYaml(readFileSync(file, "utf8"));
      assert.equal(typeof raw.sessions.secret, "string");
      assert.equal(Buffer.from(raw.sessions.secret, "base64").length, 32);
      assert.equal(raw.sessions.ttlDays, 30);

      // Stable across subsequent writes; ensureWebSessionSecret returns it.
      const first = subject.ensureWebSessionSecret();
      assert.equal(first, raw.sessions.secret);
      subject.writeWebUsersConfig({ users: [], sessions: { secret: first, ttlDays: 30 } });
      assert.equal(subject.ensureWebSessionSecret(), first);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safe projection strips password hashes and tokens", async () => {
  const { toSafeWebUser } = await loadSubject();
  const safe = toSafeWebUser({
    username: "alice",
    role: "admin",
    passwordHash: "scrypt$16384$8$1$AAAA$BBBB",
    projects: "*",
    tokens: [{ name: "laptop", tokenHash: "deadbeef", created: "2026-08-14T00:00:00.000Z" }],
    envBacked: false,
  });
  assert.deepEqual(safe, { username: "alice", role: "admin", visibleProjects: "*" });
  assert.equal("passwordHash" in safe, false);
  assert.equal("tokens" in safe, false);
});
