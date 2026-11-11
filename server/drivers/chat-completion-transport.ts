import type { TextGenerationOptions } from "../contracts.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import type { ChatToolCall } from "./openai-chat-protocol.ts";
import type { ResponseItem } from "./openai-responses.ts";

export interface ChatCompletionUsage {
  input: number;
  output: number;
}

export interface Completion {
  text: string;
  reasoning: string;
  usage: ChatCompletionUsage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
  /** Every output item of a Responses API reply, encrypted reasoning included, for the next round of this turn only. */
  responseOutput?: ResponseItem[];
  nativeOutput?: unknown;
}

export interface CompletionTransportInput {
  messages: OpenAIChatMessage[];
  model: string;
  tools: ChatToolDefinition[];
  stream: boolean;
  variant?: string;
  signal: AbortSignal;
  replay(message: OpenAIChatMessage): unknown;
  onBytes(): void;
  onDelta?(delta: string, kind: "assistant_text" | "reasoning_text"): void;
  onUsage?: TextGenerationOptions["onUsage"];
}
