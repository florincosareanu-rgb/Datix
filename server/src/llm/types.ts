// Formatul mesajelor compatibil OpenAI / DeepSeek (chat completions).

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  thinking?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  maxTokens?: number;
  json?: boolean;
  temperature?: number;
}

export interface LlmUsage {
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface LlmResult {
  model: string;
  content: string;
  reasoning: string;
  toolCalls: LlmToolCall[];
  finishReason: string;
  usage: LlmUsage;
}

export type LlmStreamEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_started'; index: number; id: string; name: string };

export interface LlmProvider {
  readonly name: string;
  stream(req: LlmRequest, onEvent: (e: LlmStreamEvent) => void, signal?: AbortSignal): Promise<LlmResult>;
  listModels?(): Promise<string[]>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
