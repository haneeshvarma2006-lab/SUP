import { CancellationError } from '../util/errors.js';

export interface CancellationHandle {
  signal: AbortSignal;
  cancel(reason: string): void;
  get reason(): string | null;
  get cancelled(): boolean;
  /** Throws CancellationError if cancelled. Call at every safe checkpoint. */
  throwIfCancelled(): void;
}

/**
 * Tracks cancellable work by run id.
 *
 * A human clicking "stop" on an agent resolves to `cancel(runId)` here; the
 * runtime checks the handle between steps and threads the signal into every
 * tool call and model request, so cancellation actually aborts in-flight work
 * rather than just relabelling the UI.
 */
export class CancellationRegistry {
  private readonly handles = new Map<string, { controller: AbortController; reason: string | null }>();

  create(key: string): CancellationHandle {
    // Replacing an existing handle would orphan the old one; cancel it first.
    const existing = this.handles.get(key);
    if (existing) existing.controller.abort();

    const entry = { controller: new AbortController(), reason: null as string | null };
    this.handles.set(key, entry);

    return {
      signal: entry.controller.signal,
      cancel: (reason: string) => this.cancel(key, reason),
      get reason() {
        return entry.reason;
      },
      get cancelled() {
        return entry.controller.signal.aborted;
      },
      throwIfCancelled() {
        if (entry.controller.signal.aborted) {
          throw new CancellationError(entry.reason ?? 'cancelled');
        }
      },
    };
  }

  cancel(key: string, reason: string): boolean {
    const entry = this.handles.get(key);
    if (!entry || entry.controller.signal.aborted) return false;
    entry.reason = reason;
    entry.controller.abort();
    return true;
  }

  /** Cancels every handle whose key starts with `prefix`. */
  cancelMatching(predicate: (key: string) => boolean, reason: string): number {
    let count = 0;
    for (const key of [...this.handles.keys()]) {
      if (predicate(key) && this.cancel(key, reason)) count += 1;
    }
    return count;
  }

  isCancelled(key: string): boolean {
    return this.handles.get(key)?.controller.signal.aborted ?? false;
  }

  release(key: string): void {
    this.handles.delete(key);
  }

  get activeCount(): number {
    let n = 0;
    for (const entry of this.handles.values()) if (!entry.controller.signal.aborted) n += 1;
    return n;
  }
}

/** Combines several signals into one that aborts when any input aborts. */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 1) return live[0]!;
  const controller = new AbortController();
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Rejects with a timeout error if `promise` does not settle in time. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancellationError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancellationError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
