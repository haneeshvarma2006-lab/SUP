import type { AiConfig } from '../config/index.js';
import { withRetry, isTransientHttpError } from '../concurrency/retry.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  provider: string;
}

export interface SearchBackend {
  readonly name: string;
  search(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]>;
}

/**
 * Web search, behind a provider interface.
 *
 * When no provider is configured this returns an empty result set with the
 * provider named `none`. It does not fabricate results, and the tool wrapper
 * tells the agent explicitly that no search happened — an agent that is handed
 * plausible-looking fake sources will cite them.
 */
export class WebSearchService {
  private readonly backend: SearchBackend | null;

  constructor(
    config: AiConfig['search'],
    private readonly logger: Logger,
  ) {
    this.backend = createBackend(config);
    if (!this.backend) {
      logger.info('web search disabled', {
        note: 'set SEARCH_PROVIDER (tavily|brave) and SEARCH_API_KEY to enable it',
      });
    }
  }

  get providerName(): string {
    return this.backend?.name ?? 'none';
  }

  get enabled(): boolean {
    return this.backend !== null;
  }

  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchOutcome> {
    if (!this.backend) return { results: [], provider: 'none' };

    try {
      const results = await withRetry(() => this.backend!.search(query, limit, signal), {
        attempts: 3,
        baseDelayMs: 400,
        isRetryable: isTransientHttpError,
        signal,
      });
      return { results: results.slice(0, limit), provider: this.backend.name };
    } catch (err) {
      this.logger.warn('web search failed', {
        provider: this.backend.name,
        error: errorMessage(err),
      });
      // A search outage degrades the answer; it must not fail the agent run.
      return { results: [], provider: this.backend.name };
    }
  }
}

function createBackend(config: AiConfig['search']): SearchBackend | null {
  if (!config.apiKey) return null;
  switch (config.provider) {
    case 'tavily':
      return new TavilyBackend(config.apiKey);
    case 'brave':
      return new BraveBackend(config.apiKey);
    default:
      return null;
  }
}

class TavilyBackend implements SearchBackend {
  readonly name = 'tavily';

  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: limit,
        search_depth: 'basic',
      }),
      signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Tavily ${response.status}`), { status: response.status });
    }
    const payload = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (payload.results ?? []).map((r) => ({
      title: r.title ?? 'Untitled',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  }
}

class BraveBackend implements SearchBackend {
  readonly name = 'brave';

  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));

    const response = await fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': this.apiKey },
      signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Brave ${response.status}`), { status: response.status });
    }
    const payload = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (payload.web?.results ?? []).map((r) => ({
      title: r.title ?? 'Untitled',
      url: r.url ?? '',
      snippet: stripTags(r.description ?? ''),
    }));
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}
