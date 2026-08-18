import { generateSessionTitle as generateOmpSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionLike } from "./omp-types";

const MAX_TITLE_LENGTH = 120;

export interface GeneratedSessionTitle {
  title: string;
}

/**
 * Web-owned title prompt (issue #15). The SDK appends its own marker
 * instruction after this (answer inside <title>...</title>; no-task →
 * <title>none</title>) — our no-task wording uses <title/> per the agreed
 * protocol, and `isDeclinedTitle` treats a literal "none" as a decline so
 * whichever instruction the model follows converges on the same outcome.
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

  const title = await generateOmpSessionTitle(
    firstMessage,
    session.modelRegistry as never,
    session.settings,
    session.sessionId,
    session.model as never,
    undefined,
    WEB_TITLE_SYSTEM_PROMPT,
  );
  if (!title) return null;

  const cleaned = truncateTitle(title);
  if (isDeclinedTitle(cleaned)) return null;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) {
    throw new Error("The model did not return a usable session title");
  }
  return { title: cleaned };
}
