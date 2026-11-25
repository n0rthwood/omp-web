// Provider status strip above the composer (issue #145):
//   T1 nothing to show → nothing rendered.
//   T2 codex lists every metered window, not only `primary`.
//   T3 the trailing time is the oldest measurement on the line.
//   T4 one line: nowrap row + mobile headline rule in globals.css.
//   T5 mounted above the composer by ChatWindow, polled once by the shell.
// Individually runnable: bun test components/ProviderStatusStrip.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ProviderStatusStrip } = await jiti.import("./ProviderStatusStrip.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");

const LONG_TIME = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

/** Today at 09:05 local, so the strip label is the short clock form. */
function todayAt(hour, minute) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function clock(time) {
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const CODEX_WINDOWS = [
  { id: "openai-codex:primary", label: "5 hours", unit: "percent", usedPercent: 12, status: "ok", windowId: "5h" },
  { id: "openai-codex:secondary", label: "7 days", unit: "percent", usedPercent: 30, status: "ok", windowId: "7d" },
  { id: "openai-codex:spark:primary", label: "5 hours (Spark)", unit: "percent", usedPercent: 80, status: "warning", windowId: "5h" },
];

function codex(overrides = {}) {
  return {
    id: "openai-codex",
    displayName: "OpenAI",
    kind: "oauth-usage",
    status: "warning",
    windows: CODEX_WINDOWS,
    ...overrides,
  };
}

function render(snapshot) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ProviderStatusStrip, { snapshot, onOpenModels: () => {} }),
    ),
  );
}

// ── T1 nothing to show ──────────────────────────────────────────────────────

test("renders nothing without a snapshot or without providers", () => {
  assert.equal(render(null), "");
  assert.equal(render({ fetchedAt: Date.now(), nextPollAt: null, providers: [] }), "");
});

// ── T2 every codex window ───────────────────────────────────────────────────

test("codex shows every metered window, not only the primary one", () => {
  const html = render({ fetchedAt: Date.now(), nextPollAt: null, providers: [codex()] });
  const shown = html.match(/provider-status-headline[^>]*>([^<]*)</)[1];
  assert.equal(shown, "5h 12% · 7d 30% · spark 5h 80%");
});

test("a codex window without an SDK window id falls back to the id's last segment", () => {
  const providers = [codex({
    windows: [{ id: "openai-codex:secondary", label: "Secondary window", unit: "percent", usedPercent: 30, status: "ok" }],
  })];
  const html = render({ fetchedAt: Date.now(), nextPollAt: null, providers });
  assert.match(html, /provider-status-headline[^>]*>secondary 30%</);
});

// ── T3 data time ────────────────────────────────────────────────────────────

test("the trailing time is the oldest measurement on the line, not the poll cycle", () => {
  const cycle = todayAt(10, 0);
  const measured = todayAt(9, 5);
  const html = render({
    fetchedAt: cycle,
    nextPollAt: todayAt(10, 30),
    // A presence row has no measurement of its own: it counts as the cycle.
    providers: [
      codex({ recordedAt: measured }),
      { id: "zhipu-coding-plan", displayName: "Zhipu", kind: "presence", status: "ok", windows: [] },
    ],
  });
  assert.ok(html.includes(`as of ${clock(measured)}`), "label names the stalest report");
  assert.ok(!html.includes(`as of ${clock(cycle)}`), "the fresher cycle time must not be claimed");
  assert.match(html, new RegExp(`Data as of ${new Date(measured).toLocaleString(undefined, LONG_TIME)}`));
  assert.match(html, new RegExp(`Data as of ${new Date(cycle).toLocaleString(undefined, LONG_TIME)}`));
  assert.match(html, new RegExp(`next poll ${new Date(todayAt(10, 30)).toLocaleString(undefined, LONG_TIME)}`));
});

test("a measurement older than today is labelled with its date", () => {
  const measured = todayAt(9, 5) - 24 * 60 * 60_000;
  const html = render({ fetchedAt: Date.now(), nextPollAt: null, providers: [codex({ recordedAt: measured })] });
  assert.ok(html.includes(`as of ${new Date(measured).toLocaleString(undefined, LONG_TIME)}`));
  assert.doesNotMatch(html, /data-testid="provider-status-data-time"[^>]*>as of \d\d:\d\d</);
});

test("no time is claimed before any measurement exists", () => {
  const html = render({ fetchedAt: null, nextPollAt: null, providers: [codex()] });
  assert.doesNotMatch(html, /provider-status-data-time/);
  assert.match(html, /Fetching…/);
});

// ── T4 one line ─────────────────────────────────────────────────────────────

test("the row never wraps and the mobile rule drops headline text", async () => {
  const html = render({ fetchedAt: Date.now(), nextPollAt: null, providers: [codex()] });
  assert.match(html, /data-testid="provider-status-strip"[^>]*style="[^"]*white-space:nowrap/);
  assert.match(html, /flex-wrap:nowrap/);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.provider-status-headline\s*\{\s*display:\s*none;/);
});

test("every strip string is translated in both locales", () => {
  for (const key of [
    "providerStatus.title", "providerStatus.openrouterHeadline", "providerStatus.modelWindow",
    "providerStatus.resetsAt", "providerStatus.accounts", "providerStatus.unnamedKey",
    "providerStatus.errorLine", "providerStatus.absent", "providerStatus.dataAt",
    "providerStatus.dataTime", "providerStatus.ageMinutes", "providerStatus.ageHours",
    "providerStatus.nextPoll", "providerStatus.pending",
  ]) {
    assert.equal(typeof enLocale.messages[key], "string", `en missing ${key}`);
    assert.equal(typeof zhCNLocale.messages[key], "string", `zh-CN missing ${key}`);
    assert.notEqual(enLocale.messages[key], zhCNLocale.messages[key], `${key} is untranslated`);
  }
});

// ── T5 mount points ─────────────────────────────────────────────────────────

test("the shell owns the poll and the strip sits above the composer in both layouts", async () => {
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

  // The sidebar mount is gone; the shell polls once and hands the result down.
  assert.doesNotMatch(shell, /<ProviderStatusStrip/);
  assert.doesNotMatch(shell, /from "\.\/ProviderStatusStrip"/);
  assert.match(shell, /const providerStatus = useProviderStatus\(\);/);
  assert.match(shell, /providerStatus=\{providerStatus\}/);
  assert.match(shell, /onOpenModels=\{openModelsSettings\}/);

  // Empty-session layout and conversation layout each render the strip
  // immediately before the composer.
  // (three matches: the empty-session layout, and the conversation layout's
  // guard plus the element inside it).
  const stripAt = [...chatWindow.matchAll(/\{providerStatusElement/g)].map((match) => match.index);
  const inputAt = [...chatWindow.matchAll(/\{chatInputElement\}/g)].map((match) => match.index);
  assert.equal(stripAt.length, 3, "both layouts mount the strip");
  assert.equal(inputAt.length, 2, "both layouts mount the composer");
  assert.ok(stripAt[0] < inputAt[0] && inputAt[0] < stripAt[1] && stripAt[2] < inputAt[1]);
});
