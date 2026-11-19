import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildProjectForest, isProjectWithin, projectDisplayName } = await jiti.import("./project-nesting.ts");

function node(root, children = []) {
  return { root, name: projectDisplayName(root), children };
}

test("containment respects slash boundaries", () => {
  assert.equal(isProjectWithin("/home/a/project", "/home/a"), true);
  assert.equal(isProjectWithin("/home/ab", "/home/a"), false);
  assert.equal(isProjectWithin("/home/a", "/home/ab"), false);
});

test("equal paths are within their root", () => {
  assert.equal(isProjectWithin("/home/a", "/home/a"), true);
  assert.equal(isProjectWithin("relative/project", "relative/project"), true);
});

test("trailing slashes normalize on both sides", () => {
  assert.equal(isProjectWithin("/home/a///", "/home/a/"), true);
  assert.equal(isProjectWithin("/home/a/b/", "/home/a///"), true);
  assert.equal(isProjectWithin("/home/ab/", "/home/a/"), false);
});

test("POSIX comparison remains case sensitive", () => {
  assert.equal(isProjectWithin("/home/A/project", "/home/a"), false);
});

test("empty paths and roots do not contain projects", () => {
  assert.equal(isProjectWithin("/home/a", ""), false);
  assert.equal(isProjectWithin("", "/"), false);
  assert.equal(isProjectWithin("", ""), false);
});

test("filesystem root contains absolute paths only", () => {
  assert.equal(isProjectWithin("/", "/"), true);
  assert.equal(isProjectWithin("/home/a", "/"), true);
  assert.equal(isProjectWithin("/home/a", "///"), true);
  assert.equal(isProjectWithin("home/a", "/"), false);
  assert.equal(isProjectWithin("C:\\Users\\x", "/"), true);
});

test("Windows paths compare case insensitively at separator boundaries", () => {
  assert.equal(isProjectWithin("C:\\Users\\x\\proj", "C:\\Users\\x"), true);
  assert.equal(isProjectWithin("c:\\users\\X\\proj", "C:\\Users\\x"), true);
  assert.equal(isProjectWithin("C:\\Users\\xy", "C:\\Users\\x"), false);
  assert.equal(isProjectWithin("D:\\Users\\x\\proj", "C:\\Users\\x"), false);
});

test("Windows equal paths and trailing separators normalize", () => {
  assert.equal(isProjectWithin("c:\\USERS\\x\\", "C:\\Users\\x"), true);
  assert.equal(isProjectWithin("C:\\Users\\x\\proj\\", "C:\\Users\\x\\"), true);
  assert.equal(isProjectWithin("C:\\Users\\x", "C:\\"), true);
});

test("Windows paths accept mixed separators", () => {
  assert.equal(isProjectWithin("C:/Users/x\\proj/sub", "c:\\Users/x/"), true);
  assert.equal(isProjectWithin("C:/Users/xy/proj", "C:\\Users/x"), false);
});

test("UNC paths use Windows separators and case comparison", () => {
  assert.equal(isProjectWithin("\\\\SERVER\\Share\\Root\\proj", "//server/share/root"), true);
  assert.equal(isProjectWithin("//server/share/root-other", "\\\\server\\share\\root"), false);
});

test("empty forest has no nodes", () => {
  assert.deepEqual(buildProjectForest([]), []);
});

test("duplicate roots produce a single node", () => {
  assert.deepEqual(buildProjectForest(["/a", "/a", "/a/b", "/a/b"]), [node("/a", [node("/a/b")])]);
});

test("nearest existing ancestor wins in a multi-level chain", () => {
  assert.deepEqual(buildProjectForest(["/a/b/c", "/a", "/a/b"]), [node("/a", [node("/a/b", [node("/a/b/c")])])]);
});

test("absent intermediate directories are not synthesized", () => {
  assert.deepEqual(buildProjectForest(["/a/b/c", "/a"]), [node("/a", [node("/a/b/c")])]);
});

test("siblings and top-level nodes sort by exact root string", () => {
  assert.deepEqual(buildProjectForest(["/z", "/a/c", "/a", "/ab", "/a/b"]), [
    node("/a", [node("/a/b"), node("/a/c")]), node("/ab"), node("/z"),
  ]);
});

test("forest structure is independent of input order", () => {
  const roots = ["/z", "/a/c", "/a", "/a/b/c", "/a/b", "/ab"];
  const expected = buildProjectForest(roots);
  for (let offset = 0; offset < roots.length; offset++) {
    const rotated = [...roots.slice(offset), ...roots.slice(0, offset)];
    assert.deepEqual(buildProjectForest(rotated), expected);
    assert.deepEqual(buildProjectForest(rotated.reverse()), expected);
  }
});

test("forest nests Windows roots and preserves exact cwd keys", () => {
  assert.deepEqual(buildProjectForest(["C:/Users/x/proj/sub", "c:\\users\\x", "C:\\Users\\x\\proj"]), [
    node("c:\\users\\x", [node("C:\\Users\\x\\proj", [node("C:/Users/x/proj/sub")])]),
  ]);
});

test("equivalent roots cannot parent each other or create cycles", () => {
  assert.deepEqual(buildProjectForest(["/a/", "/a", "/a/b"]), [node("/a", [node("/a/b")]), node("/a/")]);
  assert.deepEqual(buildProjectForest(["C:\\Users\\x", "c:/users/x/"]), [node("C:\\Users\\x"), node("c:/users/x/")]);
});

test("nearest ancestor ignores redundant trailing separator length", () => {
  assert.deepEqual(buildProjectForest(["/a///////////", "/a/b", "/a/b/c"]), [
    node("/a///////////", [node("/a/b", [node("/a/b/c")])]),
  ]);
});

test("filesystem root is retained without synthetic intermediates", () => {
  assert.deepEqual(buildProjectForest(["/home/a", "/", "/tmp"]), [node("/", [node("/home/a"), node("/tmp")])]);
});

test("display names strip trailing separators and preserve CJK segments", () => {
  assert.equal(projectDisplayName("/home/projects/"), "projects");
  assert.equal(projectDisplayName("C:\\Users\\x\\proj\\"), "proj");
  assert.equal(projectDisplayName("C:/Users\\x/proj//"), "proj");
  assert.equal(projectDisplayName("/opt/workspace/designer/projects/2026-11-19_水滴挡板钣金_swcli"), "2026-11-19_水滴挡板钣金_swcli");
});

test("display names fall back to full roots without a segment", () => {
  assert.equal(projectDisplayName("/"), "/");
  assert.equal(projectDisplayName("///"), "///");
  assert.equal(projectDisplayName(""), "");
  assert.equal(projectDisplayName("project"), "project");
});
