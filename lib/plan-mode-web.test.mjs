import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyWebPlanModeTransition,
  planModeInfoFromEntries,
  planSlashCommandIntent,
  readPersistedPlanModeState,
  webPlanModeInfo,
  WEB_DEFAULT_PLAN_FILE_URL,
} from "./plan-mode-web.ts";

/** Minimal recording stand-in for the SDK session slice these helpers touch. */
function makeSession(options) {
  const settingsPlanEnabled = options?.settingsPlanEnabled ?? true;
  const session = {
    state: options?.state,
    handler: null,
    modeChanges: [],
    getPlanModeState() {
      return session.state;
    },
    setPlanModeState(next) {
      session.state = next;
    },
    setPlanProposalHandler(handler) {
      session.handler = handler;
    },
    sessionManager: {
      appendModeChange(mode, data) {
        session.modeChanges.push({ mode, data });
        return "entry";
      },
      getEntries() {
        return options?.entries ?? [];
      },
    },
    settings: {
      get(path) {
        assert.equal(path, "plan.enabled");
        return settingsPlanEnabled;
      },
    },
  };
  return session;
}

const proposalHandler = async () => ({ content: [] });

test("enter: sets ACP-shaped state, installs proposal handler, persists mode_change", () => {
  const session = makeSession();
  const info = applyWebPlanModeTransition(session, true, proposalHandler);

  assert.deepEqual(info, { enabled: true, planFilePath: WEB_DEFAULT_PLAN_FILE_URL, available: true });
  assert.deepEqual(
    session.state,
    { enabled: true, planFilePath: WEB_DEFAULT_PLAN_FILE_URL, workflow: "parallel", reentry: false },
  );
  assert.equal(session.handler, proposalHandler);
  assert.deepEqual(
    session.modeChanges,
    [{ mode: "plan", data: { planFilePath: WEB_DEFAULT_PLAN_FILE_URL } }],
  );
});

test("enter twice: reuses the previous plan file and marks reentry (ACP semantics)", () => {
  const session = makeSession({
    state: { enabled: true, planFilePath: "local://custom-plan.md", workflow: "parallel", reentry: false },
  });
  const info = applyWebPlanModeTransition(session, true, proposalHandler);

  assert.equal(info.planFilePath, "local://custom-plan.md");
  assert.equal(session.state?.reentry, true);
  assert.equal(session.state?.planFilePath, "local://custom-plan.md");
});

test("exit: clears state and handler, persists mode_change none", () => {
  const session = makeSession({
    state: { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel", reentry: true },
  });
  const info = applyWebPlanModeTransition(session, false, proposalHandler);

  assert.deepEqual(info, { enabled: false, available: true });
  assert.equal(session.state, undefined);
  assert.equal(session.handler, null);
  assert.deepEqual(session.modeChanges, [{ mode: "none", data: undefined }]);
});

test("exit when already off: no redundant journal entry", () => {
  const session = makeSession();
  const info = applyWebPlanModeTransition(session, false, proposalHandler);

  assert.deepEqual(info, { enabled: false, available: true });
  assert.deepEqual(session.modeChanges, []);
});

test("enter with plan.enabled=false refuses instead of half-entering", () => {
  const session = makeSession({ settingsPlanEnabled: false });
  assert.throws(
    () => applyWebPlanModeTransition(session, true, proposalHandler),
    /Plan mode is disabled/,
  );
  assert.equal(session.state, undefined);
  assert.equal(session.handler, null);
  assert.deepEqual(session.modeChanges, []);
  // Leaving plan mode stays possible even when the setting is off.
  assert.deepEqual(applyWebPlanModeTransition(session, false, proposalHandler), { enabled: false, available: false });
});

test("webPlanModeInfo reflects live state and the availability gate", () => {
  assert.deepEqual(webPlanModeInfo(makeSession()), { enabled: false, available: true });
  assert.deepEqual(
    webPlanModeInfo(makeSession({ state: { enabled: true, planFilePath: "local://PLAN.md" } })),
    { enabled: true, planFilePath: "local://PLAN.md", available: true },
  );
  assert.deepEqual(webPlanModeInfo(makeSession({ settingsPlanEnabled: false })), { enabled: false, available: false });
});

test("TUI↔Web restore: last mode_change journal entry decides the restored mode", () => {
  // A session planned in the TUI (journal ends with mode "plan") restores enabled.
  assert.deepEqual(
    readPersistedPlanModeState([
      { type: "user" },
      { type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
      { type: "assistant" },
    ]),
    { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel", reentry: true },
  );

  // Web-exited sessions (journal ends with "none") restore disabled…
  assert.equal(
    readPersistedPlanModeState([
      { type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
      { type: "mode_change", mode: "none" },
    ]),
    undefined,
  );
  // …and approval exits the same way, so an approved session never reopens as plan mode.
  assert.equal(
    readPersistedPlanModeState([
      { type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
      { type: "mode_change", mode: "none" },
      { type: "assistant" },
    ]),
    undefined,
  );

  // A "plan" entry without a plan file path cannot steer proposals — ignored.
  assert.equal(
    readPersistedPlanModeState([{ type: "mode_change", mode: "plan", data: {} }]),
    undefined,
  );

  // No mode_change at all: normal execution session.
  assert.equal(readPersistedPlanModeState([{ type: "user" }]), undefined);
  assert.deepEqual(
    planModeInfoFromEntries([{ type: "mode_change", mode: "plan", data: { planFilePath: "local://PLAN.md" } }]),
    { enabled: true, planFilePath: "local://PLAN.md", available: true },
  );
});

test("/plan intent: toggle semantics, never a plain prompt handoff", () => {
  // Off → enter; trailing text becomes the first planning prompt (TUI semantics).
  assert.deepEqual(planSlashCommandIntent("/plan", false), { enabled: true });
  assert.deepEqual(planSlashCommandIntent("/plan draft the migration", false), {
    enabled: true,
    prompt: "draft the migration",
  });

  // On → exit; args are dropped exactly like the TUI treats them.
  assert.deepEqual(planSlashCommandIntent("/plan", true), { enabled: false });
  assert.deepEqual(planSlashCommandIntent("/plan more words", true), { enabled: false });

  // Other commands and plain text stay untouched for normal handling.
  assert.equal(planSlashCommandIntent("/compact", false), null);
  assert.equal(planSlashCommandIntent("/planning ahead", false), null);
  assert.equal(planSlashCommandIntent("hello /plan", false), null);
  assert.equal(planSlashCommandIntent("", false), null);
});

test("round trip: enter then exit leaves a journal that restores to disabled", () => {
  const session = makeSession();
  applyWebPlanModeTransition(session, true, proposalHandler);
  applyWebPlanModeTransition(session, false, proposalHandler);

  const journal = session.modeChanges.map((change) => ({ type: "mode_change", ...change }));
  assert.equal(readPersistedPlanModeState(journal), undefined);
  assert.deepEqual(planModeInfoFromEntries(journal), { enabled: false, available: true });
});

test("round trip: wrapper restart mid-plan restores the entered mode", () => {
  const first = makeSession();
  applyWebPlanModeTransition(first, true, proposalHandler);

  // Simulate a fresh wrapper for the same session file: no live SDK state,
  // journal carries the mode_change the first wrapper persisted.
  const journal = first.modeChanges.map((change) => ({ type: "mode_change", ...change }));
  const restored = readPersistedPlanModeState(journal);
  const second = makeSession({ entries: journal });
  if (restored) second.setPlanModeState(restored);

  assert.deepEqual(
    webPlanModeInfo(second),
    { enabled: true, planFilePath: WEB_DEFAULT_PLAN_FILE_URL, available: true },
  );

  // Exiting from the restored state still persists the "none" entry.
  applyWebPlanModeTransition(second, false, proposalHandler);
  assert.deepEqual(second.modeChanges, [{ mode: "none", data: undefined }]);
});
