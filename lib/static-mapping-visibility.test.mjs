import assert from "node:assert/strict";
import test from "node:test";

const { canManageStaticMapping, filterVisibleStaticMappings } = await import("./static-mapping-visibility.ts");

const ADMIN = { username: "root", role: "admin", visibleProjects: "*", machines: "*" };
const STAR_USER = { username: "star", role: "user", visibleProjects: "*", machines: ["gpu-1"] };
const LIMITED = { username: "limited", role: "user", visibleProjects: ["/opt/granted/a", "/opt/granted/b"], machines: ["gpu-1"] };
const EMPTY = { username: "empty", role: "user", visibleProjects: [], machines: ["gpu-1"] };

const ROWS = [
  { id: "visible", projectRoot: "/opt/granted/a" },
  { id: "nested", projectRoot: "/opt/granted/b/deep" },
  { id: "sibling-prefix", projectRoot: "/opt/granted/ab" },
  { id: "other", projectRoot: "/opt/elsewhere" },
  { id: "legacy" },
  { id: "empty-root", projectRoot: "" },
];

test("canManageStaticMapping: admins pass every row including legacy", () => {
  for (const row of ROWS) assert.equal(canManageStaticMapping(ADMIN, row), true, row.id);
});

test("canManageStaticMapping: non-admin needs the registered root visible", () => {
  assert.equal(canManageStaticMapping(LIMITED, ROWS[0]), true);
  assert.equal(canManageStaticMapping(LIMITED, ROWS[1]), true);
  // Prefix semantics: /opt/granted/ab is NOT under /opt/granted/a.
  assert.equal(canManageStaticMapping(LIMITED, ROWS[2]), false);
  assert.equal(canManageStaticMapping(LIMITED, ROWS[3]), false);
});

test("canManageStaticMapping: legacy rows are admin-only even for '*' visibility", () => {
  assert.equal(canManageStaticMapping(LIMITED, ROWS[4]), false);
  assert.equal(canManageStaticMapping(LIMITED, ROWS[5]), false);
  assert.equal(canManageStaticMapping(STAR_USER, ROWS[4]), false);
  assert.equal(canManageStaticMapping(STAR_USER, ROWS[5]), false);
  assert.equal(canManageStaticMapping(EMPTY, ROWS[0]), false);
});

test("filterVisibleStaticMappings keeps only project-visible rows and preserves order", () => {
  assert.deepEqual(filterVisibleStaticMappings(LIMITED, ROWS).map((row) => row.id), ["visible", "nested"]);
  assert.deepEqual(filterVisibleStaticMappings(STAR_USER, ROWS).map((row) => row.id), ["visible", "nested", "sibling-prefix", "other"]);
  assert.deepEqual(filterVisibleStaticMappings(EMPTY, ROWS), []);
});

test("filterVisibleStaticMappings: admin keeps everything including legacy rows", () => {
  assert.deepEqual(filterVisibleStaticMappings(ADMIN, ROWS).map((row) => row.id), ROWS.map((row) => row.id));
});
