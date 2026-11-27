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
const { SyncWizard, SyncTargetList, SyncDiffSummary } = await jiti.import("./SyncWizard.tsx");
const { I18nProvider } = await jiti.import("../../hooks/useI18n.tsx");
const { enLocale } = await jiti.import("../../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../../lib/i18n/messages/zh-CN.ts");

const MACHINES = [
  { id: "box-202", name: "172.30.3.202" },
  { id: "box-39", name: "172.30.3.39" },
];
const ALL_IDS = MACHINES.map((machine) => machine.id);

function renderElement(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, element));
}

function render(props = {}) {
  return renderElement(React.createElement(SyncWizard, {
    open: true,
    onClose: () => {},
    initialSections: ["providers", "roles", "enabledModels"],
    machines: MACHINES,
    ...props,
  }));
}

function section(html, name) {
  const start = html.indexOf(`data-testid="sync-section-${name}"`);
  assert.ok(start >= 0, `section ${name} is rendered`);
  const next = html.indexOf('data-testid="sync-section-', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

/** One machine's markup, from its test id up to the next machine's. */
function part(html, testId, prefix) {
  const start = html.indexOf(`data-testid="${testId}"`);
  assert.ok(start >= 0, `${testId} is rendered`);
  const next = html.indexOf(`data-testid="${prefix}`, start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

// ── step 1 (container, static) ──────────────────────────────────────────────

test("step 1 presets sections from the entry point and marks OAuth as excluded", () => {
  const html = render({ initialSections: ["roles"] });
  assert.match(html, /data-testid="sync-wizard"/);
  assert.match(section(html, "roles"), /checked/);
  assert.doesNotMatch(section(html, "providers"), /checked/);
  assert.doesNotMatch(section(html, "enabledModels"), /checked/);
  assert.match(html, /Subscription-login provider configuration/);
});

test("the allow-list entry point presets only enabledModels", () => {
  const html = render({ initialSections: ["enabledModels"] });
  assert.match(section(html, "enabledModels"), /checked/);
  assert.doesNotMatch(section(html, "roles"), /checked/);
  assert.doesNotMatch(section(html, "providers"), /checked/);
});

test("a closed wizard renders nothing", () => {
  assert.equal(render({ open: false }), "");
});

test("step 1 offers no target list until step 2 and the next button is gated on a selection", () => {
  const html = render({ initialSections: ["providers"] });
  assert.doesNotMatch(html, /data-testid="sync-target-box-202"/);
  assert.doesNotMatch(html, /data-testid="sync-preflight-again"/);
  assert.match(html, /data-testid="sync-next"/);
  assert.match(html, /disabled/);
});

test("every wizard string is translated in both locales", () => {
  const keys = [
    "sync.title", "sync.source", "sync.close", "sync.step.sections", "sync.step.targets",
    "sync.step.push", "sync.section.providers", "sync.section.providersDetail", "sync.section.roles",
    "sync.section.rolesDetail", "sync.section.enabledModels", "sync.section.enabledModelsDetail",
    "sync.excludedNote", "sync.excludedActual", "sync.fallbackNote", "sync.targetsHint", "sync.noTargets", "sync.preflightAgain",
    "sync.checking", "sync.ready", "sync.readyChanges", "sync.readyInSync", "sync.hasIssues",
    "sync.issueMissingKey", "sync.issueNotLoggedIn", "sync.noPreflightData", "sync.diffChanges",
    "sync.diffInSync", "sync.status.applied", "sync.status.skipped", "sync.status.inSync", "sync.status.failed", "sync.back",
    "sync.cancel", "sync.next", "sync.push", "sync.done",
  ];
  for (const key of keys) {
    assert.equal(typeof enLocale.messages[key], "string", `en missing ${key}`);
    assert.equal(typeof zhCNLocale.messages[key], "string", `zh-CN missing ${key}`);
    assert.notEqual(enLocale.messages[key], zhCNLocale.messages[key], `${key} is untranslated`);
  }
});

// ── step 2 body: per-machine preflight status ───────────────────────────────

const READY = { machineName: "box", status: "skipped", detail: "Dry run: changes pending", changed: true, issues: [] };

function targetList(preflight, { checking = false, targets = ALL_IDS } = {}) {
  return renderElement(React.createElement(SyncTargetList, {
    machines: MACHINES,
    targets,
    preflight: new Map(Object.entries(preflight)),
    checking,
  }));
}

test("each machine row carries its own preflight verdict", () => {
  const html = targetList({
    "box-202": { ...READY, machineId: "box-202" },
    "box-39": { ...READY, machineId: "box-39", changed: false },
  });
  assert.match(part(html, "sync-preflight-box-202", "sync-target-"), /✓ credentials ready · changes pending/);
  assert.match(part(html, "sync-preflight-box-39", "sync-target-"), /✓ credentials ready · already in sync/);
});

test("findings are worded in the UI language from the structured issues", () => {
  const html = targetList({
    "box-39": {
      ...READY,
      machineId: "box-39",
      issues: [
        { kind: "missing_key", provider: "joyai", envVar: "JOYAI_API_KEY" },
        { kind: "not_logged_in", provider: "anthropic" },
      ],
    },
  });
  const row = part(html, "sync-preflight-box-39", "sync-target-");
  assert.match(row, /⚠ JOYAI_API_KEY missing — it still syncs, but runs degraded/);
  assert.match(row, /⚠ anthropic not logged in — falls back through its own fallbackChains/);
});

test("an older target's fixed English warning lines are shown verbatim", () => {
  const line = "ZHIPU_API_KEY missing — provider zhipu-coding-plan will sync but run degraded";
  const html = targetList({ "box-39": { ...READY, machineId: "box-39", warnings: [line] } });
  assert.ok(part(html, "sync-preflight-box-39", "sync-target-").includes(`⚠ ${line}`));
});

test("a failed preflight and an in-flight one are told apart from a ready one", () => {
  const failed = targetList({ "box-202": { ...READY, machineId: "box-202", status: "failed", detail: "Machine unreachable" } });
  assert.match(failed, /✕ Machine unreachable/);
  assert.doesNotMatch(failed, /credentials ready/);

  const checking = targetList({}, { checking: true });
  assert.match(checking, /Checking…/);
  assert.equal(targetList({}).includes("Checking…"), false, "no status is invented before a run starts");
});

test("only the selected machines are ticked", () => {
  const html = targetList({}, { targets: ["box-202"] });
  assert.match(part(html, "sync-target-box-202", "sync-target-"), /checked/);
  assert.doesNotMatch(part(html, "sync-target-box-39", "sync-target-"), /checked/);
});

// ── step 3 body: content-level diff per selected machine ────────────────────

const APPLIED = {
  providers: { added: [], updated: ["zhipu-coding-plan", "joyai", "bailian-token-plan"], removed: [], unchanged: ["keep-me"] },
  roles: { added: ["review"], updated: ["default"], removed: [], unchanged: ["fast"] },
  enabledModels: { added: ["zai/glm-5", "joyai/x"], removed: ["old/one"], unchanged: [] },
  fallbackChains: { added: [], updated: [], removed: [], unchanged: ["default"] },
};

function summary({ sections, targets = ALL_IDS, preflight = {}, pushResults = {}, excludedOAuthProviders = [] } = {}) {
  return renderElement(React.createElement(SyncDiffSummary, {
    machines: MACHINES,
    targets,
    sections,
    preflight: new Map(Object.entries(preflight)),
    pushResults: new Map(Object.entries(pushResults)),
    excludedOAuthProviders,
  }));
}

test("the summary lists one content row per selected section, with counts and the names that move", () => {
  const html = summary({ sections: ["providers", "roles", "enabledModels"], preflight: { "box-202": { ...READY, machineId: "box-202", applied: APPLIED } } });
  const block = part(html, "sync-diff", 'sync-diff"');
  assert.match(block, /models\.yml/);
  assert.match(block, /0 added · 3 changed · 0 removed/);
  assert.ok(block.includes("zhipu-coding-plan · joyai · bailian-token-plan"));
  assert.match(block, /config\.yml · modelRoles/);
  assert.match(block, /1 added · 1 changed · 0 removed/);
  assert.ok(block.includes("review · default"));
  assert.match(block, /config\.yml · retry\.fallbackChains/);
  assert.match(block, /config\.yml · enabledModels/);
  assert.match(block, /2 added · 0 changed · 1 removed/);
  assert.ok(block.includes("zai/glm-5 · joyai/x · old/one"));
  // Names that do not move are not listed.
  assert.doesNotMatch(block, /keep-me|fast</);
});

test("only the selected sections are described", () => {
  const html = summary({ sections: ["providers"], preflight: { "box-202": { ...READY, machineId: "box-202", applied: APPLIED } } });
  assert.match(html, /models\.yml/);
  assert.doesNotMatch(html, /modelRoles|enabledModels|fallbackChains/);
});

test("a section that would change nothing says so", () => {
  const html = summary({ sections: ["roles"], preflight: { "box-202": { ...READY, machineId: "box-202", changed: false, applied: { ...APPLIED, roles: { added: [], updated: [], removed: [], unchanged: ["default"] } } } } });
  const block = part(html, "sync-diff", 'sync-diff"');
  assert.match(block, /config\.yml · modelRoles/);
  assert.match(block, /config\.yml · retry\.fallbackChains/);
  assert.equal(block.split("no change").length - 1, 2);
});

test("a target that answered no diff shows its verdict alone", () => {
  const html = summary({ sections: ["providers"], preflight: { "box-202": { ...READY, machineId: "box-202" } } });
  const block = part(html, "sync-diff", 'sync-diff"');
  assert.match(block, /✓ credentials ready · changes pending/);
  assert.doesNotMatch(block, /models\.yml/);
  assert.doesNotMatch(block, /No preflight result/);
});

test("findings are listed under the header and counted in it", () => {
  const html = summary({
    sections: ["providers"],
    preflight: { "box-202": { ...READY, machineId: "box-202", applied: APPLIED, issues: [{ kind: "missing_key", provider: "joyai", envVar: "JOYAI_API_KEY" }] } },
  });
  const block = part(html, "sync-diff", 'sync-diff"');
  assert.match(part(block, "sync-diff-status", "sync-diff-status"), /⚠ 1 finding\(s\) need attention/);
  assert.match(block, /⚠ JOYAI_API_KEY missing — it still syncs, but runs degraded/);
});

test("after the push the header reports the push outcome instead of the preflight", () => {
  const preflight = { "box-202": { ...READY, machineId: "box-202" }, "box-39": { ...READY, machineId: "box-39" } };
  const html = summary({
    sections: ["providers"],
    preflight,
    pushResults: { "box-202": { ...READY, machineId: "box-202", status: "applied", detail: "Applied" }, "box-39": { ...READY, machineId: "box-39", status: "failed", detail: "boom" } },
  });
  assert.match(part(html, "sync-diff", 'sync-diff"'), />Applied</);
  const failed = html.slice(html.indexOf('data-machine="box-39"'));
  assert.match(failed, /Failed: boom/);
  assert.doesNotMatch(html, /credentials ready/, "preflight verdicts yield to the real outcome");
});
test("an in-sync push is labeled as already in sync, not skipped", () => {
  const html = summary({
    sections: ["providers"],
    targets: ["box-202"],
    pushResults: { "box-202": { ...READY, machineId: "box-202", status: "in_sync", detail: "Already in sync" } },
  });
  assert.match(html, /Already in sync/);
  assert.doesNotMatch(html, /Skipped/);
});

test("excluded OAuth providers from a run are shown in the step-3 summary", async () => {
  const html = summary({
    sections: ["providers"],
    targets: ["box-202"],
    excludedOAuthProviders: ["openrouter"],
  });
  assert.match(html, /Subscription-login providers excluded in this run: openrouter/);
  const source = await readFile(new URL("./SyncWizard.tsx", import.meta.url), "utf8");
  assert.match(source, /setExcludedOAuthProviders\(data\.excludedOAuthProviders \?\? \[\]\)/);
});

test("only selected machines are summarised, and a machine without any result says so", () => {
  const html = summary({ sections: ["providers"], targets: ["box-39"] });
  assert.doesNotMatch(html, /data-machine="box-202"/);
  assert.match(html, /data-machine="box-39"/);
  assert.match(html, /No preflight result for this machine\./);
});

// ── container flow ──────────────────────────────────────────────────────────

test("the preflight runs by itself on entry to step 2 and the push waits for step 3", async () => {
  const source = await readFile(new URL("./SyncWizard.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(step === 1\) \{\s*setStep\(2\);[\s\S]{0,260}?void run\("preflight"\);/);
  // Step 2 only advances; nothing is pushed before the diff is shown.
  assert.match(source, /if \(step === 2\) \{\s*setStep\(3\);\s*return;\s*\}/);
  assert.match(source, /if \(pushResults\) onClose\(\);\s*else void run\("push"\);/);
  // The preflight covers every machine, the push only the selection.
  assert.match(source, /targets: mode === "preflight" \? machines\.map\(\(machine\) => machine\.id\) : targets/);
});

test("a slow preflight never traps the user: only a push locks the wizard", async () => {
  const source = await readFile(new URL("./SyncWizard.tsx", import.meta.url), "utf8");
  // The gateway visits targets one by one, so step 2 stays usable: Next on
  // steps 1-2 is not gated on a running request, and Back/Close only wait for a push.
  assert.match(source, /const nextDisabled = step === 1 \? sections\.length === 0 : step === 2 \? targets\.length === 0 : running !== null;/);
  assert.match(source, /disabled=\{step === 1 \|\| pushing\}/);
  assert.doesNotMatch(source, /const busy = /);
  // Stepping back or closing abandons the request instead of waiting it out.
  assert.match(source, /const back = \(\) => \{[\s\S]{0,320}?abortRef\.current\?\.abort\(\);/);
  assert.match(source, /useEffect\(\(\) => \(\) => abortRef\.current\?\.abort\(\), \[\]\);/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /if \(!controller\.signal\.aborted\) setError\(/);
});
