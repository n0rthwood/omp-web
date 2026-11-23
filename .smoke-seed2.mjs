// Throwaway #121 smoke fixture: seeds one journal into a hermetic agent dir.
// Run FROM the worktree WITHOUT overriding HOME (SDK resolves via real HOME):
//   bun /tmp/omp121/seed.mjs
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const home = "/tmp/omp125/home";
setAgentDir(join(home, ".omp", "agent"));
const cwd = join(home, "proj-125");
mkdirSync(cwd, { recursive: true });

const zeroUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sm = SessionManager.create(cwd);
const now = Date.now();
let seq = 0;
const ts = () => now - (100 - seq++) * 60000;

const user = (text) => sm.appendMessage({ role: "user", content: text, timestamp: ts() });
const assistantText = (text) => sm.appendMessage({
  role: "assistant", api: "openai-completions", provider: "synthetic", model: "synthetic-model",
  content: [{ type: "text", text }], usage: zeroUsage, stopReason: "stop", timestamp: ts(),
});
// tool-only assistant: 2 toolCalls in one message
const assistantTools = (names) => sm.appendMessage({
  role: "assistant", api: "openai-completions", provider: "synthetic", model: "synthetic-model",
  content: names.map((name, i) => ({ type: "toolCall", id: `tc${seq}-${i}`, name, arguments: {} })),
  usage: zeroUsage, stopReason: "toolUse", timestamp: ts(),
});
const toolResult = (name, i) => sm.appendMessage({
  role: "toolResult", toolCallId: `tc${seq - 1}-${i}`, toolName: name,
  content: [{ type: "text", text: `${name} output` }], isError: false, timestamp: ts(),
});

user("U1: 帮我查一下这个 bug");
assistantText("我先看看代码。");
assistantTools(["read", "grep"]);
toolResult("read", 0); toolResult("grep", 1);
assistantTools(["bash"]);
toolResult("bash", 0);
assistantTools(["read"]);
toolResult("read", 0);
assistantText("找到原因了，是缓存失效的问题。");
user("U2: 派个子 agent 去修");
sm.appendCustomMessageEntry("async-result",
  `<system-notice>\nBackground job FixCacheRace has completed. Resume your work using the result below.\n<task-result id="FixCacheRace" agent="task" status="completed" duration="6m16s">\n<output>\n{"summary":"fixed the cache race"}\n</output>\n</task-result>`,
  true, { jobs: [{ jobId: "FixCacheRace", type: "task", status: "completed", agentId: "FixCacheRace", label: "FixCacheRace", durationMs: 376000 }] }, undefined, ts());
assistantText("子 agent 已经修好了，我验证一下。");
assistantTools(["bash", "read"]);
toolResult("bash", 0); toolResult("read", 1);
assistantText("验证通过，修复完成。");
sm.flushSync();

const id = sm.getSessionId();
const file = sm.getSessionFile();
console.log(JSON.stringify({ id, file, cwd }));

// Discover the encoded session dir by locating the flushed file.
const sessionsRoot = join(home, ".omp", "agent", "sessions");
const dirs = readdirSync(sessionsRoot);
console.log("encoded dirs:", JSON.stringify(dirs));
