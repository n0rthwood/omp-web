import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_URL, buildUrl, parseLocation } from "./nav-url.ts";

// --- ROOT_URL --------------------------------------------------------------

test("ROOT_URL is /", () => {
  assert.equal(ROOT_URL, "/");
});

// --- round-trips: the 6 canonical shapes ------------------------------------

test("round-trip: root (local, no project, no session) -> /", () => {
  const target = { machineId: "local", project: null, session: null };
  assert.equal(buildUrl(target), "/");
});

test("round-trip: /m/<id>", () => {
  const target = { machineId: "box2", project: null, session: null };
  const url = buildUrl(target);
  assert.equal(url, "/m/box2");
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

test("round-trip: /m/<id>/p/<project>", () => {
  const target = { machineId: "box2", project: "/home/alice/proj", session: null };
  const url = buildUrl(target);
  assert.equal(url, `/m/box2/p/${encodeURIComponent("/home/alice/proj")}`);
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

test("round-trip: /m/<id>/p/<project>/s/<session>", () => {
  const target = { machineId: "box2", project: "/home/alice/proj", session: "sess-1" };
  const url = buildUrl(target);
  assert.equal(url, `/m/box2/p/${encodeURIComponent("/home/alice/proj")}/s/sess-1`);
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

test("round-trip: /p/<project> (local machine, segment omitted)", () => {
  const target = { machineId: "local", project: "/home/alice/proj", session: null };
  const url = buildUrl(target);
  assert.equal(url, `/p/${encodeURIComponent("/home/alice/proj")}`);
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

test("round-trip: /p/<project>/s/<session> (local machine, segment omitted)", () => {
  const target = { machineId: "local", project: "/home/alice/proj", session: "sess-1" };
  const url = buildUrl(target);
  assert.equal(url, `/p/${encodeURIComponent("/home/alice/proj")}/s/sess-1`);
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

// --- single-segment encoding -------------------------------------------------

test("project segment percent-encodes every '/' so a multi-directory path stays one segment", () => {
  const target = { machineId: "local", project: "/home/alice/my project", session: null };
  const url = buildUrl(target);
  assert.equal(url.split("/").length, 3); // "", "p", "<one encoded segment>"
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

test("project/session segments encode %, spaces, non-ASCII, +, #, ?", () => {
  const weird = "/tmp/100% done + café? #1 <weird>";
  const target = { machineId: "local", project: weird, session: weird };
  const url = buildUrl(target);
  // No raw '%', ' ', '#', '?' outside of percent-encoded triplets: verified
  // by round-tripping through parseLocation below, plus a literal check that
  // '#' and '?' (which are URL-meaningful) never appear unescaped.
  assert.ok(!url.includes("#"));
  assert.ok(!url.includes("?"));
  assert.ok(!url.includes(" "));
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

test("machineId itself is encoded when it needs it", () => {
  const target = { machineId: "we ird/id", project: null, session: null };
  const url = buildUrl(target);
  assert.equal(url, `/m/${encodeURIComponent("we ird/id")}`);
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

// --- malformed shapes -> root -------------------------------------------------

test("malformed: /m/x/s/y (session without /p/) -> root", () => {
  assert.deepEqual(parseLocation("/m/x/s/y", ""), { kind: "root" });
});

test("malformed: /p/x/z/y (extra unexpected segment) -> root", () => {
  assert.deepEqual(parseLocation("/p/x/z/y", ""), { kind: "root" });
});

test("malformed: trailing junk after a full /m/.../p/.../s/... shape -> root", () => {
  assert.deepEqual(parseLocation("/m/x/p/y/s/z/extra", ""), { kind: "root" });
});

test("malformed: /m/x/p (empty project segment, nothing after p) -> root", () => {
  assert.deepEqual(parseLocation("/m/x/p", ""), { kind: "root" });
});

test("malformed: /p//s/y (empty project segment via double slash) -> root", () => {
  assert.deepEqual(parseLocation("/p//s/y", ""), { kind: "root" });
});

test("malformed: /x (unrecognized top segment) -> root", () => {
  assert.deepEqual(parseLocation("/x", ""), { kind: "root" });
});

test("malformed: undecodable percent-sequence -> root, never throws", () => {
  assert.doesNotThrow(() => parseLocation("/p/%", ""));
  assert.deepEqual(parseLocation("/p/%", ""), { kind: "root" });
  assert.deepEqual(parseLocation("/m/%E0%A4%A", ""), { kind: "root" });
});

test("malformed: leading double slash -> root, never throws", () => {
  assert.deepEqual(parseLocation("//m/x", ""), { kind: "root" });
});

test("session-without-project via buildUrl is dropped defensively", () => {
  const url = buildUrl({ machineId: "local", project: null, session: "orphan" });
  assert.equal(url, "/");
});

test("session-without-project stays local machine + drops session even with a remote machine", () => {
  const url = buildUrl({ machineId: "box2", project: null, session: "orphan" });
  assert.equal(url, "/m/box2");
});

// --- bare /m and /p -> resume -------------------------------------------------

test("bare /m -> resume", () => {
  assert.deepEqual(parseLocation("/m", ""), { kind: "resume" });
});

test("bare /p -> resume", () => {
  assert.deepEqual(parseLocation("/p", ""), { kind: "resume" });
});

test("bare /m/ and /p/ (trailing slash) -> resume", () => {
  assert.deepEqual(parseLocation("/m/", ""), { kind: "resume" });
  assert.deepEqual(parseLocation("/p/", ""), { kind: "resume" });
});

test("/ -> resume", () => {
  assert.deepEqual(parseLocation("/", ""), { kind: "resume" });
});

// --- machineId = "local" in the path ------------------------------------------

test("/m/local/p/<project> normalizes to the same target as /p/<project>", () => {
  const project = "/home/alice/proj";
  const viaMachine = parseLocation(`/m/local/p/${encodeURIComponent(project)}`, "");
  const viaOmitted = parseLocation(`/p/${encodeURIComponent(project)}`, "");
  assert.deepEqual(viaMachine, viaOmitted);
  assert.deepEqual(viaMachine, {
    kind: "target",
    target: { machineId: "local", project, session: null },
  });
});

test("buildUrl never emits /m/local: an explicit local target always omits the machine segment", () => {
  assert.equal(buildUrl({ machineId: "local", project: null, session: null }), "/");
  assert.equal(buildUrl({ machineId: "local", project: "proj", session: null }), "/p/proj");
});

// --- decode of encoded ids -----------------------------------------------------

test("decodes percent-encoded machine id, project, and session", () => {
  const target = { machineId: "box two", project: "a/b c", session: "s d" };
  const url = `/m/${encodeURIComponent("box two")}/p/${encodeURIComponent("a/b c")}/s/${encodeURIComponent("s d")}`;
  assert.deepEqual(parseLocation(url, ""), { kind: "target", target });
});

// --- legacy query matrix ---------------------------------------------------

test("legacy: bare ?cwd= on / selects local machine + project, no session", () => {
  const search = new URLSearchParams({ cwd: "/home/alice" });
  assert.deepEqual(parseLocation("/", search), {
    kind: "target",
    target: { machineId: "local", project: "/home/alice", session: null },
  });
});

test("legacy: ?session= alone (no cwd) sets session with a null project", () => {
  const search = new URLSearchParams({ session: "s1" });
  assert.deepEqual(parseLocation("/", search), {
    kind: "target",
    target: { machineId: "local", project: null, session: "s1" },
  });
});

test("legacy: cwd beats session when both are present", () => {
  const search = new URLSearchParams({ cwd: "/home/alice", session: "s1" });
  assert.deepEqual(parseLocation("/", search), {
    kind: "target",
    target: { machineId: "local", project: "/home/alice", session: null },
  });
});

test("legacy: ?machine= alone selects the remote machine with no project/session", () => {
  const search = new URLSearchParams({ machine: "box2" });
  assert.deepEqual(parseLocation("/", search), {
    kind: "target",
    target: { machineId: "box2", project: null, session: null },
  });
});

test("legacy: machine + session combine (no cwd)", () => {
  const search = new URLSearchParams({ machine: "box2", session: "s1" });
  assert.deepEqual(parseLocation("/", search), {
    kind: "target",
    target: { machineId: "box2", project: null, session: "s1" },
  });
});

test("legacy: machine + cwd combine, cwd wins over absent session", () => {
  const search = new URLSearchParams({ machine: "box2", cwd: "/home/alice" });
  assert.deepEqual(parseLocation("/", search), {
    kind: "target",
    target: { machineId: "box2", project: "/home/alice", session: null },
  });
});

test("legacy: empty-string values are treated as absent", () => {
  const search = new URLSearchParams({ machine: "", session: "", cwd: "" });
  assert.deepEqual(parseLocation("/", search), { kind: "resume" });
});

test("legacy: whitespace-only values are treated as absent", () => {
  const search = new URLSearchParams({ cwd: "   ", session: "   " });
  assert.deepEqual(parseLocation("/", search), { kind: "resume" });
});

test("legacy: whitespace is trimmed off a real value", () => {
  const search = new URLSearchParams({ cwd: "  /home/alice  " });
  assert.deepEqual(parseLocation("/", search), {
    kind: "target",
    target: { machineId: "local", project: "/home/alice", session: null },
  });
});

test("legacy: query params override path parsing, even on a fully-formed /m/.../p/... path", () => {
  const search = new URLSearchParams({ cwd: "/other" });
  assert.deepEqual(parseLocation("/m/box2/p/somewhere", search), {
    kind: "target",
    target: { machineId: "local", project: "/other", session: null },
  });
});

test("legacy: no query keys present at all falls through to path parsing", () => {
  assert.deepEqual(parseLocation("/m/box2", new URLSearchParams()), {
    kind: "target",
    target: { machineId: "box2", project: null, session: null },
  });
  assert.deepEqual(parseLocation("/m/box2", new URLSearchParams({ other: "1" })), {
    kind: "target",
    target: { machineId: "box2", project: null, session: null },
  });
});

test("search accepts a raw string (with or without leading '?') as well as URLSearchParams", () => {
  assert.deepEqual(parseLocation("/", "cwd=/home/alice"), {
    kind: "target",
    target: { machineId: "local", project: "/home/alice", session: null },
  });
  assert.deepEqual(parseLocation("/", "?cwd=/home/alice"), {
    kind: "target",
    target: { machineId: "local", project: "/home/alice", session: null },
  });
});
