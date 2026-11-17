import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

export function hasFinalAnswerBlocks(message: AssistantMessage): boolean {
  return splitFinalAssistantBlocks(message).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

/**
 * Indices in the open range (userIdx, finalIdx) of assistant messages that
 * already delivered an answer: they ended the model's turn (`stopReason:
 * "stop"`) with answer text. The turn only continued because something else
 * (e.g. omp's todo-completion reminder) re-woke the agent, so these must stay
 * visible instead of being folded into the process details.
 */
export function findStoppedAnswerIndices(
  messages: readonly AgentMessage[],
  userIdx: number,
  finalIdx: number,
): number[] {
  const indices: number[] = [];
  for (let idx = userIdx + 1; idx < finalIdx; idx++) {
    const message = messages[idx];
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "stop") continue;
    if (hasFinalAnswerBlocks(message)) indices.push(idx);
  }
  return indices;
}
