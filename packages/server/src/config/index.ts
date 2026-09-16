import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** Absolute path to the SQLite file, or ':memory:' for tests. */
  databasePath: string;
  /** HMAC key for session tokens. Must be set explicitly in production. */
  authSecret: string;
  sessionTtlMs: number;
  corsOrigins: string[] | true;
  /** Serve the built web client from the API process. */
  serveStaticDir: string | null;
  ai: AiConfig;
  limits: LimitsConfig;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface AiConfig {
  /** Which provider the agent runtime uses by default. */
  provider: string;
  anthropic: {
    apiKey: string | null;
    baseUrl: string;
    defaultModel: string;
    maxTokens: number;
    /** API version header value. */
    version: string;
  };
  openaiCompatible: {
    apiKey: string | null;
    baseUrl: string | null;
    defaultModel: string;
  };
  embeddings: {
    provider: 'local' | 'voyage' | 'openai';
    apiKey: string | null;
    baseUrl: string | null;
    model: string;
    dimensions: number;
  };
  search: {
    provider: 'none' | 'tavily' | 'brave';
    apiKey: string | null;
  };
}

export interface LimitsConfig {
  /** Events retained per workspace in the replay log. */
  eventLogRetention: number;
  /** Ceiling on concurrently executing agent runs across the whole process. */
  globalRunConcurrency: number;
  /** Wall-clock budget for a single agent run. */
  runTimeoutMs: number;
  /** Wall-clock budget for a single tool invocation. */
  toolTimeoutMs: number;
  /** Agent -> agent messages allowed per agent per minute. */
  agentMessageRatePerMinute: number;
  /** How long a task execution lock is held before it is considered stale. */
  taskLockTtlMs: number;
  /** Max bytes of text stored for one workspace file. */
  maxFileBytes: number;
  /** How long an approval request waits before expiring. */
  approvalTtlMs: number;
  /** Max body size for HTTP requests. */
  maxRequestBodyBytes: number;
}

function env(key: string): string | undefined {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? undefined : raw;
}

function intEnv(key: string, fallback: number): number {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = env(key);
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = (env('NODE_ENV') ?? 'development') as AppConfig['env'];
  const isProd = nodeEnv === 'production';

  const explicitSecret = env('AUTH_SECRET');
  if (isProd && !explicitSecret) {
    throw new Error(
      'AUTH_SECRET must be set in production. Generate one with: openssl rand -hex 32',
    );
  }

  const dataDir = env('DATA_DIR') ?? path.resolve(process.cwd(), '../../data');

  const config: AppConfig = {
    env: nodeEnv,
    host: env('HOST') ?? '0.0.0.0',
    port: intEnv('PORT', 4000),
    databasePath: env('DATABASE_PATH') ?? path.join(dataDir, 'sup.db'),
    // A random per-process secret in dev means restarting invalidates sessions,
    // which is the correct default: it never silently ships a known key.
    authSecret: explicitSecret ?? randomBytes(32).toString('hex'),
    sessionTtlMs: intEnv('SESSION_TTL_MS', 1000 * 60 * 60 * 24 * 14),
    corsOrigins: env('CORS_ORIGINS')?.split(',').map((s) => s.trim()) ?? true,
    serveStaticDir: env('SERVE_STATIC_DIR') ?? null,
    logLevel: (env('LOG_LEVEL') ?? (nodeEnv === 'test' ? 'error' : 'info')) as AppConfig['logLevel'],
    ai: {
      provider: env('AI_PROVIDER') ?? (env('ANTHROPIC_API_KEY') ? 'anthropic' : 'scripted'),
      anthropic: {
        apiKey: env('ANTHROPIC_API_KEY') ?? null,
        baseUrl: env('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com',
        defaultModel: env('ANTHROPIC_MODEL') ?? 'claude-sonnet-5',
        maxTokens: intEnv('ANTHROPIC_MAX_TOKENS', 4096),
        version: env('ANTHROPIC_VERSION') ?? '2023-06-01',
      },
      openaiCompatible: {
        apiKey: env('OPENAI_API_KEY') ?? null,
        baseUrl: env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
        defaultModel: env('OPENAI_MODEL') ?? 'gpt-4o-mini',
      },
      embeddings: {
        provider: (env('EMBEDDINGS_PROVIDER') ?? 'local') as AiConfig['embeddings']['provider'],
        apiKey: env('EMBEDDINGS_API_KEY') ?? null,
        baseUrl: env('EMBEDDINGS_BASE_URL') ?? null,
        model: env('EMBEDDINGS_MODEL') ?? 'voyage-3-lite',
        dimensions: intEnv('EMBEDDINGS_DIMENSIONS', 384),
      },
      search: {
        provider: (env('SEARCH_PROVIDER') ?? 'none') as AiConfig['search']['provider'],
        apiKey: env('SEARCH_API_KEY') ?? null,
      },
    },
    limits: {
      eventLogRetention: intEnv('EVENT_LOG_RETENTION', 5000),
      globalRunConcurrency: intEnv('GLOBAL_RUN_CONCURRENCY', 12),
      runTimeoutMs: intEnv('RUN_TIMEOUT_MS', 1000 * 60 * 5),
      toolTimeoutMs: intEnv('TOOL_TIMEOUT_MS', 1000 * 45),
      agentMessageRatePerMinute: intEnv('AGENT_MESSAGE_RATE', 30),
      taskLockTtlMs: intEnv('TASK_LOCK_TTL_MS', 1000 * 60 * 10),
      maxFileBytes: intEnv('MAX_FILE_BYTES', 1024 * 512),
      approvalTtlMs: intEnv('APPROVAL_TTL_MS', 1000 * 60 * 15),
      maxRequestBodyBytes: intEnv('MAX_REQUEST_BODY_BYTES', 1024 * 1024 * 2),
    },
  };

  if (boolEnv('TRUST_PROXY', false)) {
    // Placeholder hook: surfaced here so the deployment knob is discoverable.
  }

  return { ...config, ...overrides };
}
