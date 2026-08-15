import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadSubject() {
  return import("./machine-store.ts");
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

function tempMachinesFile() {
  const dir = mkdtempSync(join(tmpdir(), "machines-"));
  return { dir, file: join(dir, "omp-web-machines.json") };
}

function sampleInput() {
  return {
    name: "Studio Box",
    baseUrl: "http://192.168.1.50:5010/some/path?x=1",
    authMode: "basic",
    token: "hunter2",
    username: "omp",
    headers: { "X-Cluster": "home" },
  };
}

test("create validates and normalizes fields, persists 0600, and never leaks credentials", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const subject = await loadSubject();
      const machine = subject.createMachine(sampleInput());

      assert.equal(machine.id, "studio-box");
      assert.equal(machine.baseUrl, "http://192.168.1.50:5010"); // origin only
      assert.equal(machine.authMode, "basic");
      assert.equal(machine.token, "hunter2");

      assert.ok(existsSync(file));
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const raw = readFileSync(file, "utf8");
      assert.ok(raw.includes("hunter2")); // stored privately, ...

      // ...but toSafeMachine and listSafeMachines never expose it.
      const safe = subject.toSafeMachine(machine);
      assert.equal(JSON.stringify(safe).includes("hunter2"), false);
      assert.equal(Object.hasOwn(safe, "token"), false);
      assert.equal(Object.hasOwn(safe, "username"), false);
      assert.deepEqual(safe.headerNames, ["x-cluster"]);
      assert.equal(safe.isLocal, false);

      const listing = subject.listSafeMachines();
      assert.equal(listing[0].id, "local");
      assert.equal(listing[0].isLocal, true);
      assert.equal(listing.some((m) => m.id === "studio-box"), true);
      assert.equal(JSON.stringify(listing).includes("hunter2"), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OMP_WEB_MACHINE_NAME renames the synthetic local machine", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file, OMP_WEB_MACHINE_NAME: "joysort123" }, async () => {
      const subject = await loadSubject();
      assert.equal(subject.getLocalSafeMachine().name, "joysort123");
      assert.equal(subject.listSafeMachines()[0].name, "joysort123");
      // Blank falls back to the default rather than an empty label.
      process.env.OMP_WEB_MACHINE_NAME = "  ";
      assert.equal(subject.getLocalSafeMachine().name, "This machine");
      delete process.env.OMP_WEB_MACHINE_NAME;
      assert.equal(subject.getLocalSafeMachine().name, "This machine");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("id is auto-generated with a numeric suffix on collision", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const subject = await loadSubject();
      const first = subject.createMachine({ name: "Build Server", baseUrl: "http://a", authMode: "none" });
      const second = subject.createMachine({ name: "Build Server", baseUrl: "http://b", authMode: "none" });
      assert.equal(first.id, "build-server");
      assert.equal(second.id, "build-server-2");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation rejects bad ids, names, urls, auth modes and forbidden headers", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const subject = await loadSubject();
      const base = { baseUrl: "http://x", authMode: "none" };

      // id slug + reserved "local"
      for (const badId of ["", "UPPER", "-lead", "trail-", "a".repeat(40), "local", "has space"]) {
        assert.throws(
          () => subject.createMachine({ ...base, name: "n", id: badId }),
          (e) => e instanceof subject.MachineValidationError && e.field === "id",
          `expected id rejection for ${JSON.stringify(badId)}`,
        );
      }

      // name length
      for (const badName of ["", "x".repeat(65)]) {
        assert.throws(
          () => subject.createMachine({ ...base, name: badName }),
          (e) => e instanceof subject.MachineValidationError && e.field === "name",
        );
      }

      // baseUrl scheme + shape
      for (const badUrl of ["not a url", "ftp://x", "file:///etc", "http://", ""]) {
        assert.throws(
          () => subject.createMachine({ ...base, name: "n", baseUrl: badUrl }),
          (e) => e instanceof subject.MachineValidationError && e.field === "baseUrl",
          `expected baseUrl rejection for ${JSON.stringify(badUrl)}`,
        );
      }

      // authMode + credential requirement
      assert.throws(
        () => subject.createMachine({ name: "n", baseUrl: "http://x", authMode: "nope" }),
        (e) => e instanceof subject.MachineValidationError && e.field === "authMode",
      );
      for (const mode of ["bearer", "basic"]) {
        assert.throws(
          () => subject.createMachine({ name: "n", baseUrl: "http://x", authMode: mode }),
          (e) => e instanceof subject.MachineValidationError && e.field === "token",
        );
      }

      // header names: charset + hop-by-hop/forbidden
      for (const badHeader of ["host", "authorization", "cookie", "content-length", "connection", "transfer-encoding", "bad name", "x/y"]) {
        assert.throws(
          () => subject.createMachine({ ...base, name: "n", headers: { [badHeader]: "v" } }),
          (e) => e instanceof subject.MachineValidationError && e.field === "headers",
          `expected headers rejection for ${JSON.stringify(badHeader)}`,
        );
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("header values and tokens that cannot be sent are rejected at save time", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const subject = await loadSubject();
      const base = { name: "n", baseUrl: "http://x", authMode: "none" };
      // A stray newline would otherwise throw inside every proxied fetch,
      // making the machine permanently 502 instead of failing this save.
      for (const bad of ["a\r\nx: y", "a\nb", "tab\u0000null", "emoji \u{1F600}"]) {
        assert.throws(
          () => subject.createMachine({ ...base, headers: { "x-a": bad } }),
          (e) => e instanceof subject.MachineValidationError && e.field === "headers",
          `expected header value rejection for ${JSON.stringify(bad)}`,
        );
      }
      assert.throws(
        () => subject.createMachine({ name: "n", baseUrl: "http://x", authMode: "bearer", token: "web_a\nb" }),
        (e) => e instanceof subject.MachineValidationError && e.field === "token",
      );
      // Ordinary values still pass.
      const ok = subject.createMachine({ ...base, headers: { "x-a": "plain value 1" } });
      assert.equal(ok.headers["x-a"], "plain value 1");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update patches fields; token null clears, omitted keeps; delete round-trips", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const subject = await loadSubject();
      const created = subject.createMachine(sampleInput());

      // omitted token keeps the credential
      const renamed = subject.updateMachine(created.id, { name: "Renamed" });
      assert.equal(renamed.name, "Renamed");
      assert.equal(renamed.token, "hunter2");

      // token: null clears it (authMode must drop to none or a token must follow)
      const cleared = subject.updateMachine(created.id, { token: null, authMode: "none" });
      assert.equal(cleared.token, undefined);
      assert.equal(cleared.authMode, "none");

      // re-set a credential and switch mode
      const reauthed = subject.updateMachine(created.id, { authMode: "bearer", token: "web_deadbeef" });
      assert.equal(reauthed.authMode, "bearer");
      assert.equal(reauthed.token, "web_deadbeef");

      // A stored credential is bound to its origin: moving the machine without
      // re-supplying it would let a caller aim the secret at a host they chose.
      assert.throws(
        () => subject.updateMachine(created.id, { baseUrl: "https://example.com/deep/path" }),
        (e) => e instanceof subject.MachineValidationError && e.field === "token",
      );
      const moved = subject.updateMachine(created.id, {
        baseUrl: "https://example.com/deep/path",
        token: "web_deadbeef",
      });
      assert.equal(moved.baseUrl, "https://example.com");

      // Switching authentication off retires the secret instead of parking it.
      const disarmed = subject.updateMachine(created.id, { authMode: "none" });
      assert.equal(disarmed.authMode, "none");
      assert.equal(disarmed.token, undefined);
      assert.equal(subject.getMachine(created.id).token, undefined);
      assert.equal(subject.toSafeMachine(disarmed).hasCredential, false);

      assert.equal(subject.updateMachine("nope", { name: "x" }), null);

      assert.equal(subject.deleteMachine(created.id), true);
      assert.equal(subject.deleteMachine(created.id), false);
      assert.equal(subject.getMachine(created.id), null);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-existing world-readable file is replaced with a 0600 atomic write", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    writeFileSync(file, JSON.stringify({ machines: [] }), { mode: 0o644 });
    chmodSync(file, 0o644);
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const subject = await loadSubject();
      subject.createMachine({ name: "n", baseUrl: "http://x", authMode: "none" });
      assert.equal(statSync(file).mode & 0o777, 0o600);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt or wrong-shape files read as empty, and reads are mtime-cached", async () => {
  const { dir, file } = tempMachinesFile();
  try {
    writeFileSync(file, "{not json");
    await withEnv({ OMP_WEB_MACHINES_FILE: file }, async () => {
      const subject = await loadSubject();
      assert.equal(subject.listMachines().length, 0);

      writeFileSync(file, JSON.stringify({ machines: [{ id: "junk" }, { id: "ok", name: "ok", baseUrl: "http://ok", authMode: "none", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] }));
      const machines = subject.listMachines();
      assert.equal(machines.length, 1); // junk row dropped, valid row kept
      assert.equal(machines[0].id, "ok");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
