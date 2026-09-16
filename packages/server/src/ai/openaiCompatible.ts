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

interface ChatChoice {
  message: {
    content: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
  finish_reason: string | null;
}

interface ChatResponse {
  choices: ChatChoice[];
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Provider for any OpenAI-compatible chat-completions endpoint (OpenAI itself,
 * vLLM, Ollama's OpenAI shim, OpenRouter, ...). Included to prove the
 * abstraction is not shaped around a single vendor.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai-compatible';
  readonly displayName = 'OpenAI-compatible';
  readonly supportsTools = true;
  readonly isLanguageModel = true;
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: AiConfig['openaiCompatible']) {
    if (!config.apiKey || !config.baseUrl) {
      throw new Error('OpenAICompatibleProvider requires OPENAI_API_KEY and OPENAI_BASE_URL');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultModel = config.defaultModel;
  }

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: request.system },
    ];
    for (const message of request.messages) {
      messages.push(...toChatMessages(message));
    }

    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        `Chat completions API ${response.status}: ${detail.slice(0, 500)}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as ChatResponse;
    const choice = payload.choices[0];
    const content: ContentBlock[] = [];

    if (choice?.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    for (const call of choice?.message.tool_calls ?? []) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: safeParseArgs(call.function.arguments),
      });
    }

    return {
      content,
      stopReason: mapFinishReason(choice?.finish_reason ?? null),
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
      model: payload.model,
      provider: this.name,
    };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok
        ? { ok: true, detail: `reachable (${this.defaultModel})` }
        : { ok: false, detail: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
    }
  }
}

function toChatMessages(message: ModelMessage): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
  const toolUses = message.content.filter((b) => b.type === 'tool_use');
  const toolResults = message.content.filter((b) => b.type === 'tool_result');

  // Tool results are their own role in the chat-completions shape and must come
  // before any new assistant turn.
  for (const result of toolResults) {
    const block = result as { toolUseId: string; content: string };
    out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
  }

  if (message.role === 'assistant' && (text || toolUses.length > 0)) {
    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolUses.length > 0
        ? {
            tool_calls: toolUses.map((b) => {
              const use = b as { id: string; name: string; input: unknown };
              return {
                id: use.id,
                type: 'function',
                function: { name: use.name, arguments: JSON.stringify(use.input) },
              };
            }),
          }
        : {}),
    });
  } else if (message.role === 'user' && text) {
    out.push({ role: 'user', content: text });
  }

  return out;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}
