import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  accessVariant,
  aggregatePublicHref,
  aggregateStaticMappings,
  formatDate,
  isStaticMapping,
  publicPath,
  request,
  validatedStaticMappings,
  validatedStaticResponseMappings,
} = await jiti.import("./static-content-helpers.ts");
const { apiPath, getCurrentMachineId, setCurrentMachineId } = await jiti.import("../lib/api-path.ts");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const { translateMessage } = await jiti.import("../lib/i18n/format.ts");

function mapping(id, createdAt, overrides = {}) {
  return {
    id,
    label: `Label ${id}`,
    lifecycle: "persistent",
    persistent: true,
    state: "active",
    entryFile: "index.html",
    createdAt,
    updatedAt: createdAt,
    contentRetained: true,
    writeDir: `/tmp/${id}`,
    publicPath: `static/m1/${id}/index.html`,
    ...overrides,
  };
}

function result(machineId, mappings, failure = null) {
  return { machineId, machineName: machineId, mappings, failure };
}

test("aggregate orders mappings by createdAt newest first across machines", () => {
  const entries = aggregateStaticMappings([
    result("m1", [mapping("a", "2026-11-01T00:00:00.000Z"), mapping("c", "2026-11-20T00:00:00.000Z")]),
    result("m2", [mapping("b", "2026-11-10T00:00:00.000Z")]),
  ]);
  assert.deepEqual(entries.map((entry) => entry.mapping.id), ["c", "b", "a"]);
  assert.deepEqual(entries.map((entry) => entry.machineId), ["m1", "m2", "m1"]);
});

test("aggregate never includes rows from failed machines", () => {
  const entries = aggregateStaticMappings([
    result("offline", [mapping("leak", "2026-11-25T00:00:00.000Z")], { status: 503, message: "offline" }),
    result("denied", [mapping("secret", "2026-11-24T00:00:00.000Z")], { status: 403, message: "denied" }),
    result("ok", [mapping("visible", "2026-11-01T00:00:00.000Z")]),
  ]);
  assert.deepEqual(entries.map((entry) => entry.mapping.id), ["visible"]);
});

test("aggregate breaks createdAt ties deterministically and tolerates bad dates", () => {
  const same = "2026-11-01T00:00:00.000Z";
  const entries = aggregateStaticMappings([
    result("m2", [mapping("z", same), mapping("a", same)]),
    result("m1", [mapping("b", same)]),
    result("m3", [mapping("bad", "not-a-date")]),
  ]);
  assert.deepEqual(entries.map((entry) => `${entry.machineId}:${entry.mapping.id}`), ["m1:b", "m2:a", "m2:z", "m3:bad"]);
  assert.deepEqual(aggregateStaticMappings([]), []);
});

test("aggregate tiebreak still applies when every createdAt is unparseable", () => {
  const entries = aggregateStaticMappings([
    result("m2", [mapping("z", "not-a-date"), mapping("a", "also-bad")]),
    result("m1", [mapping("b", "")]),
  ]);
  assert.deepEqual(entries.map((entry) => `${entry.machineId}:${entry.mapping.id}`), ["m1:b", "m2:a", "m2:z"]);
});

test("aggregate hrefs trust local publicPath but rebuild remote rows from the registry machine id", () => {
  // Remote hosts may report a host-local identity ("local" or an unknown
  // name) in publicPath; the gateway resolves the first segment by registry
  // id, so remote links must not echo it.
  const remote = mapping("r1", "2026-11-01T00:00:00.000Z", {
    publicPath: "static/local/r1/index.html",
    entryFile: "reports/index.html",
  });
  assert.equal(
    aggregatePublicHref({ machineId: "gpu-1", mapping: remote }),
    "/static/gpu-1/r1/reports/index.html",
  );
  assert.equal(
    aggregatePublicHref({ machineId: "remote #1", mapping: remote }),
    "/static/remote%20%231/r1/reports/index.html",
  );
  const local = mapping("l1", "2026-11-01T00:00:00.000Z", {
    publicPath: "static/gateway-host/l1/index.html",
  });
  assert.equal(aggregatePublicHref({ machineId: "local", mapping: local }), "/static/gateway-host/l1/index.html");
});

test("publicPath stays origin-relative and formatDate degrades gracefully", () => {
  assert.equal(publicPath("static/m1/a/index.html"), "/static/m1/a/index.html");
  assert.equal(publicPath("///static/m1/a/index.html"), "/static/m1/a/index.html");
  assert.equal(formatDate(undefined), "—");
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.notEqual(formatDate("2026-11-01T00:00:00.000Z"), "—");
});

test("accessVariant maps machine failure statuses to notice variants", () => {
  assert.equal(accessVariant(403), "no-permission");
  assert.equal(accessVariant(404), "not-found");
  assert.equal(accessVariant(502), "offline");
  assert.equal(accessVariant(503), "offline");
  assert.equal(accessVariant(504), "offline");
  assert.equal(accessVariant(500), null);
  assert.equal(accessVariant(undefined), null);
});

test("request surfaces HTTP errors with status for per-machine notices", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Machine unreachable" }), { status: 503 });
    await assert.rejects(
      () => request("/api/static-mappings"),
      (error) => error.status === 503 && error.message === "Machine unreachable",
    );
    globalThis.fetch = async () => new Response(JSON.stringify({ machineId: "local", mappings: [] }), { status: 200 });
    assert.deepEqual(await request("/api/static-mappings"), { machineId: "local", mappings: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apiPath routes the static-mappings aggregate through the machine proxy seam", () => {
  const previousMachineId = getCurrentMachineId();
  try {
    setCurrentMachineId("remote #1");
    assert.equal(apiPath("/api/static-mappings", "remote #1"), "/api/machines/remote%20%231/api/static-mappings");
    assert.equal(apiPath("/api/static-mappings", "local"), "/api/static-mappings");
  } finally {
    setCurrentMachineId(previousMachineId);
  }
});

test("new aggregate translation keys exist in every locale", () => {
  const keys = [
    "staticContent.machine",
    "staticContent.project",
    "staticContent.noProject",
    "staticContent.backHome",
    "staticContent.aggregate.description",
    "staticContent.aggregate.empty",
    "staticContent.aggregate.machineOffline",
    "staticContent.aggregate.machineNoPermission",
    "staticContent.aggregate.machineNotFound",
    "staticContent.aggregate.machineError",
    "home.contentTab",
    "home.tabConversations",
    "home.tabStatic",
  ];
  const locales = { en: enLocale.messages, "zh-CN": zhCNLocale.messages };
  for (const key of keys) {
    for (const [id, messages] of Object.entries(locales)) {
      assert.equal(typeof messages[key], "string", `${id} missing ${key}`);
      assert.ok(messages[key].length > 0, `${id} empty ${key}`);
    }
  }
  const messages = Object.fromEntries(Object.entries(locales));
  assert.match(translateMessage("en", "staticContent.aggregate.machineError", messages, { reason: "HTTP 500" }), /HTTP 500/);
});

test("isStaticMapping accepts a valid legacy row without projectRoot", () => {
  const legacy = mapping("legacy", "2026-11-01T00:00:00.000Z");
  assert.equal("projectRoot" in legacy, false);
  assert.equal(isStaticMapping(legacy), true);
  assert.deepEqual(validatedStaticMappings([legacy]), [legacy]);
  // projectRoot is server-filtered/admin-only; its presence must not matter.
  assert.equal(isStaticMapping(mapping("rooted", "2026-11-01T00:00:00.000Z", { projectRoot: "/srv/project" })), true);
  const entries = aggregateStaticMappings([result("m1", [legacy])]);
  assert.deepEqual(entries.map((entry) => `${entry.machineId}:${entry.mapping.id}`), ["m1:legacy"]);
});

test("malformed rows are rejected and never enter aggregate output", () => {
  const at = "2026-11-01T00:00:00.000Z";
  const malformed = [
    null,
    "index.html",
    42,
    [],
    {},
    mapping("bad-entryFile", at, { entryFile: 42 }),
    mapping("bad-writeDir", at, { writeDir: undefined }),
    mapping("bad-publicPath", at, { publicPath: null }),
    mapping("bad-id", at, { id: undefined }),
    mapping("bad-label", at, { label: {} }),
    mapping("bad-createdAt", at, { createdAt: 1700000000 }),
    mapping("bad-updatedAt", at, { updatedAt: [] }),
    mapping("bad-persistent", at, { persistent: "yes" }),
    mapping("bad-contentRetained", at, { contentRetained: 1 }),
    mapping("bad-lifecycle", at, { lifecycle: "forever" }),
    mapping("bad-state", at, { state: "paused" }),
  ];
  for (const row of malformed) {
    assert.equal(isStaticMapping(row), false, `expected rejection: ${JSON.stringify(row)}`);
  }
  // A machine payload is all-or-nothing: one bad row invalidates the response.
  assert.equal(validatedStaticMappings(malformed), null);
  assert.equal(validatedStaticMappings({ mappings: [] }), null);
  assert.equal(validatedStaticMappings("nope"), null);
  assert.deepEqual(validatedStaticMappings([]), []);

  // A malformed machine contributes no rows while healthy machines stay visible.
  const entries = aggregateStaticMappings([
    result("broken", [mapping("good-looking", at), mapping("bad-entryFile", at, { entryFile: 42 })]),
    result("ok", [mapping("visible", "2026-11-02T00:00:00.000Z")]),
  ]);
  assert.deepEqual(entries.map((entry) => `${entry.machineId}:${entry.mapping.id}`), ["ok:visible"]);

  // Defense in depth: a malformed row handed straight to the aggregator
  // invalidates its machine before any link is built (a non-string entryFile
  // would otherwise throw in split()).
  const filtered = aggregateStaticMappings([
    result("m1", [mapping("ok", at), mapping("bad", at, { entryFile: 7 })]),
  ]);
  assert.deepEqual(filtered, []);
});

test("malformed response envelopes fail before mappings are read", () => {
  for (const body of [null, "index.html", 42, true, [], { mappings: null }, { mappings: "nope" }, {}]) {
    assert.equal(validatedStaticResponseMappings(body), null, `expected rejection: ${JSON.stringify(body)}`);
  }
  const legacy = mapping("legacy", "2026-11-01T00:00:00.000Z");
  assert.deepEqual(validatedStaticResponseMappings({ mappings: [legacy] }), [legacy]);
  assert.deepEqual(validatedStaticResponseMappings({ mappings: [] }), []);
});