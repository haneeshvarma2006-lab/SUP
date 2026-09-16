import type { AppConfig } from '../config/index.js';
import type { Logger } from '../util/logger.js';
import { AnthropicProvider } from './anthropic.js';
import { HeuristicProvider } from './heuristic.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import type { AIProvider } from './provider.js';

/**
 * Resolves model providers by name and holds the process default.
 *
 * Agents carry a model string; routing that string to a provider happens here,
 * so an agent can be moved onto a different engine without touching the runtime.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();
  private defaultProviderName: string;

  constructor(config: AppConfig, logger: Logger) {
    // The heuristic provider is always registered: it is the fallback that
    // keeps the platform usable when no credentials are configured.
    this.register(new HeuristicProvider());

    if (config.ai.anthropic.apiKey) {
      try {
        this.register(new AnthropicProvider(config.ai.anthropic));
      } catch (err) {
        logger.warn('anthropic provider unavailable', { error: err });
      }
    }
    if (config.ai.openaiCompatible.apiKey && config.ai.openaiCompatible.baseUrl) {
      try {
        this.register(new OpenAICompatibleProvider(config.ai.openaiCompatible));
      } catch (err) {
        logger.warn('openai-compatible provider unavailable', { error: err });
      }
    }

    const requested = config.ai.provider;
    if (this.providers.has(requested)) {
      this.defaultProviderName = requested;
    } else {
      this.defaultProviderName = 'heuristic';
      if (requested !== 'scripted' && requested !== 'heuristic') {
        logger.warn('requested AI provider is not configured; falling back', {
          requested,
          using: this.defaultProviderName,
        });
      }
    }

    const active = this.default();
    logger.info('ai provider selected', {
      provider: active.name,
      isLanguageModel: active.isLanguageModel,
      note: active.isLanguageModel
        ? undefined
        : 'no model credentials configured — agents run on the offline heuristic policy',
    });
  }

  register(provider: AIProvider): void {
    this.providers.set(provider.name, provider);
  }

  default(): AIProvider {
    const provider = this.providers.get(this.defaultProviderName);
    if (!provider) throw new Error(`Default provider ${this.defaultProviderName} is not registered`);
    return provider;
  }

  /**
   * Picks the provider for a model string. `provider/model` selects explicitly;
   * a bare model name uses the default provider.
   */
  resolve(model: string): { provider: AIProvider; model: string } {
    if (model.includes('/')) {
      const [prefix, ...rest] = model.split('/');
      const provider = this.providers.get(prefix!);
      if (provider) return { provider, model: rest.join('/') };
    }
    const provider = this.default();
    return { provider, model: provider.isLanguageModel ? model : provider.defaultModel };
  }

  list(): AIProvider[] {
    return [...this.providers.values()];
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
