import type { AiConfig } from '../config/index.js';
import {
  ProviderError,
  type AIProvider,
  type ContentBlock,
  type GenerateRequest,
  type GenerateResponse,
  type ModelMessage,
  type StopReason,
} from './provider.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anthropic Messages API provider. */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly supportsTools = true;
  readonly isLanguageModel = true;
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly maxTokensCap: number;

  constructor(config: AiConfig['anthropic']) {
    if (!config.apiKey) {
      throw new Error('AnthropicProvider requires ANTHROPIC_API_KEY');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.version = config.version;
    this.defaultModel = config.defaultModel;
    this.maxTokensCap = config.maxTokens;
  }

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      max_tokens: Math.min(request.maxTokens, this.maxTokensCap),
      temperature: request.temperature,
      system: request.system,
      messages: request.messages.map(toAnthropicMessage),
    };

    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.version,
      },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        `Anthropic API ${response.status}: ${detail.slice(0, 500)}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as AnthropicResponse;

    return {
      content: payload.content.map(fromAnthropicBlock).filter((b): b is ContentBlock => b !== null),
      stopReason: mapStopReason(payload.stop_reason),
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
      },
      model: payload.model,
      provider: this.name,
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      // One token against the cheapest path is enough to prove credentials and
      // connectivity without burning budget.
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.version,
        },
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (response.ok) return { ok: true, detail: `reachable (${this.defaultModel})` };
      return { ok: false, detail: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
    }
  }
}

function toAnthropicMessage(message: ModelMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'tool_use':
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
      }
    }),
  };
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool_use' && block.id && block.name) {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} };
  }
  // Unknown block types (thinking, redacted content) carry no information the
  // runtime can act on; dropping them is safer than guessing.
  return null;
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}
