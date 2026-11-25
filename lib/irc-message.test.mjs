import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseIrcEnvelope, stripIrcEnvelope } = await jiti.import("./irc-message.ts");

const TEMPLATE = (body, from = "scout", extra = "") => `<irc>\nIncoming IRC message from agent \`${from}\`${extra}:\n\n${body}\n</irc>`;

test("strips the envelope and reads the sender from the header line", () => {
  const parsed = parseIrcEnvelope(TEMPLATE("Found the root cause in lib/session-history.ts."));
  assert.equal(parsed.from, "scout");
  assert.equal(parsed.body, "Found the root cause in lib/session-history.ts.");
  assert.equal(parsed.replyTo, undefined);
});

test("keeps the reply target and multi-paragraph bodies", () => {
  const parsed = parseIrcEnvelope(TEMPLATE("first paragraph\n\nsecond paragraph", "impl", " (reply to web-01)"));
  assert.equal(parsed.from, "impl");
  assert.equal(parsed.replyTo, "web-01");
  assert.equal(parsed.body, "first paragraph\n\nsecond paragraph");
});

test("returns null without an envelope so the caller keeps the plain rendering", () => {
  assert.equal(parseIrcEnvelope("just a plain extension message"), null);
  assert.equal(parseIrcEnvelope(""), null);
});

test("malformed envelopes never leak a literal <irc> tag", () => {
  const noClose = parseIrcEnvelope("<irc>\nIncoming IRC message from agent `a`:\n\nbody without close");
  assert.equal(noClose.from, "a");
  assert.doesNotMatch(noClose.body, /<\/?irc>/i);

  const nested = parseIrcEnvelope("<irc>\nIncoming IRC message from agent `a`:\n\nouter <irc>inner</irc> text\n</irc>");
  assert.doesNotMatch(nested.body, /<\/?irc>/i);
  assert.match(nested.body, /outer inner text/);

  const noHeader = parseIrcEnvelope("<irc>\nbody without a header line\n</irc>");
  assert.equal(noHeader.from, "");
  assert.equal(noHeader.body, "body without a header line");
});

test("stripIrcEnvelope removes every tag, including unbalanced ones", () => {
  assert.equal(stripIrcEnvelope("<irc>a</irc><irc>b"), "ab");
  assert.equal(stripIrcEnvelope("<irc from=\"x\">a</IRC >"), "a");
});