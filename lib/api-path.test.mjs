import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  LOCAL_MACHINE_ID,
  apiPath,
  appUrl,
  getCurrentMachineId,
  machineStorageKey,
  setCurrentMachineId,
} from "./api-path.ts";

test("local passthrough: apiPath returns /api/ paths unchanged for local machine", () => {
  setCurrentMachineId(LOCAL_MACHINE_ID);
  assert.equal(apiPath("/api/sessions"), "/api/sessions");
  assert.equal(apiPath("/api/sessions?force=1"), "/api/sessions?force=1");
  assert.equal(apiPath("/api/files/a%20b?type=read&v=2"), "/api/files/a%20b?type=read&v=2");
});

test("remote prefixing without query string", () => {
  setCurrentMachineId("boxtwo");
  assert.equal(apiPath("/api/sessions"), "/api/machines/boxtwo/api/sessions");
});

test("remote prefixing preserves the query string", () => {
  setCurrentMachineId("boxtwo");
  assert.equal(
    apiPath("/api/sessions?force=1&cwd=%2Ftmp"),
    "/api/machines/boxtwo/api/sessions?force=1&cwd=%2Ftmp",
  );
});

test("non-/api/ strings are untouched, even on a remote machine", () => {
  setCurrentMachineId("boxtwo");
  assert.equal(apiPath("/static/logo.png"), "/static/logo.png");
  assert.equal(apiPath("api/sessions"), "api/sessions");
  assert.equal(apiPath(""), "");
  assert.equal(apiPath("/api"), "/api"); // does not start with "/api/"
});

test("machine id is encodeURIComponent'd", () => {
  setCurrentMachineId("we ird/id");
  assert.equal(
    apiPath("/api/sessions"),
    `/api/machines/${encodeURIComponent("we ird/id")}/api/sessions`,
  );
});

test("explicit machineId argument overrides the module-level current machine", () => {
  setCurrentMachineId("boxtwo");
  assert.equal(apiPath("/api/sessions", LOCAL_MACHINE_ID), "/api/sessions");
  assert.equal(apiPath("/api/sessions", "boxthree"), "/api/machines/boxthree/api/sessions");
});

test("setCurrentMachineId maps empty string to local", () => {
  setCurrentMachineId("boxtwo");
  setCurrentMachineId("");
  assert.equal(getCurrentMachineId(), LOCAL_MACHINE_ID);
  assert.equal(apiPath("/api/sessions"), "/api/sessions");
});

test("storage key is unchanged locally and namespaced per machine remotely", () => {
  setCurrentMachineId(LOCAL_MACHINE_ID);
  assert.equal(machineStorageKey("pi-web:last-open-by-workspace"), "pi-web:last-open-by-workspace");
  assert.equal(machineStorageKey("omp-web-terminal-tabs:/home/x"), "omp-web-terminal-tabs:/home/x");

  setCurrentMachineId("boxtwo");
  assert.equal(machineStorageKey("pi-web:last-open-by-workspace"), "m:boxtwo:pi-web:last-open-by-workspace");
  assert.equal(machineStorageKey("omp-web-terminal-tabs:/home/x", "boxthree"), "m:boxthree:omp-web-terminal-tabs:/home/x");
});

test("storage key machine id is encodeURIComponent'd", () => {
  setCurrentMachineId("we ird");
  assert.equal(machineStorageKey("k"), `m:${encodeURIComponent("we ird")}:k`);
});

test("appUrl keeps the machine alongside the session", () => {
  setCurrentMachineId(LOCAL_MACHINE_ID);
  assert.equal(appUrl({}), "/");
  assert.equal(appUrl({ session: "s1" }), "?session=s1");

  setCurrentMachineId("boxtwo");
  assert.equal(appUrl({}), "?machine=boxtwo");
  assert.equal(appUrl({ session: "s1" }), "?machine=boxtwo&session=s1");
  assert.equal(appUrl({ session: null }), "?machine=boxtwo");
  // An explicit id overrides the current machine, for the switch itself.
  assert.equal(appUrl({}, LOCAL_MACHINE_ID), "/");
});

// The current machine is module-level state shared by every test file in this
// process: restore it after the suite, not at module load (which runs first).
after(() => setCurrentMachineId(LOCAL_MACHINE_ID));
