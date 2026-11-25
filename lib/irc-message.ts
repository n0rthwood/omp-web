// #143: structured rendering of `irc:incoming` custom messages.
//
// The SDK renders an incoming agent IRC message into the custom_message content
// with a literal `<irc>…</irc>` envelope (pi-coding-agent/src/prompts/system/
// irc-incoming.md). The transcript must not show that envelope: the header
// carries the source label + sender, the body is the agent's markdown.
//
// Browser-safe and builtin-free.

/** Parsed `<irc>` envelope of an `irc:incoming` custom message. */
export interface IrcEnvelope {
  /** Sender agent id; empty when the header line is missing. */
  from: string;
  /** Target of an explicit reply, when the header carries one. */
  replyTo?: string;
  /** Message body without the envelope and the header line. */
  body: string;
}

const ENVELOPE_OPEN = /<irc(?:\s[^>]*)?>/i;
const ENVELOPE_CLOSE = /<\/irc\s*>/gi;
const ENVELOPE_TAG = /<\/?irc(?:\s[^>]*)?>/gi;
const HEADER_LINE = /^\s*Incoming IRC message from agent\s+`([^`]+)`(?:\s*\(reply to\s+([^)]+)\))?\s*:?\s*/i;

/** Strip every `<irc>`/`</irc>` tag, including nested or unbalanced ones. */
export function stripIrcEnvelope(text: string): string {
  return text.replace(ENVELOPE_TAG, "");
}

/**
 * Parse an `irc:incoming` message body.
 *
 * Returns null when the text carries no `<irc>` envelope at all — the caller
 * then renders it as an ordinary custom message instead of an IRC card.
 * Malformed input (missing close tag, nested opens, missing header line) still
 * yields a body with the envelope stripped rather than leaking `<irc>`.
 */
export function parseIrcEnvelope(text: string): IrcEnvelope | null {
  if (typeof text !== "string") return null;
  const open = ENVELOPE_OPEN.exec(text);
  if (!open) return null;

  let body = text.slice(open.index + open[0].length);
  // The outer envelope closes last: a nested/unbalanced `</irc>` inside the
  // body must not truncate it.
  const closes = [...body.matchAll(ENVELOPE_CLOSE)];
  const close = closes.pop();
  if (close) body = body.slice(0, close.index);
  body = stripIrcEnvelope(body);

  const header = HEADER_LINE.exec(body);
  if (!header) return { from: "", body: body.trim() };
  return {
    from: header[1].trim(),
    ...(header[2] ? { replyTo: header[2].trim() } : {}),
    body: body.slice(header[0].length).trim(),
  };
}