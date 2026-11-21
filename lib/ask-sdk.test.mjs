import assert from "node:assert/strict";
import { before, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { askToolRenderer } from "@oh-my-pi/pi-tui/tools/ask";

before(() => initThemeSync(undefined, false, "dark", "dark"));

const question = {
  id: "stray",
  question: "Should we continue with this approach?",
  options: [{ label: "Continue" }, { label: "Stop" }],
  recommended: 0,
};

async function executeAsk(dialogResult, questions = [question]) {
  const tool = new AskTool({
    hasUI: false,
    settings: Settings.isolated({ "ask.timeout": 0, "speech.enabled": false }),
    getPlanModeState: () => ({ enabled: true }),
  });
  return tool.execute("ask-discussion-test", { questions }, undefined, undefined, {
    hasUI: true,
    ui: {
      select: async () => assert.fail("rich ask must not fall back to select"),
      editor: async () => assert.fail("rich ask must not fall back to editor"),
      askDialog: async (receivedQuestions) => {
        assert.deepEqual(receivedQuestions, questions);
        return dialogResult;
      },
    },
    abort: () => assert.fail("valid ask discussion must not abort"),
  });
}

function legacyChatResult(questions = [question]) {
  return {
    content: [{
      type: "text",
      text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questions.map((q) => q.question).join("\n")}`,
    }],
    details: { chatRedirect: true, questions: questions.map((q) => q.question) },
  };
}

test("SDK AskTool preserves typed discussion in model-visible content and journal details", async () => {
  const text = "我不认可，需要说明原因";
  const result = await executeAsk({ kind: "chat", discussion: [{ id: "stray", text: `  ${text}\n` }] });
  assert.deepEqual(result.details, {
    chatRedirect: true,
    questions: [question.question],
    discussion: [{ id: "stray", question: question.question, text }],
  });
  assert.equal(result.content[0].type, "text");
  assert.ok(result.content[0].text.startsWith(legacyChatResult().content[0].text));
  assert.ok(result.content[0].text.includes(`Question [stray]: ${question.question}\nUser discussion:\n${text}`));
  assert.ok(result.content[0].text.includes("not an answer or approval of any option"));
  assert.equal(result.details.selectedOptions, undefined);
  assert.equal(result.details.customInput, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).details.discussion, result.details.discussion);
});

test("SDK AskTool matches discussion ids in question order and ignores invalid entries", async () => {
  const questions = [question, { ...question, id: "second", question: "What should change?" }];
  const result = await executeAsk({
    kind: "chat",
    discussion: [
      null,
      { id: "unknown", text: "Do not include this" },
      { id: "stray", text: 42 },
      { id: "stray", text: " \n " },
      { id: "second", text: "  先说明风险  " },
      { id: "stray", text: "  我不认可  " },
      { id: "stray", text: "Duplicate must not replace the first valid entry" },
    ],
  }, questions);
  assert.deepEqual(result.details.discussion, [
    { id: "stray", question: questions[0].question, text: "我不认可" },
    { id: "second", question: questions[1].question, text: "先说明风险" },
  ]);
  assert.ok(result.content[0].text.indexOf("我不认可") < result.content[0].text.indexOf("先说明风险"));
  assert.ok(!result.content[0].text.includes("Do not include this"));
  assert.ok(!result.content[0].text.includes("Duplicate must not replace"));
});

test("SDK AskTool preserves partial multi-question discussion without choosing defaults", async () => {
  const questions = [question, { ...question, id: "second", question: "What should change?" }];
  const result = await executeAsk({ kind: "chat", discussion: [{ id: "second", text: "只讨论第二题" }] }, questions);
  assert.deepEqual(result.details.discussion, [
    { id: "second", question: questions[1].question, text: "只讨论第二题" },
  ]);
  assert.deepEqual(result.details.questions, questions.map((q) => q.question));
  assert.equal(result.details.results, undefined);
  assert.equal(result.details.selectedOptions, undefined);
});

for (const discussion of [undefined, [], [{ id: "stray", text: " \t\n " }], [{ id: "unknown", text: "ignored" }], [{ id: "stray", text: false }], null, "invalid", [null, {}, 42]]) {
  test(`SDK AskTool keeps legacy no-text chat byte-identical: ${JSON.stringify(discussion)}`, async () => {
    const action = discussion === undefined ? { kind: "chat" } : { kind: "chat", discussion };
    const result = await executeAsk(action);
    assert.deepEqual(result, legacyChatResult());
    assert.equal(JSON.stringify(result), JSON.stringify(legacyChatResult()));
    assert.equal(Object.hasOwn(result.details, "discussion"), false);
  });
}

test("SDK AskTool normal submission retains selectedOptions and customInput", async () => {
  const result = await executeAsk({
    kind: "submit",
    results: [{ id: "stray", selectedOptions: ["Continue"], customInput: "正常提交的补充" }],
  });
  assert.deepEqual(result.details.selectedOptions, ["Continue"]);
  assert.equal(result.details.customInput, "正常提交的补充");
  assert.ok(result.content[0].text.includes("Continue"));
  assert.ok(result.content[0].text.includes("正常提交的补充"));
  assert.equal(result.details.chatRedirect, undefined);
  assert.equal(result.details.discussion, undefined);
});

const renderOptions = { expanded: true, isPartial: false };

function nativeText(nodes = []) {
  return nodes.map((entry) => [
    entry.p?.text ?? "",
    (entry.p?.spans ?? []).map((span) => span.t).join(""),
    nativeText(entry.c),
  ].join("\n")).join("\n");
}

function classicText(result) {
  return stripVTControlCharacters(askToolRenderer.renderResult(result, renderOptions, theme).render(120).join("\n"));
}

test("both TUI result views display SDK discussion as a chat redirect, not a chosen answer", async () => {
  const result = await executeAsk({ kind: "chat", discussion: [{ id: "stray", text: "我不认可，需要说明原因" }] });
  const view = askToolRenderer.describeResult(result, renderOptions);
  assert.deepEqual(view.tool.meta, ["chat redirect"]);
  assert.equal(view.tone, "info");
  const native = nativeText(view.body);
  const classic = classicText(result);
  for (const rendered of [native, classic]) {
    assert.ok(rendered.includes(question.question));
    assert.ok(rendered.includes("Discussion"));
    assert.ok(rendered.includes("我不认可，需要说明原因"));
    assert.ok(!rendered.includes("Continue"));
    assert.ok(!rendered.includes("Cancelled"));
  }
  assert.ok(!JSON.stringify(view.body).includes('"name":"check"'));
  assert.ok(classic.includes("chat redirect"));
});

test("TUI discussion replay sanitizes carriage returns and terminal escapes without mutating details", () => {
  const details = {
    chatRedirect: true,
    questions: ["Question"],
    discussion: [{ id: "stray\rid", question: "Why\rnot?", text: "我不\r认可\n\u001b[31m需要说明原因\u001b[0m" }],
  };
  const original = structuredClone(details);
  const result = { content: [], details };
  const native = nativeText(askToolRenderer.describeResult(result, renderOptions).body);
  const classic = classicText(result);
  for (const rendered of [native, classic]) {
    assert.ok(!rendered.includes("\r"));
    assert.ok(!rendered.includes("\u001b"));
    assert.ok(rendered.includes("我不 认可"));
    assert.ok(rendered.includes("需要说明原因"));
  }
  assert.deepEqual(details, original);
});

for (const discussion of [undefined, null, "invalid", [null, {}, { id: "stray", question: "Question", text: 42 }]]) {
  test(`TUI old or malformed discussion details remain renderable: ${JSON.stringify(discussion)}`, () => {
    const details = { chatRedirect: true, questions: ["Question"] };
    if (discussion !== undefined) details.discussion = discussion;
    const result = { content: [], details };
    const native = nativeText(askToolRenderer.describeResult(result, renderOptions).body);
    const classic = classicText(result);
    assert.ok(native.includes("Question"));
    assert.ok(classic.includes("Question"));
    assert.ok(!native.includes("Discussion"));
    assert.ok(!classic.includes("Discussion"));
    assert.ok(classic.includes("chat redirect"));
  });
}
