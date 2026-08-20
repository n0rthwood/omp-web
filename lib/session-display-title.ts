import { skillExpansionToCommand } from "./slash-display";
import type { SessionInfo } from "./types";

/**
 * Fallback display title shared by every sidebar surface (table/drawer
 * rows, the auto-collapse strip's chips): the stored name, else the first
 * message — with any skill-invocation XML collapsed back to the compact
 * `/skill:name args` command the user typed, mirroring MessageView's
 * rendering — else the session id, truncated to 50 characters.
 */
export function sessionDisplayTitle(session: Pick<SessionInfo, "name" | "firstMessage" | "id">): string {
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  return session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);
}
