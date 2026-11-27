import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const ENV_KEYS = [
  "OMP_WEB_PASSWORD",
  "OMP_WEB_USERS_FILE",
  "OMP_WEB_SESSIONS_FILE",
  "OMP_WEB_MACHINES_FILE",
  "OMP_WEB_STATIC_MAPPINGS_FILE",
  "OMP_WEB_STATIC_ROOT",
  "OMP_WEB_MACHINE_ID",
];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
  globalThis.__ompStaticMappingsCache = undefined;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omp-static-route-"));
  process.env.OMP_WEB_USERS_FILE = join(dir, "users.yml");
  process.env.OMP_WEB_SESSIONS_FILE = join(dir, "sessions.json");
  process.env.OMP_WEB_MACHINES_FILE = join(dir, "machines.json");
  process.env.OMP_WEB_STATIC_MAPPINGS_FILE = join(dir, "mappings.json");
  process.env.OMP_WEB_STATIC_ROOT = join(dir, "static");
  process.env.OMP_WEB_MACHINE_ID = "joysort187";
  delete process.env.OMP_WEB_PASSWORD;
  globalThis.__ompWebUsersCache = undefined;
  globalThis.__ompWebSessions = undefined;
  globalThis.__ompWebMachinesCache = undefined;
  globalThis.__ompStaticMappingsCache = undefined;
  return dir;
}

async function loadLibs() {
  const users = await jiti.import("../../../../../lib/web-users.ts");
  const sessions = await jiti.import("../../../../../lib/web-sessions.ts");
  const machineStore = await jiti.import("../../../../../lib/machines/machine-store.ts");
  const mappings = await jiti.import("../../../../../lib/static-mapping-store.ts");
  return { users, sessions, machineStore, mappings };
}

async function seed() {
  const { users, machineStore } = await loadLibs();
  users.writeWebUsersConfig({
    users: [
      {
        username: "granted",
        role: "user",
        passwordHash: users.hashWebPassword("granted-pass-1"),
        projects: [],
        machines: ["gpu-1"],
        tokens: [],
      },
      {
        username: "outsider",
        role: "user",
        passwordHash: users.hashWebPassword("outsider-pass-1"),
        projects: [],
        machines: [],
        tokens: [],
      },
    ],
    sessions: { secret: "", ttlDays: 30 },
  });
  machineStore.createMachine({
    id: "gpu-1",
    name: "GPU 1",
    baseUrl: "http://gpu-1.local",
    authMode: "none",
  });
}

async function loginAs(username) {
  const { sessions } = await loadLibs();
  const { raw } = sessions.createWebSession(username);
  return `${sessions.WEB_SESSION_COOKIE}=${raw}`;
}

function request(path, cookie) {
  return new Request(`http://localhost${path}`, {
    headers: {
      host: "localhost",
      cookie,
      authorization: "Bearer browser-token-must-not-forward",
    },
  });
}

function params(value) {
  return { params: Promise.resolve(value) };
}

test("a granted user can read local static content without a project grant", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  // Registered under a project the caller has NO grant for: direct serving
  // is deliberately auth + machine-only (issue #136).
  const mapping = mappings.createStaticMapping({ id: "local-report", lifecycle: "persistent", projectRoot: "/opt/elsewhere" });
  writeFileSync(join(mappings.getStaticMappingRoot(mapping.id), "index.html"), "<h1>local</h1>");
  const cookie = await loginAs("granted");
  const route = await jiti.import("./route.ts");

  const response = await route.GET(
    request("/static/joysort187/local-report/index.html", cookie),
    params({ machineId: "joysort187", mappingId: "local-report", path: ["index.html"] }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);

  // The same row is NOT discoverable through the project-filtered management
  // list — discovery and direct serving are different boundaries.
  const management = await jiti.import("../../../../../app/api/static-mappings/route.ts");
  const list = await management.GET(new Request("http://localhost/api/static-mappings", {
    headers: { host: "localhost", cookie },
  }));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).mappings, []);
});

test("a machine-granted user streams remote static bytes without forwarding browser credentials", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const route = await jiti.import("./route.ts");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("<h1>remote</h1>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, max-age=60" },
    });
  };
  try {
    const response = await route.GET(
      request("/static/gpu-1/remote-report/index.html", cookie),
      params({ machineId: "gpu-1", mappingId: "remote-report", path: ["index.html"] }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://gpu-1.local/api/static/remote-report/index.html");
    const outbound = new Headers(calls[0].init.headers);
    assert.equal(outbound.get("authorization"), null);
    assert.equal(outbound.get("cookie"), null);
    const outsider = await loginAs("outsider");
    const denied = await route.GET(
      request("/static/gpu-1/remote-report/index.html", outsider),
      params({ machineId: "gpu-1", mappingId: "remote-report", path: ["index.html"] }),
    );
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 1, "an ungranted user must not reach the remote");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a bare mapping URL serves index.html first and never lists the directory", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  const mapping = mappings.createStaticMapping({ id: "bare-html", lifecycle: "persistent", projectRoot: "/opt/projects/main" });
  const root = mappings.getStaticMappingRoot(mapping.id);
  writeFileSync(join(root, "index.html"), "<h1>html wins</h1>");
  writeFileSync(join(root, "index.htm"), "<h1>htm fallback</h1>");
  writeFileSync(join(root, "notes.txt"), "not an index");
  const cookie = await loginAs("granted");
  const route = await jiti.import("./route.ts");

  const response = await route.GET(
    request("/static/joysort187/bare-html", cookie),
    params({ machineId: "joysort187", mappingId: "bare-html", path: undefined }),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<h1>html wins</h1>");
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);

  // Explicit asset paths keep their exact behavior.
  const explicit = await route.GET(
    request("/static/joysort187/bare-html/index.htm", cookie),
    params({ machineId: "joysort187", mappingId: "bare-html", path: ["index.htm"] }),
  );
  assert.equal(explicit.status, 200);
  assert.equal(await explicit.text(), "<h1>htm fallback</h1>");
  const asset = await route.GET(
    request("/static/joysort187/bare-html/notes.txt", cookie),
    params({ machineId: "joysort187", mappingId: "bare-html", path: ["notes.txt"] }),
  );
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "not an index");
});

test("a bare mapping URL falls back to index.htm when index.html is absent", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  const mapping = mappings.createStaticMapping({ id: "bare-htm", lifecycle: "persistent", projectRoot: "/opt/projects/main" });
  writeFileSync(join(mappings.getStaticMappingRoot(mapping.id), "index.htm"), "<h1>htm only</h1>");
  const cookie = await loginAs("granted");
  const route = await jiti.import("./route.ts");

  const response = await route.GET(
    request("/static/joysort187/bare-htm", cookie),
    params({ machineId: "joysort187", mappingId: "bare-htm", path: undefined }),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<h1>htm only</h1>");
  assert.match(response.headers.get("content-type"), /text\/html/);
});

test("a bare mapping URL with neither index file is 404 without a directory listing", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  const mapping = mappings.createStaticMapping({ id: "bare-empty", lifecycle: "persistent", projectRoot: "/opt/projects/main" });
  writeFileSync(join(mappings.getStaticMappingRoot(mapping.id), "notes.txt"), "not an index");
  const cookie = await loginAs("granted");
  const route = await jiti.import("./route.ts");

  const response = await route.GET(
    request("/static/joysort187/bare-empty", cookie),
    params({ machineId: "joysort187", mappingId: "bare-empty", path: undefined }),
  );
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.equal(body, "Not found");
  assert.ok(!body.includes("notes.txt"), "no directory listing may be exposed");
});

test("a directory path serves its index file with document CSP", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const { mappings } = await loadLibs();
  const mapping = mappings.createStaticMapping({ id: "dir-html", lifecycle: "persistent", projectRoot: "/opt/projects/main" });
  const root = mappings.getStaticMappingRoot(mapping.id);
  mkdirSync(join(root, "en"), { recursive: true });
  writeFileSync(join(root, "en", "index.html"), "<h1>en page</h1><h2 id=\"customers\">customers</h2>");
  writeFileSync(join(root, "report.html"), "<h1>report</h1>");
  const cookie = await loginAs("granted");
  const route = await jiti.import("./route.ts");

  const directory = await route.GET(
    request("/static/joysort187/dir-html/en", cookie),
    params({ machineId: "joysort187", mappingId: "dir-html", path: ["en"] }),
  );
  assert.equal(directory.status, 200);
  assert.match(directory.headers.get("content-type"), /text\/html/);
  assert.match(directory.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await directory.text(), /id="customers"/);

  const extensionless = await route.GET(
    request("/static/joysort187/dir-html/report", cookie),
    params({ machineId: "joysort187", mappingId: "dir-html", path: ["report"] }),
  );
  assert.equal(extensionless.status, 200);
  assert.equal(await extensionless.text(), "<h1>report</h1>");

  const missing = await route.GET(
    request("/static/joysort187/dir-html/en/missing", cookie),
    params({ machineId: "joysort187", mappingId: "dir-html", path: ["en", "missing"] }),
  );
  assert.equal(missing.status, 404);
});

test("a bare remote mapping URL forwards the bare internal path and passes a remote 404 through", async (t) => {
  t.after(restoreEnv);
  const dir = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await seed();
  const cookie = await loginAs("granted");
  const route = await jiti.import("./route.ts");
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("<h1>remote index</h1>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  try {
    const response = await route.GET(
      request("/static/gpu-1/remote-bare", cookie),
      params({ machineId: "gpu-1", mappingId: "remote-bare", path: undefined }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<h1>remote index</h1>");
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://gpu-1.local/api/static/remote-bare");
    const outbound = new Headers(calls[0].init.headers);
    assert.equal(outbound.get("authorization"), null);
    assert.equal(outbound.get("cookie"), null);

    // A remote missing both index files answers 404; the Gateway passes it through.
    globalThis.fetch = async () => new Response("Not found", { status: 404 });
    const missing = await route.GET(
      request("/static/gpu-1/remote-bare", cookie),
      params({ machineId: "gpu-1", mappingId: "remote-bare", path: undefined }),
    );
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
