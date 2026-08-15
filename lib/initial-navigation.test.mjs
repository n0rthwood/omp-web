import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
    machineId: "local",
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", machineId: "local" },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", machineId: "local" },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Comp-web")),
    { requestedCwd: "C:\\Projects\\omp-web", sessionId: null, machineId: "local" },
  );
});

test("reads the fleet machine from ?machine=, falling back to local", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.equal(
    getInitialNavigation(new URLSearchParams({ machine: " build-box " })).machineId,
    "build-box",
  );
  assert.equal(getInitialNavigation(new URLSearchParams({ machine: "  " })).machineId, "local");
  assert.equal(getInitialNavigation(new URLSearchParams()).machineId, "local");
});
