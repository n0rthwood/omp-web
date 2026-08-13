import { afterAll, expect, test } from "bun:test";
import {
  isTerminalFeatureAvailable,
  isTerminalFeatureEnabled,
  isTerminalHostGateSatisfied,
} from "./terminal-gate";
import {
  closeTerminal,
  createTerminal,
  getTerminalInfo,
  listTerminals,
  resizeTerminal,
  subscribeTerminal,
  writeToTerminal,
  type TerminalStreamEvent,
} from "./terminal-service";

const CWD = import.meta.dir;
const ENV_KEYS = ["OMP_WEB_TERMINALS", "OMP_WEB_HOSTNAME", "OMP_WEB_PASSWORD"];

type EnvOverrides = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

/** Run `fn` with specific OMP_WEB_* values, restoring the originals after. */
function withEnv(overrides: EnvOverrides, fn: () => void): () => void {
  return () => {
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      const value = overrides[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

/**
 * Poll a real-world condition (pty output / process death). Fake timers
 * cannot work here: the signal comes from a live shell subprocess, so we
 * await the condition itself with a short poll interval and a hard deadline
 * instead of a guessed fixed sleep.
 */
function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    if (condition()) return resolve();
    if (Date.now() > deadline) {
      return reject(new Error(`waitFor: condition not met within ${timeoutMs}ms`));
    }
    setTimeout(tick, 25);
  };
  tick();
  return promise;
}

/** White-box pid access for kill-verification (the registry is internal). */
function pidOfTerminal(id: string): number | undefined {
  const registry = (globalThis as {
    __ompTerminals?: Map<string, { proc: { pid?: number } }>;
  }).__ompTerminals;
  return registry?.get(id)?.proc.pid;
}

afterAll(() => {
  for (const info of listTerminals(CWD)) closeTerminal(info.id);
});

// --- terminal-gate.ts ---

const flagCases: Array<[string | undefined, boolean]> = [
  [undefined, false],
  ["", false],
  ["0", false],
  ["false", false],
  ["off", false],
  ["enable", false], // only exact affirmative words count
  ["1", true],
  ["true", true],
  ["TRUE", true],
  ["Yes", true],
  [" on ", true], // whitespace + case insensitive
];

for (const [value, expected] of flagCases) {
  test(
    `isTerminalFeatureEnabled: OMP_WEB_TERMINALS=${JSON.stringify(value)} -> ${expected}`,
    withEnv({ OMP_WEB_TERMINALS: value }, () => {
      expect(isTerminalFeatureEnabled()).toBe(expected);
    }),
  );
}

const hostCases: Array<[string | undefined, string | undefined, boolean]> = [
  // [OMP_WEB_HOSTNAME, OMP_WEB_PASSWORD, gate satisfied]
  [undefined, undefined, true], // unset defaults to loopback
  ["127.0.0.1", undefined, true],
  ["localhost", undefined, true],
  ["::1", undefined, true],
  ["[::1]", undefined, true],
  ["0.0.0.0", undefined, false],
  ["192.168.1.5", undefined, false],
  ["example.internal", undefined, false],
  ["0.0.0.0", "", false], // empty password does not count
  ["0.0.0.0", "a-long-random-password", true],
];

for (const [hostname, password, expected] of hostCases) {
  test(
    `isTerminalHostGateSatisfied: hostname=${JSON.stringify(hostname)}, password=${JSON.stringify(password)} -> ${expected}`,
    withEnv({ OMP_WEB_HOSTNAME: hostname, OMP_WEB_PASSWORD: password }, () => {
      expect(isTerminalHostGateSatisfied()).toBe(expected);
    }),
  );
}

const availabilityCases: Array<[string | undefined, string | undefined, string | undefined, boolean]> = [
  ["1", "0.0.0.0", undefined, false], // flag on, non-loopback, no password
  ["1", "0.0.0.0", "secret", true],
  ["1", undefined, undefined, true],
  [undefined, "0.0.0.0", "secret", false], // password set but flag off
];

for (const [flag, hostname, password, expected] of availabilityCases) {
  test(
    `isTerminalFeatureAvailable: flag=${JSON.stringify(flag)}, hostname=${JSON.stringify(hostname)}, password=${JSON.stringify(password ? "…" : password)} -> ${expected}`,
    withEnv({ OMP_WEB_TERMINALS: flag, OMP_WEB_HOSTNAME: hostname, OMP_WEB_PASSWORD: password }, () => {
      expect(isTerminalFeatureAvailable()).toBe(expected);
    }),
  );
}

// --- terminal-service.ts (real ptys) ---

test("create -> write -> subscriber observes the echoed marker", async () => {
  const info = createTerminal({ cwd: CWD, name: "service-test" });
  expect(info.cwd).toBe(CWD);
  expect(info.name).toBe("service-test");
  expect(info.exited).toBe(false);

  const events: TerminalStreamEvent[] = [];
  const unsubscribe = subscribeTerminal(info.id, (event) => events.push(event));
  expect(unsubscribe).toBeTypeOf("function");

  expect(writeToTerminal(info.id, "echo TERMINAL_SERVICE_MARKER_7f3a\n")).toBe("ok");
  await waitFor(() =>
    events.some((event) => event.type === "output" && event.data.includes("TERMINAL_SERVICE_MARKER_7f3a"))
  );

  unsubscribe?.();
  closeTerminal(info.id);
}, 20_000);

test("a late subscriber receives the replay buffer exactly once, synchronously", async () => {
  const info = createTerminal({ cwd: CWD });
  const first: TerminalStreamEvent[] = [];
  const unsubscribe = subscribeTerminal(info.id, (event) => first.push(event));
  writeToTerminal(info.id, "echo REPLAY_MARKER_91c2\n");
  await waitFor(() =>
    first.some((event) => event.type === "output" && event.data.includes("REPLAY_MARKER_91c2"))
  );

  const replayed: TerminalStreamEvent[] = [];
  subscribeTerminal(info.id, (event) => replayed.push(event));
  // The buffer is delivered synchronously on subscribe — no waiting, and
  // exactly one output frame carries the marker (no double replay).
  expect(replayed.some((event) => event.type === "output" && event.data.includes("REPLAY_MARKER_91c2"))).toBe(true);
  expect(replayed.filter((event) => event.type === "output").length).toBe(1);

  unsubscribe?.();
  closeTerminal(info.id);
}, 20_000);

test("resize reports ok and does not throw", () => {
  const info = createTerminal({ cwd: CWD });
  expect(resizeTerminal(info.id, 120, 40)).toBe("ok");
  expect(resizeTerminal(info.id, 80, 24)).toBe("ok");
  closeTerminal(info.id);
}, 20_000);

test("shell exit propagates an exit event and blocks further writes", async () => {
  const info = createTerminal({ cwd: CWD });
  const events: TerminalStreamEvent[] = [];
  const unsubscribe = subscribeTerminal(info.id, (event) => events.push(event));

  writeToTerminal(info.id, "exit\n");
  await waitFor(() => events.some((event) => event.type === "exit"));

  expect(getTerminalInfo(info.id)?.exited).toBe(true);
  expect(writeToTerminal(info.id, "x")).toBe("exited");

  unsubscribe?.();
  closeTerminal(info.id);
}, 20_000);

test("close kills the whole process group, removes the record, and is idempotent", async () => {
  const info = createTerminal({ cwd: CWD });
  const pid = pidOfTerminal(info.id);
  expect(typeof pid).toBe("number");
  expect(pid!).toBeGreaterThan(0);

  closeTerminal(info.id);

  // Both the shell pid and its process group (negative pid) must be gone.
  await waitFor(() => {
    try {
      process.kill(pid!, 0);
      return false;
    } catch {
      /* ESRCH expected once reaped */
    }
    try {
      process.kill(-pid!, 0);
      return false;
    } catch {
      return true;
    }
  }, 5_000);

  expect(listTerminals(CWD).some((t) => t.id === info.id)).toBe(false);

  // A second close on the already-closed id must be a no-op, not an error.
  closeTerminal(info.id);
  expect(true).toBe(true);
}, 20_000);

test("listTerminals omits and reaps exited terminals", async () => {
  const info = createTerminal({ cwd: CWD, name: "prune-test" });
  expect(listTerminals(CWD).some((t) => t.id === info.id)).toBe(true);

  const events: TerminalStreamEvent[] = [];
  const unsubscribe = subscribeTerminal(info.id, (event) => events.push(event));
  writeToTerminal(info.id, "exit\n");
  await waitFor(() => events.some((event) => event.type === "exit"));
  unsubscribe?.();

  // The exited record must not be listed, and listing reaps it from the
  // registry so it cannot grow unbounded.
  expect(listTerminals(CWD).some((t) => t.id === info.id)).toBe(false);
  expect(getTerminalInfo(info.id)).toBeUndefined();
}, 20_000);
