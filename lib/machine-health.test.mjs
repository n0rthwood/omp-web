import assert from "node:assert/strict";
import test from "node:test";

const {
  machineHealthMapFromReports,
  machineHealthPollIntervalMs,
  shouldApplyMachineHealthResponse,
  MACHINE_HEALTH_POLL_MS,
  MACHINE_HEALTH_DEGRADED_POLL_MS,
} = await import("./machine-health.ts");

test("poll interval stays slow while every machine is online", () => {
  const health = { local: { state: "online" }, "gpu-1": { state: "online" } };
  assert.equal(machineHealthPollIntervalMs(["local", "gpu-1"], health), MACHINE_HEALTH_POLL_MS);
});

test("poll interval is slow with no machines to watch", () => {
  assert.equal(machineHealthPollIntervalMs([], {}), MACHINE_HEALTH_POLL_MS);
});

test("poll interval speeds up while any machine is offline", () => {
  const health = { local: { state: "online" }, "gpu-1": { state: "offline", reason: "HTTP 502" } };
  assert.equal(machineHealthPollIntervalMs(["local", "gpu-1"], health), MACHINE_HEALTH_DEGRADED_POLL_MS);
});

test("poll interval speeds up while any machine is unauthorized", () => {
  const health = { local: { state: "online" }, "gpu-1": { state: "unauthorized" } };
  assert.equal(machineHealthPollIntervalMs(["local", "gpu-1"], health), MACHINE_HEALTH_DEGRADED_POLL_MS);
});

test("poll interval speeds up while any machine has no verdict yet", () => {
  const health = { local: { state: "online" } };
  assert.equal(machineHealthPollIntervalMs(["local", "gpu-1"], health), MACHINE_HEALTH_DEGRADED_POLL_MS);
});

test("a response is applicable only while it owns the latest run and the poller lives", () => {
  assert.equal(shouldApplyMachineHealthResponse(1, 1, false), true);
  // An out-of-order response from an earlier run must not overwrite a newer verdict.
  assert.equal(shouldApplyMachineHealthResponse(1, 2, false), false);
  // Anything landing after unmount is dropped.
  assert.equal(shouldApplyMachineHealthResponse(1, 1, true), false);
});

test("reports collapse into an id-keyed status map without empty reason keys", () => {
  const map = machineHealthMapFromReports([
    { id: "local", state: "online" },
    { id: "gpu-1", state: "offline", reason: "HTTP 502" },
  ]);
  assert.deepEqual(map, {
    local: { state: "online" },
    "gpu-1": { state: "offline", reason: "HTTP 502" },
  });
  assert.ok(!("reason" in map.local));
});
