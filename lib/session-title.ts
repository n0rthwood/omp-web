import { generateSessionTitle as generateOmpSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { isLowSignalTitleInput } from "@oh-my-pi/pi-coding-agent/tiny/text";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionLike } from "./omp-types";

const MAX_TITLE_LENGTH = 150;

export interface GeneratedSessionTitle {
  title: string;
}

const WEB_TITLE_HUMAN_ONLY_PROMPT = [
  "用简体中文写一句概括任务目标的标题,长度控制在约40个汉字以内(硬上限 80 个字符、12 个词),能短则短。",
  "标题要点明任务要达成的目标或结果,不要照抄或轻微改写用户原话。",
  "人名、产品名、代码标识符等专有名词和技术术语必须逐字保留原文,不要翻译或改写。",
  "不要在标题里加入 GitHub issue 编号或圆括号标注,这部分由系统另行添加。",
  "如果没有具体任务(只是打招呼或闲聊),回答 <title/>。",
].join("\n");

/** The SDK's appended marker instruction tells the model to answer <title>none</title> for no-task; treat that literal as a decline. */
export function isDeclinedTitle(title: string): boolean {
  return title.toLowerCase() === "none";
}

/**
 * Registered extension slash-command names visible to a session (e.g. from
 * `AgentSessionLike.extensionRunner.getRegisteredCommands()`), kept as a
 * plain set so {@link shouldAutoGenerateTitle} stays pure and unit-testable
 * without an `AgentSessionLike` fixture.
 */
export interface AutoTitleGateInput {
  /** The literal text of the first real user submission. */
  message: string;
  /**
   * True once the session already carries a name, from either "user" or
   * "auto" source. The SDK gate skips re-titling on this alone
   * (agent-session.ts:6370); the web auto path mirrors it — only an unnamed
   * session is eligible. The manual "Generate title" button bypasses this
   * gate entirely to force-regenerate.
   */
  hasSessionName: boolean;
  /**
   * `$env.PI_NO_TITLE` in the SDK gate; omp-web runs AgentSessions
   * in-process, so `process.env.PI_NO_TITLE` is the same value.
   */
  piNoTitle: string | undefined;
  /** Extension-registered slash-command names visible to the session. */
  extensionCommandNames: ReadonlySet<string>;
}

/**
 * Mirrors the SDK's local-extension-command check
 * (agent-session.ts:6364-6369): a `/name` or `/name arg…` submission whose
 * `name` resolves to a registered extension command is a command
 * invocation, not a task description, and must never drive a title.
 */
function isLocalExtensionCommand(message: string, commandNames: ReadonlySet<string>): boolean {
  if (!message.startsWith("/")) return false;
  const space = message.indexOf(" ");
  const name = space === -1 ? message.slice(1) : message.slice(1, space);
  return name.length > 0 && commandNames.has(name);
}

/**
 * Whether a browser session's first real user message should trigger
 * automatic title generation (issue #20). Mirrors
 * `AgentSession.maybeStartTitleGeneration`'s skip gates
 * (agent-session.ts:6363-6372) so the web trigger matches CLI/TUI: skip a
 * local extension command, a session that already has a name, `PI_NO_TITLE`,
 * and low-signal openers (greetings, acks, bare numbers — the SDK's own
 * {@link isLowSignalTitleInput}).
 *
 * Pure and side-effect free. A passing gate only means "eligible to
 * generate" — the caller still must not force-overwrite: re-check
 * `hasSessionName` after generation completes, since a concurrent manual
 * click (or a second call racing this one) may have named the session while
 * generation was in flight.
 */
export function shouldAutoGenerateTitle(input: AutoTitleGateInput): boolean {
  if (input.hasSessionName) return false;
  if (input.piNoTitle) return false;
  if (isLocalExtensionCommand(input.message, input.extensionCommandNames)) return false;
  if (isLowSignalTitleInput(input.message)) return false;
  return true;
}

/** Plain text of a session message, ignoring images and tool blocks. */
function messageText(message: AgentMessage): string {
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** First user turn on the session's current branch. */
export function findFirstUserMessage(messages: readonly AgentMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return undefined;
}

/**
 * Text to base a session title on: the first user turn, or — after a full
 * compaction replaced the history — the compaction summary (upstream #381).
 */
export function findFirstTitleSource(messages: readonly AgentMessage[]): string | undefined {
  const userText = findFirstUserMessage(messages);
  if (userText) return userText;
  const summary = (messages as ReadonlyArray<{ role?: string; summary?: unknown }>)
    .find((m) => m.role === "compactionSummary" && typeof m.summary === "string")
    ?.summary as string | undefined;
  return summary?.trim() ? summary : undefined;
}

/** Deterministically prepends a "(#12 · rel #10, #7)" issue annotation block, extracted from `sourceText`, to the front of `title`. */
export function prependIssueAnnotationPrefix(title: string, sourceText: string): string {
  const base = truncateTitle(title);
  if (!base) return "";
  const related = new Set<string>();
  const relatedPattern = /\b(?:rel|related)\b(?:\s+[\p{L}\p{N}_-]+){0,3}?\s*#(\d+)/giu;
  let relatedMatch: RegExpExecArray | null = relatedPattern.exec(sourceText);
  while (relatedMatch) {
    related.add(relatedMatch[1]);
    relatedMatch = relatedPattern.exec(sourceText);
  }

  const seen = new Set<string>();
  const main: string[] = [];
  const relatedOrdered: string[] = [];
  const issuePattern = /#(\d+)/g;
  let issueMatch: RegExpExecArray | null = issuePattern.exec(sourceText);
  while (issueMatch) {
    const issue = issueMatch[1];
    if (seen.has(issue)) {
      issueMatch = issuePattern.exec(sourceText);
      continue;
    }
    seen.add(issue);
    if (related.has(issue)) relatedOrdered.push(issue);
    else main.push(issue);
    issueMatch = issuePattern.exec(sourceText);
  }

  const parts: string[] = [];
  if (main.length > 0) parts.push(main.map((issue) => `#${issue}`).join(" · "));
  if (relatedOrdered.length > 0) parts.push(`rel ${relatedOrdered.map((issue) => `#${issue}`).join(", ")}`);
  return parts.length === 0 ? base : truncateTitle(`(${parts.join(" · ")}) ${base}`);
}

/** Deterministic last-resort title from the user's own words: first non-empty
 *  line of the prompt, whitespace-collapsed, capped at 60 characters, issue
 *  annotation prepended. Empty string when the source has no letters/numbers. */
export function fallbackTitle(sourceText: string): string {
  const line = sourceText.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const collapsed = line.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(collapsed)) return "";
  const chars = Array.from(collapsed);
  const capped = chars.length > 60 ? chars.slice(0, 60).join("").trimEnd() + "…" : collapsed;
  return prependIssueAnnotationPrefix(capped, sourceText);
}

export function truncateTitle(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(trimmed);
  return characters.length > MAX_TITLE_LENGTH
    ? characters.slice(0, MAX_TITLE_LENGTH).join("").trim()
    : trimmed;
}

/**
 * Name a session using omp's own title generator.
 *
 * omp titles sessions with the `tiny` → `commit` → `smol` role chain (or the
 * configured local tiny model), so a title generated from the browser costs the
 * same as one generated in the TUI and never burns the session's primary model.
 * Returns `null` when omp declines to title — greetings and other low-signal
 * first messages are deliberately left unnamed until the next real turn.
 *
 * @param overrideMessage - The exact text to title from, bypassing the
 *   session-history lookup below. The auto-title trigger (issue #20) passes
 *   the literal message that just made {@link shouldAutoGenerateTitle} pass —
 *   mirroring the SDK, which titles from the current submission, not a
 *   history-derived "first" turn. Without it (the manual "Generate title"
 *   button's usage), the title always sources from the session's actual
 *   first user turn, even if an earlier low-signal opener left it unnamed.
 */
export async function generateSessionTitle(
  session: AgentSessionLike,
  overrideMessage?: string,
): Promise<GeneratedSessionTitle | null> {
  const firstMessage = overrideMessage
    ?? findFirstTitleSource(session.sessionManager.buildSessionContext().messages);
  if (!firstMessage) {
    throw new Error("The session has no user messages to name");
  }

  // omp's generator owns model choice (tiny → commit → smol, retry fallbacks,
  // local-tiny worker), transient retries and title normalization. omp-web only
  // supplies the human-only prompt and prepends the issue annotation itself.
  const title = prependIssueAnnotationPrefix(
    await generateOmpSessionTitle(
      firstMessage,
      session.modelRegistry as never,
      session.settings,
      session.sessionId,
      session.model as never,
      undefined,
      WEB_TITLE_HUMAN_ONLY_PROMPT,
    ) ?? "",
    firstMessage,
  );
  if (!title) return null;

  const cleaned = truncateTitle(title);
  if (isDeclinedTitle(cleaned)) return null;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    throw new Error("The model did not return a usable session title");
  }
  return { title: cleaned };
}
