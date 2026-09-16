/**
 * Model provider abstraction.
 *
 * Everything above this file — the agent runtime, orchestrator, tools and
 * memory — speaks only these types. Swapping providers is a config change, not
 * a refactor.
 */

export type MessageRole = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ModelMessage {
  role: MessageRole;
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface GenerateRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  temperature: number;
  maxTokens: number;
  /**
   * Opaque hints the provider may use. The heuristic provider reads the agent
   * role from here; API providers ignore it.
   */
  metadata?: Record<string, unknown>;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface GenerateResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
}

export interface AIProvider {
  readonly name: string;
  /** Shown in the UI so it is always visible which engine produced a result. */
  readonly displayName: string;
  /** False for providers that cannot do native tool calling. */
  readonly supportsTools: boolean;
  /** True when this provider calls a real language model over the network. */
  readonly isLanguageModel: boolean;
  readonly defaultModel: string;
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse>;
  /** Cheap liveness probe used by the health endpoint. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// Helpers shared by provider implementations
// ---------------------------------------------------------------------------

export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

export function userMessage(text: string): ModelMessage {
  return { role: 'user', content: [textBlock(text)] };
}

export function assistantMessage(content: ContentBlock[]): ModelMessage {
  return { role: 'assistant', content };
}

export function collectText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function collectToolUses(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/** Rough token estimate used for budgeting when a provider reports nothing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
