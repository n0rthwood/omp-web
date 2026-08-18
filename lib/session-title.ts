import { completeSimple, type Api, type Model } from "@oh-my-pi/pi-ai";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { generateSessionTitle as generateOmpSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionLike } from "./omp-types";

const MAX_TITLE_LENGTH = 120;
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
 * Web-owned title prompt (issue #15). The web-owned online title path appends
 * the marker instruction itself (answer inside <title>...</title>; no-task →
 * <title>none</title>); the SDK local-tiny fallback appends the same marker.
 * Our no-task wording uses <title/> per the agreed protocol, and
 * `isDeclinedTitle` treats a literal "none" as a decline so whichever
 * instruction the model follows converges on the same outcome.
 */
const WEB_TITLE_SYSTEM_PROMPT = [
  "Write a concise 3-10 word title for the task in <user>.",
  "Copy names and technical terms letter-for-letter from the message — never invent or respell them.",
  "When the user's message references GitHub issues, append an issue annotation suffix inside the same <title> tags, after the human title:",
  "- the issue(s) this task is mainly about: bare numbers prefixed with #, joined by \" · \" — e.g. #12 or #12 · #13;",
  "- issues mentioned only as related context: after \"rel \", prefixed with #, comma-joined — e.g. rel #10, #7;",
  "- both kinds may be absent, single, or multiple; never invent issue numbers — only use numbers literally present in the message;",
  "- example result: Fix login redirect (#12 · rel #10, #7).",
  "If there is no task (a bare greeting or small talk), answer <title/>.",
].join("\n");

const WEB_TITLE_HUMAN_ONLY_PROMPT = [
  "Write a concise 3-10 word title for the task in <user>.",
  "Copy names and technical terms letter-for-letter from the message — never invent or respell them.",
  "Keep this human title under 60 characters; issue annotations are appended separately.",
  "Do not include GitHub issue numbers or parenthesized issue annotations.",
  "If there is no task (a bare greeting or small talk), answer <title/>.",
].join("\n");

/** The SDK's appended marker instruction tells the model to answer <title>none</title> for no-task; treat that literal as a decline. */
export function isDeclinedTitle(title: string): boolean {
  return title.toLowerCase() === "none";
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

export function appendIssueAnnotationSuffix(title: string, sourceText: string): string {
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
  return parts.length === 0 ? base : truncateTitle(`${base} (${parts.join(" · ")})`);
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
 */
export async function generateSessionTitle(
  session: AgentSessionLike,
): Promise<GeneratedSessionTitle | null> {
  const context = session.sessionManager.buildSessionContext();
  const firstMessage = findFirstTitleSource(context.messages);
  if (!firstMessage) {
    throw new Error("The session has no user messages to name");
  }

  const title = session.settings.get("providers.tinyModel") === "online"
    ? await generateOnlineWebSessionTitle(session, firstMessage)
    : appendIssueAnnotationSuffix(
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
