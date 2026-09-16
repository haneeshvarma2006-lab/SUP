/**
 * Counting semaphore with FIFO waiters.
 *
 * Used to bound how many agent runs execute at once, globally and per agent.
 * FIFO matters: without it a busy workspace can starve a quiet one.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('Semaphore capacity must be at least 1');
    this.available = capacity;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('aborted');

    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });

    this.available -= 1;
    return this.makeRelease();
  }

  /** Non-blocking acquire. Returns null when the semaphore is saturated. */
  tryAcquire(): (() => void) | null {
    if (this.available <= 0) return null;
    this.available -= 1;
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      // Guard against a caller releasing twice, which would inflate capacity.
      if (released) return;
      released = true;
      this.available += 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Keyed semaphores — one bounded lane per key, created lazily. */
export class KeyedSemaphore {
  private readonly lanes = new Map<string, Semaphore>();

  constructor(private readonly capacityFor: (key: string) => number) {}

  for(key: string): Semaphore {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = new Semaphore(Math.max(1, this.capacityFor(key)));
      this.lanes.set(key, lane);
    }
    return lane;
  }

  forget(key: string): void {
    const lane = this.lanes.get(key);
    if (lane && lane.inUse === 0 && lane.queued === 0) this.lanes.delete(key);
  }
}

/**
 * Serialises async work per key. Unlike a semaphore of size 1 this preserves
 * submission order, which is what we need when several events mutate the same
 * task: they must apply in arrival order, not in whatever order the event loop
 * resumes them.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // `then(fn, fn)` rather than `then(fn)`: a rejection upstream must not stop
    // the next caller in the chain from running.
    const result = previous.then(fn, fn);
    // The tail swallows rejections so the chain stays usable, and clears itself
    // once it is the last link — otherwise the map grows once per key forever.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Number of keys currently tracked. Exposed for tests and metrics. */
  get size(): number {
    return this.tails.size;
  }

  clear(): void {
    this.tails.clear();
  }
}
