import { isCancellation } from '../util/errors.js';
import { sleep } from './cancellation.js';

export interface RetryOptions {
  attempts: number;
  /** First backoff delay; each subsequent attempt doubles it. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Return false to stop retrying and rethrow immediately. */
  isRetryable?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

const DEFAULTS = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
};

/**
 * Retries `fn` with exponential backoff and full jitter.
 *
 * Jitter is not decoration: without it, several agent runs that hit a rate
 * limit at the same moment retry in lockstep and hit it again together.
 * Cancellation is never retried.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: Partial<RetryOptions> = {}): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isCancellation(err) || opts.signal?.aborted) throw err;
      if (attempt >= opts.attempts) break;
      if (opts.isRetryable && !opts.isRetryable(err, attempt)) throw err;

      const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * ceiling);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }

  throw lastError;
}

/** Classifies transient upstream failures worth retrying. */
export function isTransientHttpError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  if (typeof status === 'number') {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(
    error.message,
  );
}

/**
 * Fixed-window rate limiter.
 *
 * Applied to agent-to-agent messaging: an agent stuck in a reply loop burns its
 * budget and is refused rather than being allowed to flood the workspace.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit. Returns false when the caller has exhausted its budget. */
  tryConsume(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;
    return true;
  }

  remaining(key: string, now = Date.now()): number {
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) return this.limit;
    return Math.max(0, this.limit - window.count);
  }

  resetAt(key: string): number | null {
    return this.windows.get(key)?.resetAt ?? null;
  }

  reset(key?: string): void {
    if (key === undefined) this.windows.clear();
    else this.windows.delete(key);
  }

  /** Drops expired windows so the map does not grow with one-off keys. */
  sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
