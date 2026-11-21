import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ManagedPromptProfile } from "./prompt-store";

interface InstructionMessage { role?: string; customType?: string; content?: unknown }

function supplement(text: string, kind: string): string {
  return `\n\n<omp-web-instructions source="${kind}">\n${text}\n</omp-web-instructions>`;
}

/** A context-hook copy only: preserves the SDK journal, roles and non-text blocks. */
export function supplementPromptMessages<T extends InstructionMessage>(messages: readonly T[], profile: ManagedPromptProfile): T[] {
  return messages.map((message) => {
    if (message.role !== "custom") return message;
    const key = message.customType === "plan-mode-context" ? "planningGuidance"
      : message.customType === "plan-mode-reference" ? "afterPlanApproval" : null;
    const text = key && profile.values[key];
    if (!text) return message;
    const addition = supplement(text, key);
    const content = typeof message.content === "string" ? message.content + addition
      : Array.isArray(message.content) ? [...message.content, { type: "text", text: addition.trimStart() }] : message.content;
    return { ...message, content };
  });
}

/** The approval tool result is the immediate same-turn execution boundary. */
export function afterPlanApprovalText(original: string, profile: ManagedPromptProfile | null): string {
  const addition = profile?.values.afterPlanApproval;
  return addition ? original + supplement(addition, "afterPlanApproval") : original;
}

export function createPromptExtension(profile: ManagedPromptProfile): ExtensionFactory {
  return (api) => {
    if (profile.values.append) {
      api.on("before_agent_start", (event, ctx) => {
        if (ctx.agent.kind !== "main") return;
        return { systemPrompt: [...event.systemPrompt, supplement(profile.values.append!, "append").trimStart()] };
      });
    }
    if (profile.values.planningGuidance || profile.values.afterPlanApproval) {
      api.on("context", (event, ctx) => {
        if (ctx.agent.kind !== "main") return;
        return { messages: supplementPromptMessages(event.messages, profile) };
      });
    }
  };
}

/** SDK 18.10.4's restricted parent path binds only prepared factories. Keep this seam isolated. */
export function promptSessionOptions(profile: ManagedPromptProfile | null, restricted: boolean): Partial<CreateAgentSessionOptions> {
  if (!profile) return {};
  const factory = createPromptExtension(profile);
  const registration: Partial<CreateAgentSessionOptions> = restricted
    ? { preloadedPreparedExtensions: [{ path: "omp-web:managed-prompts", resolvedPath: "omp-web:managed-prompts", factory, error: null }] }
    : { extensions: [factory] };
  return { ...registration, ...(profile.values.baseTemplate !== undefined ? { systemPromptTemplate: profile.values.baseTemplate } : {}) };
}
