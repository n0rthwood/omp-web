import { completeSimple, type Api, type Model } from "@oh-my-pi/pi-ai";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { generateSessionTitle as generateOmpSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { isLowSignalTitleInput } from "@oh-my-pi/pi-coding-agent/tiny/text";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionLike } from "./omp-types";

const MAX_TITLE_LENGTH = 150;
const TITLE_MARKER_INSTRUCTION =
  "Output only the title wrapped in `<title>` and `</title>` tags, with nothing before or after. When the message carries no concrete task yet (a bare greeting, acknowledgement, or small talk), output exactly `<title>none</title>`.";
const TITLE_MAX_TOKENS = 1024;
const MAX_TITLE_SOURCE_CHARS = 2000;
const LOW_SIGNAL_TITLE_INPUT_RE = /^(?:hi|hello|hey|yo|thanks?|thank you|ok|okay|k|sure|yes|no|你好|您好|嗨|谢谢|好的|嗯)[\s.!?。！？…-]*$/i;

type TitleModelRegistry = AgentSessionLike["modelRegistry"] & {
  getApiKey?: (model: Model<Api>, sessionId?: string) => Promise<unknown>;
  resolver?: (model: Model<Api>, sessionId?: string) => unknown;
};

export interface GeneratedSessionTitle {
  title: string;
}

/**
 * Web-owned title prompt (issue #15). The web-owned online title path writes
 * a Simplified Chinese title and prepends the issue annotation itself; the
 * SDK local-tiny fallback writes only the human title and the same marker,
 * and the web layer deterministically prepends the issue annotation via
 * {@link prependIssueAnnotationPrefix}. Our no-task wording uses <title/>
 * per the agreed protocol, and `isDeclinedTitle` treats a literal "none" as
 * a decline so whichever instruction the model follows converges on the
 * same outcome.
 */
const WEB_TITLE_SYSTEM_PROMPT = [
  "用简体中文写一句概括任务目标的标题,长度控制在约100个汉字以内,能短则短。",
  "标题要点明任务要达成的目标或结果,不要照抄或轻微改写用户原话。",
  "人名、产品名、代码标识符等专有名词和技术术语必须逐字保留原文,不要翻译或改写。",
  "若用户消息中提到了 GitHub issue 编号,把编号标注放在标题最前面,格式为 \"(#12 · rel #10, #7) 标题正文\":",
  "- 与本次任务主要相关的 issue:纯数字加 #,多个用 \" · \" 连接,例如 #12 或 #12 · #13;",
  "- 仅作为背景提及的 issue:跟在 \"rel \" 之后,用 \"#\" 前缀、逗号分隔,例如 rel #10, #7;",
  "- 两类可以都没有、只有一类,或两类都有;严禁编造 issue 编号,只能使用消息中真实出现的数字;",
  "- 示例:(#12 · rel #10, #7) 修复登录跳转问题。",
  "如果没有具体任务(只是打招呼或闲聊),回答 <title/>。",
].join("\n");

const WEB_TITLE_HUMAN_ONLY_PROMPT = [
  "用简体中文写一句概括任务目标的标题,长度控制在约100个汉字以内,能短则短。",
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

function isLowSignalWebTitleInput(message: string): boolean {
  return LOW_SIGNAL_TITLE_INPUT_RE.test(message.trim());
}

function formatWebTitleUserMessage(message: string): string {
  const trimmed = message.trim();
  const bounded = trimmed.length <= MAX_TITLE_SOURCE_CHARS
    ? trimmed
    : `${trimmed.slice(0, 1400)}\n[… ${trimmed.length - MAX_TITLE_SOURCE_CHARS} chars omitted …]\n${trimmed.slice(-600)}`;
  return `<user>\n${bounded}\n</user>`;
}

function unwrapJsonTitle(candidate: string): string {
  const text = candidate
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  if (!text.startsWith("{")) return candidate;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") {
      return parsed.title.trim();
    }
  } catch {
    const quoted = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (quoted) {
      const salvaged: unknown = JSON.parse(quoted[1]);
      if (typeof salvaged === "string") return salvaged.trim();
    }
  }
  return candidate;
}

function extractGeneratedTitleText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

export function normalizeWebGeneratedTitle(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const marker = /<title>([\s\S]*?)<\/title>|<title\s*\/>/i.exec(text);
  const raw = marker ? (marker[1] ?? "") : (text.split(/\r?\n/, 1)[0] ?? "");
  const cleaned = truncateTitle(
    unwrapJsonTitle(raw)
      .replace(/^["']|["']$/g, "")
      .replace(/^<title>/i, "")
      .replace(/<\/title>$/i, "")
      .replace(/[.!?]$/, "")
      .trim(),
  );
  if (!cleaned || isDeclinedTitle(cleaned) || !/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return cleaned;
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

function resolveWebTitleModel(session: AgentSessionLike): Model<Api> | undefined {
  const availableModels = session.modelRegistry.getAvailable() as Model<Api>[];
  if (availableModels.length === 0) return undefined;
  return resolveRoleSelection(["tiny", "commit", "smol"], session.settings, availableModels)?.model
    ?? session.model as Model<Api> | undefined;
}

async function generateOnlineWebSessionTitle(session: AgentSessionLike, firstMessage: string): Promise<string | null> {
  if (isLowSignalWebTitleInput(firstMessage)) return null;
  const model = resolveWebTitleModel(session);
  const registry = session.modelRegistry as TitleModelRegistry;
  if (!model || !registry.getApiKey || !registry.resolver) return null;

  try {
    const apiKey = await registry.getApiKey(model, session.sessionId);
    if (!apiKey) return null;
    const response = await completeSimple(
      model,
      {
        systemPrompt: [WEB_TITLE_SYSTEM_PROMPT, TITLE_MARKER_INSTRUCTION],
        messages: [{ role: "user", content: formatWebTitleUserMessage(firstMessage), timestamp: Date.now() }],
      },
      {
        apiKey: registry.resolver(model, session.sessionId) as never,
        maxTokens: TITLE_MAX_TOKENS,
        disableReasoning: true,
        temperature: 0,
      },
    );
    if (response.stopReason === "error") return null;
    return normalizeWebGeneratedTitle(extractGeneratedTitleText(response.content));
  } catch {
    return null;
  }
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

  const title = session.settings.get("providers.tinyModel") === "online"
    ? await generateOnlineWebSessionTitle(session, firstMessage)
    : prependIssueAnnotationPrefix(
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
