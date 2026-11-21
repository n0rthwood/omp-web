// #116: classify omp system injections (developer-role messages and
// custom_message entries) into a named source, plus the omp setting — if any —
// that turns that source off.
//
// Browser-safe and builtin-free: the transcript card, the outline builder and
// the injection settings panel all import this module.
//
// custom_message entries carry an exact `customType`. developer messages carry
// only text, so they are matched by the opening of the SDK template that
// produced them (`node_modules/@oh-my-pi/pi-coding-agent/src/prompts/system/`).
// `lib/injection-sources.test.mjs` asserts every signature below still matches
// its template, so an SDK bump that rewords a template fails CI instead of
// silently degrading the label to "Unknown injection".

/** When a disable write takes effect. */
export type InjectionEffect = "next-turn" | "new-session";

/** The omp setting that turns a source off. */
export type InjectionSetting =
  | { kind: "value"; path: string; offValue: boolean | string }
  /** `ttsr.disabledRules`: the source's rule name is appended to the list. */
  | { kind: "append-rule"; path: "ttsr.disabledRules" };

export interface InjectionSourceDef {
  id: string;
  /** English label; the UI translates via `injection.source.<id>`. */
  label: string;
  setting?: InjectionSetting;
  effect: InjectionEffect;
}

export interface InjectionClassification {
  sourceId: string;
  /** English label, with the rule name appended for rule violations. */
  label: string;
  setting?: InjectionSetting;
  effect: InjectionEffect;
  /** Rule violations only: the TTSR rule name from `rule="…"`. */
  rule?: string;
  /** Label suffix: the rule name, or an unknown custom message's customType. */
  detail?: string;
}

const TTSR_DISABLED_RULES: InjectionSetting = { kind: "append-rule", path: "ttsr.disabledRules" };

function off(path: string, offValue: boolean | string): InjectionSetting {
  return { kind: "value", path, offValue };
}

export const INJECTION_SOURCES = {
  "todo-reminder": { id: "todo-reminder", label: "Todo reminder", setting: off("todo.reminders", false), effect: "next-turn" },
  "todo-nudge": { id: "todo-nudge", label: "Todo progress nudge", setting: off("todo.reminders", false), effect: "next-turn" },
  // todo.eager / task.eager: "default" is the only value that never injects
  // (the SDK returns early on it); the preludes fire on a session's first
  // message, so the switch matters for new sessions.
  "eager-todo": { id: "eager-todo", label: "Eager todo prelude", setting: off("todo.eager", "default"), effect: "new-session" },
  "eager-task": { id: "eager-task", label: "Eager task-delegation prelude", setting: off("task.eager", "default"), effect: "new-session" },
  "rule-violation": { id: "rule-violation", label: "Rule violation", setting: TTSR_DISABLED_RULES, effect: "next-turn" },
  "unexpected-stop": { id: "unexpected-stop", label: "Unexpected-stop retry", setting: off("features.unexpectedStopDetection", "none"), effect: "next-turn" },
  "thinking-loop": { id: "thinking-loop", label: "Loop guard redirect", setting: off("model.loopGuard.enabled", false), effect: "next-turn" },
  "tool-call-loop": { id: "tool-call-loop", label: "Tool-call loop redirect", setting: off("model.toolCallLoopGuard.enabled", false), effect: "next-turn" },
  "skill-notice": { id: "skill-notice", label: "Skill list notice", setting: off("skillful", false), effect: "new-session" },
  "magic-ultrathink": { id: "magic-ultrathink", label: "Ultrathink keyword notice", setting: off("magicKeywords.ultrathink", false), effect: "next-turn" },
  "magic-orchestrate": { id: "magic-orchestrate", label: "Orchestrate keyword notice", setting: off("magicKeywords.orchestrate", false), effect: "next-turn" },
  "magic-workflow": { id: "magic-workflow", label: "Workflow keyword notice", setting: off("magicKeywords.workflow", false), effect: "next-turn" },
  "magic-jevify": { id: "magic-jevify", label: "Jevify keyword notice", setting: off("magicKeywords.jevify", false), effect: "next-turn" },
  "image-description": { id: "image-description", label: "Image description", setting: off("images.describeForTextModels", false), effect: "next-turn" },
  "plan-mode-rules": { id: "plan-mode-rules", label: "Plan mode rules", setting: off("plan.defaultOnStartup", false), effect: "new-session" },
  "plan-reference": { id: "plan-reference", label: "Approved plan reference", setting: off("plan.defaultOnStartup", false), effect: "new-session" },
  // Render-only sources: omp has no switch for these.
  "async-result": { id: "async-result", label: "Background job result", effect: "next-turn" },
  "irc-incoming": { id: "irc-incoming", label: "IRC message", effect: "next-turn" },
  "plan-decision-reminder": { id: "plan-decision-reminder", label: "Plan mode decision reminder", effect: "next-turn" },
  "plan-approved": { id: "plan-approved", label: "Plan approved", effect: "next-turn" },
  "empty-stop-retry": { id: "empty-stop-retry", label: "Empty-stop retry", effect: "next-turn" },
  "malformed-call-retry": { id: "malformed-call-retry", label: "Malformed tool-call retry", effect: "next-turn" },
  "length-stop-retry": { id: "length-stop-retry", label: "Output-limit retry", effect: "next-turn" },
  "stream-stall": { id: "stream-stall", label: "Stream stall continue", effect: "next-turn" },
  "dsml-leak": { id: "dsml-leak", label: "Malformed DSML tool call", effect: "next-turn" },
  "reasoning-without-tools": { id: "reasoning-without-tools", label: "Reasoning-without-tools interrupt", effect: "next-turn" },
  "date-cwd": { id: "date-cwd", label: "Date / cwd reminder", effect: "next-turn" },
  "manual-continue": { id: "manual-continue", label: "Continue notice", effect: "next-turn" },
  "eval-notice": { id: "eval-notice", label: "Eval runtime notice", effect: "next-turn" },
  "launch-completion": { id: "launch-completion", label: "Supervised process notice", effect: "next-turn" },
  "todo-error": { id: "todo-error", label: "Todo error reminder", effect: "next-turn" },
  "tool-roster": { id: "tool-roster", label: "Tool roster notice", effect: "next-turn" },
  unknown: { id: "unknown", label: "Unknown injection", effect: "next-turn" },
} as const satisfies Record<string, InjectionSourceDef>;

export type InjectionSourceId = keyof typeof INJECTION_SOURCES;

/** Exact custom_message.customType → source. */
const CUSTOM_TYPE_SOURCES: Record<string, InjectionSourceId> = {
  "mid-run-todo-nudge": "todo-nudge",
  "eager-todo-prelude": "eager-todo",
  "eager-task-prelude": "eager-task",
  "ttsr-injection": "rule-violation",
  "thinking-loop-redirect": "thinking-loop",
  "tool-call-loop-redirect": "tool-call-loop",
  "skill-notice": "skill-notice",
  "skillful-notice": "skill-notice",
  "ultrathink-notice": "magic-ultrathink",
  "orchestrate-notice": "magic-orchestrate",
  "workflow-notice": "magic-workflow",
  "jevify-notice": "magic-jevify",
  "image-attachment-description": "image-description",
  "plan-mode-context": "plan-mode-rules",
  "plan-mode-reference": "plan-reference",
  "async-result": "async-result",
  "irc:incoming": "irc-incoming",
  "eval-prelude-guide": "eval-notice",
  "eval-prelude-notice": "eval-notice",
  "eval-state-context": "eval-notice",
  "launch-completion": "launch-completion",
  "todo-error-reminder": "todo-error",
  "tool-roster-notice": "tool-roster",
};

export interface InjectionSignature {
  sourceId: InjectionSourceId;
  /** Whitespace-normalized opening text the message must start with. */
  prefix: string;
  /**
   * Template the signature was taken from, relative to
   * `node_modules/@oh-my-pi/`. `#` separates a TS source file from the
   * literal that builds the text inline (no template file exists).
   */
  template: string;
}

/**
 * developer-message signatures, most specific first. Prefixes are compared
 * against whitespace-collapsed text, so `<system-reminder>\nYou stopped`
 * matches `<system-reminder> You stopped`.
 */
export const DEVELOPER_SIGNATURES: readonly InjectionSignature[] = [
  { sourceId: "todo-reminder", prefix: "<system-reminder> You stopped with", template: "pi-coding-agent/src/session/todo-tracker.ts#You stopped with" },
  { sourceId: "rule-violation", prefix: "<system-reminder reason=\"rule_violation\"", template: "pi-coding-agent/src/prompts/system/ttsr-tool-reminder.md" },
  { sourceId: "rule-violation", prefix: "<system-reminder reason=\"rule_violation\"", template: "pi-coding-agent/src/prompts/system/ttsr-warning.md" },
  { sourceId: "rule-violation", prefix: "<system-interrupt reason=\"rule_violation\"", template: "pi-coding-agent/src/prompts/system/ttsr-interrupt.md" },
  { sourceId: "unexpected-stop", prefix: "<system-injection> You said you would continue", template: "pi-coding-agent/src/prompts/system/unexpected-stop-retry.md" },
  { sourceId: "empty-stop-retry", prefix: "<system-injection> Stopped without actionable output", template: "pi-coding-agent/src/prompts/system/empty-stop-retry.md" },
  { sourceId: "malformed-call-retry", prefix: "<system-injection> The provider rejected your last turn", template: "pi-coding-agent/src/prompts/system/malformed-function-call-retry.md" },
  { sourceId: "length-stop-retry", prefix: "<system-injection> Previous response hit the", template: "pi-coding-agent/src/prompts/system/length-stop-retry.md" },
  { sourceId: "stream-stall", prefix: "<system-injection> The provider connection dropped", template: "pi-coding-agent/src/prompts/system/stream-stall-continue.md" },
  { sourceId: "thinking-loop", prefix: "<system-interrupt reason=\"thinking_loop_detected\">", template: "pi-coding-agent/src/prompts/system/thinking-loop-redirect.md" },
  { sourceId: "tool-call-loop", prefix: "<system-interrupt reason=\"tool_call_loop_detected\">", template: "pi-coding-agent/src/prompts/system/tool-call-loop-redirect.md" },
  { sourceId: "reasoning-without-tools", prefix: "<system-interrupt reason=\"reasoning_without_tool_calls\">", template: "pi-coding-agent/src/prompts/system/gemini-tool-call-reminder.md" },
  { sourceId: "plan-decision-reminder", prefix: "<system-reminder> Plan mode turn ended", template: "pi-coding-agent/src/prompts/system/plan-mode-tool-decision-reminder.md" },
  { sourceId: "plan-approved", prefix: "Plan approved.", template: "pi-coding-agent/src/prompts/system/plan-mode-approved.md" },
  { sourceId: "date-cwd", prefix: "<system-reminder> Today:", template: "pi-coding-agent/src/prompts/system/date-cwd-reminder.md" },
  { sourceId: "manual-continue", prefix: "<system-notice> Continue.", template: "pi-coding-agent/src/prompts/system/manual-continue.md" },
  { sourceId: "dsml-leak", prefix: "Tool call failed: your previous response tried to invoke a tool", template: "pi-agent-core/src/prompts/dsml-tool-call-leak.md" },
];

/** Opening text a classifier needs; longer content is never scanned. */
const SIGNATURE_SCAN_CHARS = 400;

export function normalizeInjectionText(text: string): string {
  return text.slice(0, SIGNATURE_SCAN_CHARS * 2).replace(/\s+/g, " ").trim().slice(0, SIGNATURE_SCAN_CHARS);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const value = (block as { text?: unknown }).text;
      if (typeof value === "string") text += (text ? "\n" : "") + value;
      if (text.length >= SIGNATURE_SCAN_CHARS * 2) break;
    }
  }
  return text;
}

const RULE_ATTR = /^<system-(?:reminder|interrupt)\b[^>]*\brule="([^"]{1,200})"/;

function build(sourceId: InjectionSourceId, rule?: string, detail = rule): InjectionClassification {
  const def: InjectionSourceDef = INJECTION_SOURCES[sourceId];
  const result: InjectionClassification = {
    sourceId,
    label: detail ? `${def.label}: ${detail}` : def.label,
    effect: def.effect,
  };
  // A rule violation without a recoverable rule name cannot be disabled.
  if (def.setting && (def.setting.kind !== "append-rule" || rule)) result.setting = def.setting;
  if (rule) result.rule = rule;
  if (detail) result.detail = detail;
  return result;
}

/** Classify already-normalized developer text. */
export function classifyDeveloperText(normalized: string): InjectionClassification {
  for (const signature of DEVELOPER_SIGNATURES) {
    if (!normalized.startsWith(signature.prefix)) continue;
    const rule = signature.sourceId === "rule-violation" ? RULE_ATTR.exec(normalized)?.[1] : undefined;
    return build(signature.sourceId, rule);
  }
  return build("unknown");
}

/** Classify a custom_message by customType (text only feeds rule names). */
export function classifyCustomType(customType: string, normalized: string): InjectionClassification {
  const sourceId = CUSTOM_TYPE_SOURCES[customType];
  if (!sourceId) return build("unknown", undefined, customType || undefined);
  const rule = sourceId === "rule-violation" ? RULE_ATTR.exec(normalized)?.[1] : undefined;
  return build(sourceId, rule);
}

/** Message shape shared by UI messages and raw journal message bodies. */
export interface InjectionCandidate {
  role?: unknown;
  customType?: unknown;
  content?: unknown;
}

/** Whether a message is an omp system injection (compaction summaries are not). */
export function isInjectionMessage(message: InjectionCandidate): boolean {
  if (message.role === "developer") return true;
  return message.role === "custom" && message.customType !== "compaction";
}

/**
 * Classify a UI message (`{role:"developer"}` / `{role:"custom"}`). Returns
 * null for anything that is not an injection, including compaction.
 */
export function classifyInjection(message: InjectionCandidate): InjectionClassification | null {
  if (!isInjectionMessage(message)) return null;
  const normalized = normalizeInjectionText(contentText(message.content));
  if (message.role === "developer") return classifyDeveloperText(normalized);
  return classifyCustomType(typeof message.customType === "string" ? message.customType : "", normalized);
}

/** One switch the injection settings panel lists. */
export interface InjectionSwitch {
  path: string;
  setting: InjectionSetting;
  effect: InjectionEffect;
  sourceIds: InjectionSourceId[];
}

/** Every distinct setting path in the source map, in table order. */
export function injectionSwitches(): InjectionSwitch[] {
  const byPath = new Map<string, InjectionSwitch>();
  for (const def of Object.values(INJECTION_SOURCES) as InjectionSourceDef[]) {
    if (!def.setting) continue;
    const existing = byPath.get(def.setting.path);
    if (existing) {
      existing.sourceIds.push(def.id as InjectionSourceId);
      if (def.effect === "new-session") existing.effect = "new-session";
      continue;
    }
    byPath.set(def.setting.path, { path: def.setting.path, setting: def.setting, effect: def.effect, sourceIds: [def.id as InjectionSourceId] });
  }
  return [...byPath.values()];
}

/** Paths the injection settings route accepts writes for. */
export function isInjectionSettingPath(path: string): boolean {
  return injectionSwitches().some((entry) => entry.path === path);
}
