import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

test("flags known-binary extensions before content is read, case-insensitively", async () => {
  const { isBinaryUploadName } = await loadSubject();

  assert.equal(isBinaryUploadName("photo.PNG"), true);
  assert.equal(isBinaryUploadName("archive.ZIP"), true);
  assert.equal(isBinaryUploadName("notes.txt"), false);
  assert.equal(isBinaryUploadName("data.json"), false);
  assert.equal(isBinaryUploadName("data.json.bak"), false);
});

test("looksBinaryHeader flags a NUL byte only within the first 8KB", async () => {
  const { looksBinaryHeader } = await loadSubject();

  assert.equal(looksBinaryHeader(new TextEncoder().encode("plain ascii text")), false);

  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // "你好" in GBK, not valid UTF-8
  assert.equal(looksBinaryHeader(gbk), false);

  const withNul = new Uint8Array([0x41, 0x42, 0x00, 0x43]);
  assert.equal(looksBinaryHeader(withNul), true);

  const nulAfterWindow = new Uint8Array(8192 + 10).fill(0x41);
  nulAfterWindow[8192 + 5] = 0x00;
  assert.equal(looksBinaryHeader(nulAfterWindow), false);
});

test("nextAvailableUploadPath suffixes before the extension on collision", async (t) => {
  const { nextAvailableUploadPath } = await loadSubject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-upload-next-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(nextAvailableUploadPath(dir, "file.txt"), path.join(dir, "file.txt"));

  fs.writeFileSync(path.join(dir, "file.txt"), "one");
  assert.equal(nextAvailableUploadPath(dir, "file.txt"), path.join(dir, "file-1.txt"));

  fs.writeFileSync(path.join(dir, "file-1.txt"), "two");
  assert.equal(nextAvailableUploadPath(dir, "file.txt"), path.join(dir, "file-2.txt"));
});

test("nextAvailableUploadPath appends the suffix at the end for extensionless names", async (t) => {
  const { nextAvailableUploadPath } = await loadSubject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-upload-noext-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "Makefile"), "old");
  assert.equal(nextAvailableUploadPath(dir, "Makefile"), path.join(dir, "Makefile-1"));
});
