import { TOOL_NAMES, truncate } from '@sup/shared';
import { fail, ok, readNumber, readString, schema, type Tool, type ToolResult } from '../types.js';

/**
 * Tools that reach outside the workspace.
 *
 * All three are higher risk than the internal tools and are marked accordingly:
 * `web_search` and `http_request` leak the workspace's intent to a third party,
 * and `code_exec` runs code. The executor gates them on human approval when the
 * workspace requires it.
 */

export const webSearchTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.webSearch,
    category: 'external',
    title: 'Web search',
    description:
      'Search the web for source material. Run several focused queries rather than one broad one. ' +
      'If nothing useful comes back, say so — do not invent sources.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'integer', description: 'Max results (default 5, max 10).', minimum: 1, maximum: 10 },
      },
      ['query'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const query = readString(input, 'query').trim();
    if (!query) return fail('web_search needs a query');

    const limit = Math.min(10, Math.max(1, readNumber(input, 'limit', 5)));
    const outcome = await ctx.services.webSearch({ query, limit, signal: ctx.signal });

    if (outcome.results.length === 0) {
      // Being explicit matters: an agent told "no results" invents less than one
      // handed an empty list with no explanation.
      return ok('No search results', {
        results: [],
        provider: outcome.provider,
        note:
          outcome.provider === 'none'
            ? 'No web search provider is configured on this server (set SEARCH_PROVIDER and SEARCH_API_KEY). No search was performed — report this as a gap rather than filling it in from memory.'
            : 'The search provider returned nothing for this query. Report it as a gap; do not invent sources.',
      });
    }

    return ok(`${outcome.results.length} result(s) for "${truncate(query, 50)}"`, {
      provider: outcome.provider,
      query,
      results: outcome.results,
    });
  },
};

export const httpRequestTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.httpRequest,
    category: 'external',
    title: 'HTTP request',
    description:
      'Fetch a public URL over HTTPS and return its text. Read-only: only GET is permitted.',
    risk: 'dangerous',
    requiresApproval: true,
    orchestratorOnly: false,
    parameters: schema(
      {
        url: { type: 'string', description: 'Absolute https:// URL to fetch.' },
        max_bytes: { type: 'integer', description: 'Truncate the response at this size. Default 100000.' },
      },
      ['url'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const raw = readString(input, 'url').trim();

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return fail('Invalid URL');
    }
    if (url.protocol !== 'https:') return fail('Only https:// URLs are allowed');
    if (isPrivateHost(url.hostname)) {
      // Without this an agent could be steered into reading cloud metadata or
      // internal services from inside the network perimeter.
      return fail('Refusing to fetch a private or loopback address');
    }

    const maxBytes = Math.min(1_000_000, Math.max(1000, readNumber(input, 'max_bytes', 100_000)));

    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: ctx.signal,
        headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      });
      const text = (await response.text()).slice(0, maxBytes);
      return ok(`GET ${url.hostname} → ${response.status}`, {
        url: url.toString(),
        status: response.status,
        content_type: response.headers.get('content-type'),
        body: text,
        truncated: text.length >= maxBytes,
      });
    } catch (err) {
      return fail('Request failed', err instanceof Error ? err.message : String(err));
    }
  },
};

export const codeExecTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.codeExec,
    category: 'external',
    title: 'Execute code',
    description:
      'Run a short script and return its output. Use it to verify a change or compute something — not to reach the network or the host. ' +
      'The script runs with a time limit in a scratch directory and is discarded afterwards.',
    risk: 'dangerous',
    requiresApproval: true,
    orchestratorOnly: false,
    parameters: schema(
      {
        language: { type: 'string', enum: ['python', 'javascript'], description: 'Runtime to use.' },
        source: { type: 'string', description: 'The program. Print results to stdout.' },
        stdin: { type: 'string', description: 'Optional input piped to the program.' },
        timeout_seconds: { type: 'integer', description: 'Default 20, max 60.', minimum: 1, maximum: 60 },
      },
      ['language', 'source'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const language = readString(input, 'language', 'python').toLowerCase();
    const source = readString(input, 'source');
    if (!source.trim()) return fail('code_exec needs source to run');
    if (source.length > 100_000) return fail('Source is too large (100k char limit)');

    const timeoutMs = Math.min(60_000, Math.max(1000, readNumber(input, 'timeout_seconds', 20) * 1000));

    const result = await ctx.services.executeCode({
      language,
      source,
      stdin: readString(input, 'stdin'),
      timeoutMs,
      signal: ctx.signal,
    });

    const summary = result.timedOut
      ? `Timed out after ${timeoutMs / 1000}s`
      : `Exited ${result.exitCode}`;

    // A non-zero exit is a real answer, not a tool failure — the agent needs to
    // see the stderr and decide, so this returns ok:true with the detail.
    return ok(summary, {
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  },
};

/**
 * Blocks loopback, link-local and RFC1918 destinations.
 *
 * DNS names that resolve to a private address are not caught here — that needs
 * resolution-time checking, which Node's fetch does not expose a hook for.
 * Treat this as defence in depth, not a complete SSRF control; run the server
 * with egress restrictions if that matters to you.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  // IPv6 unique-local and link-local.
  if (/^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;

  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

export const externalTools: Tool[] = [webSearchTool, httpRequestTool, codeExecTool];
