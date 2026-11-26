// Hidden-model warning icon on the provider status strip (#147):
//   T1 the icon exists only when something is hidden or a scope pattern failed.
//   T2 the unscoped listing groups under the summary's provider order.
//   T3 a large group is capped and its overflow is stated in words.
//   T4 the popover lists providers in order, with counts, ids and warnings.
//   T5 the popover is clamped to the viewport and flips above when needed.
// The DOM behaviour (hover, focus, Escape, activation) has no harness in this
// repo — components are rendered with renderToStaticMarkup and the event
// wiring is verified in the integration stage's browser run.
// Individually runnable: bun test components/HiddenModelsNotice.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  HIDDEN_IDS_CAP,
  HiddenModelsNotice,
  HiddenModelsPopover,
  capHiddenIds,
  groupHiddenModels,
  hiddenNoticeVisible,
  placePopover,
} = await jiti.import("./HiddenModelsNotice.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const names = (provider) => ({ openrouter: "OpenRouter", anthropic: "Anthropic", xai: "xAI" })[provider] ?? provider;

function popover(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(HiddenModelsPopover, {
        hiddenModelCount: 696,
        groups: [],
        warnings: [],
        countsOnly: false,
        displayName: names,
        onOpenAllowList: () => {},
        ...props,
      }),
    ),
  );
}

// ── T1 visibility ───────────────────────────────────────────────────────────

test("the icon exists only when something is hidden or a scope pattern failed", () => {
  assert.equal(hiddenNoticeVisible(undefined, []), false);
  assert.equal(hiddenNoticeVisible(0, []), false);
  assert.equal(hiddenNoticeVisible(0, undefined), false);
  assert.equal(hiddenNoticeVisible(696, []), true);
  assert.equal(hiddenNoticeVisible(undefined, ['No models match pattern "ghost/*"']), true);
  assert.equal(hiddenNoticeVisible(0, ['No models match pattern "ghost/*"']), true);
});

test("nothing renders without a count and without warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(HiddenModelsNotice, {
        hiddenByProvider: [],
        warnings: [],
        displayName: names,
        onOpenAllowList: () => {},
      }),
    ),
  );
  assert.equal(html, "");
});

// ── T2 grouping ─────────────────────────────────────────────────────────────

test("hidden ids group under the summary's provider order", () => {
  const groups = groupHiddenModels(
    [
      { id: "z-model", provider: "zhipu-coding-plan", hidden: false },
      { id: "a-1", provider: "anthropic", hidden: true },
      { id: "o-1", provider: "openrouter", hidden: true },
      { id: "a-2", provider: "anthropic", hidden: true },
      { id: "o-2", provider: "openrouter", hidden: true },
    ],
    [
      { provider: "openrouter", hidden: 629, visible: 7 },
      { provider: "anthropic", hidden: 22, visible: 7 },
    ],
  );
  assert.deepEqual(groups.map((group) => group.provider), ["openrouter", "anthropic"]);
  assert.deepEqual(groups[0].ids, ["o-1", "o-2"]);
  assert.deepEqual(groups[1].ids, ["a-1", "a-2"]);
  assert.equal(groups[0].hidden, 629);
  assert.equal(groups[0].visible, 7);
});

test("a provider with no loaded ids keeps its counts and lists nothing", () => {
  const groups = groupHiddenModels([], [{ provider: "xai", hidden: 37, visible: 0 }]);
  assert.deepEqual(groups, [{ provider: "xai", hidden: 37, visible: 0, ids: [] }]);
});

test("a provider missing from the summary is appended with its own counts", () => {
  const groups = groupHiddenModels(
    [{ id: "x-1", provider: "xai", hidden: true }],
    [{ provider: "openrouter", hidden: 629, visible: 7 }],
  );
  assert.deepEqual(groups.map((group) => group.provider), ["openrouter", "xai"]);
  assert.deepEqual(groups[1], { provider: "xai", hidden: 1, visible: 0, ids: ["x-1"] });
});

// ── T3 cap ──────────────────────────────────────────────────────────────────

test("a large group is capped and the overflow is counted", () => {
  const ids = Array.from({ length: 629 }, (_, index) => `openrouter/model-${index}`);
  const { shown, overflow } = capHiddenIds(ids);
  assert.equal(HIDDEN_IDS_CAP, 30);
  assert.equal(shown.length, 30);
  assert.equal(shown[0], "openrouter/model-0");
  assert.equal(overflow, 599);
});

test("a small group lists every id with no overflow", () => {
  const ids = Array.from({ length: 22 }, (_, index) => `anthropic/claude-${index}`);
  const { shown, overflow } = capHiddenIds(ids);
  assert.equal(shown.length, 22);
  assert.equal(overflow, 0);
});

// ── T4 popover content ──────────────────────────────────────────────────────

test("the popover lists providers in order with their counts and ids", () => {
  const html = popover({
    groups: [
      { provider: "openrouter", hidden: 629, visible: 7, ids: ["openrouter/a", "openrouter/b"] },
      { provider: "anthropic", hidden: 22, visible: 7, ids: ["anthropic/c"] },
    ],
  });
  assert.ok(html.indexOf("OpenRouter") < html.indexOf("Anthropic"), "providers follow the given order");
  assert.match(html, /629 hidden · 7 visible/);
  assert.match(html, /22 hidden · 7 visible/);
  assert.match(html, /openrouter\/a/);
  assert.match(html, /anthropic\/c/);
  assert.match(html, /696 configured models are hidden/);
});

test("the popover states the overflow of a capped group in words", () => {
  const ids = Array.from({ length: 629 }, (_, index) => `openrouter/model-${index}`);
  const html = popover({ groups: [{ provider: "openrouter", hidden: 629, visible: 7, ids }] });
  assert.match(html, /599 more/);
  assert.match(html, /openrouter\/model-0/);
  assert.doesNotMatch(html, /openrouter\/model-30/);
});

test("the popover carries a separate scope-warning section", () => {
  const html = popover({
    groups: [{ provider: "xai", hidden: 37, visible: 0, ids: ["xai/grok"] }],
    warnings: ['No models match pattern "ghost-gateway/*"'],
  });
  assert.match(html, /Model scope warnings/);
  assert.match(html, /ghost-gateway/);
});

test("the popover shows counts only while the ids load", () => {
  const html = popover({
    groups: [{ provider: "openrouter", hidden: 629, visible: 7, ids: ["openrouter/a"] }],
    countsOnly: true,
  });
  assert.match(html, /629 hidden · 7 visible/);
  assert.doesNotMatch(html, /openrouter\/a/);
});

test("the popover action opens the allow-list editor", () => {
  let opened = 0;
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(HiddenModelsPopover, {
        hiddenModelCount: 1,
        groups: [],
        warnings: [],
        countsOnly: true,
        displayName: names,
        onOpenAllowList: () => { opened += 1; },
      }),
    ),
  );
  assert.match(html, /Open the model allow-list/);
  assert.equal(opened, 0, "rendering alone must not activate");
});

// ── T5 placement ────────────────────────────────────────────────────────────

test("the popover sits under the icon and inside the viewport", () => {
  const placed = placePopover(
    { left: 300, right: 316, top: 100, bottom: 116 },
    { width: 300, height: 200 },
    { width: 1280, height: 800 },
  );
  assert.deepEqual(placed, { top: 124, left: 300 });
});

test("the popover is clamped horizontally at a narrow viewport", () => {
  const placed = placePopover(
    { left: 370, right: 386, top: 100, bottom: 116 },
    { width: 300, height: 200 },
    { width: 390, height: 844 },
  );
  assert.equal(placed.left, 82, "390 - 300 - 8");
  assert.ok(placed.left + 300 <= 390);
});

test("the popover flips above the icon when it would overflow the bottom", () => {
  const placed = placePopover(
    { left: 20, right: 36, top: 700, bottom: 716 },
    { width: 300, height: 200 },
    { width: 1280, height: 800 },
  );
  assert.equal(placed.top, 492, "700 - 8 - 200");
});

test("the popover stays inside a viewport too short for either side", () => {
  const placed = placePopover(
    { left: 20, right: 36, top: 400, bottom: 416 },
    { width: 300, height: 700 },
    { width: 390, height: 500 },
  );
  assert.ok(placed.top >= 8);
  assert.ok(placed.top + 700 <= 500 || placed.top === 8, "clamped to the top margin");
});