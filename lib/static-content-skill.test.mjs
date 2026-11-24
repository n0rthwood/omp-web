import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./static-content-skill.ts");
  } catch {
    return import("./static-content-skill.ts");
  }
}

const { appendStaticContentSkillDirectory, resolveBuiltinSkillsDirectory } = await loadSubject();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDirectory = join(repoRoot, "skills");

test("resolves the package skills parent independently of session cwd", () => {
  assert.equal(resolveBuiltinSkillsDirectory(join(repoRoot, "lib"), "/tmp/not-a-project"), skillsDirectory);
  assert.equal(resolveBuiltinSkillsDirectory(undefined, repoRoot), skillsDirectory);

  const fixtureRoot = mkdtempSync(join(tmpdir(), "omp-static-skill-"));
  try {
    mkdirSync(join(fixtureRoot, "lib"), { recursive: true });
    mkdirSync(join(fixtureRoot, "skills", "static-content"), { recursive: true });
    writeFileSync(join(fixtureRoot, "skills", "static-content", "SKILL.md"), "---\nname: static-content\n---\n");
    assert.equal(
      resolveBuiltinSkillsDirectory(join(fixtureRoot, "lib"), "/tmp/not-a-project"),
      join(fixtureRoot, "skills"),
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("appends the built-in directory without replacing or reordering user directories", () => {
  const userDirectories = ["/user/first", "/user/second"];
  assert.deepEqual(appendStaticContentSkillDirectory(userDirectories, skillsDirectory), [
    "/user/first",
    "/user/second",
    skillsDirectory,
  ]);
  assert.deepEqual(appendStaticContentSkillDirectory([...userDirectories, skillsDirectory], skillsDirectory), [
    "/user/first",
    "/user/second",
    skillsDirectory,
  ]);
  assert.deepEqual(userDirectories, ["/user/first", "/user/second"]);
});
