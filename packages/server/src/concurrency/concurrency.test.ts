import { afterEach, describe, expect, it } from 'vitest';
import { KeyedMutex, Semaphore } from './semaphore.js';
import { CancellationRegistry, sleep, withTimeout } from './cancellation.js';
import { RateLimiter, withRetry } from './retry.js';
import { createTestWorkspace, type TestWorkspace } from '../testing/harness.js';
import { CancellationError } from '../util/errors.js';

let harness: TestWorkspace | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

describe('Semaphore', () => {
  it('never lets more than `capacity` hold a slot at once', async () => {
    const semaphore = new Semaphore(3);
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 30 }, () =>
        semaphore.run(async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await sleep(3);
          concurrent -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(concurrent).toBe(0);
    expect(semaphore.inUse).toBe(0);
  });

  it('hands slots out in FIFO order so a busy caller cannot starve others', async () => {
    const semaphore = new Semaphore(1);
    const order: number[] = [];
    const first = await semaphore.acquire();

    const waiters = [1, 2, 3, 4].map((n) =>
      semaphore.acquire().then((release) => {
        order.push(n);
        release();
      }),
    );

    first();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('releases exactly once even if a caller releases twice', async () => {
    const semaphore = new Semaphore(2);
    const release = await semaphore.acquire();
    release();
    release();
    expect(semaphore.inUse).toBe(0);

    // Capacity was not inflated: three concurrent acquires still queue one.
    const a = await semaphore.acquire();
    const b = await semaphore.acquire();
    expect(semaphore.tryAcquire()).toBeNull();
    a();
    b();
  });

  it('propagates release to a waiter when the holder finishes', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    let acquired = false;
    const waiter = semaphore.acquire().then((r) => {
      acquired = true;
      r();
    });

    await sleep(5);
    expect(acquired).toBe(false);
    release();
    await waiter;
    expect(acquired).toBe(true);
  });
});

describe('KeyedMutex', () => {
  it('serialises work per key and runs different keys in parallel', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];

    const work = (key: string, id: string) =>
      mutex.run(key, async () => {
        log.push(`${id}:start`);
        await sleep(5);
        log.push(`${id}:end`);
      });

    await Promise.all([work('a', 'a1'), work('a', 'a2'), work('b', 'b1')]);

    // Within key "a" the two operations never interleave.
    expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'));
  });

  it('keeps the chain alive after a rejection', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(mutex.run('k', async () => 'still works')).resolves.toBe('still works');
  });

  it('does not leak a map entry per key', async () => {
    const mutex = new KeyedMutex();
    await Promise.all(Array.from({ length: 50 }, (_, i) => mutex.run(`key-${i}`, async () => i)));
    // Give the cleanup microtasks a turn.
    await sleep(5);
    expect(mutex.size).toBe(0);
  });
});

describe('CancellationRegistry', () => {
  it('aborts the signal and reports the reason', () => {
    const registry = new CancellationRegistry();
    const handle = registry.create('run-1');

    expect(handle.cancelled).toBe(false);
    expect(registry.cancel('run-1', 'human pressed stop')).toBe(true);
    expect(handle.cancelled).toBe(true);
    expect(handle.reason).toBe('human pressed stop');
    expect(handle.signal.aborted).toBe(true);
    expect(() => handle.throwIfCancelled()).toThrow(CancellationError);
  });

  it('refuses to double-cancel', () => {
    const registry = new CancellationRegistry();
    registry.create('run-1');
    expect(registry.cancel('run-1', 'first')).toBe(true);
    expect(registry.cancel('run-1', 'second')).toBe(false);
  });

  it('cancels a stale handle when a key is reused', () => {
    const registry = new CancellationRegistry();
    const first = registry.create('run-1');
    registry.create('run-1');
    // The old handle must not be left live and unreachable.
    expect(first.cancelled).toBe(true);
  });
});

describe('withRetry', () => {
  it('retries transient failures and eventually succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ECONNRESET');
        return 'ok';
      },
      { attempts: 5, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error('still broken');
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('still broken');
    expect(attempts).toBe(3);
  });

  it('never retries a cancellation', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new CancellationError('stopped');
        },
        { attempts: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(CancellationError);
    expect(attempts).toBe(1);
  });

  it('stops immediately when isRetryable says no', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error('bad request');
        },
        { attempts: 5, baseDelayMs: 1, isRetryable: () => false },
      ),
    ).rejects.toThrow('bad request');
    expect(attempts).toBe(1);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit then refuses within the window', () => {
    const limiter = new RateLimiter(3, 1000);
    const now = 1_000_000;
    expect(limiter.tryConsume('a', now)).toBe(true);
    expect(limiter.tryConsume('a', now)).toBe(true);
    expect(limiter.tryConsume('a', now)).toBe(true);
    expect(limiter.tryConsume('a', now)).toBe(false);
    // Budgets are per key.
    expect(limiter.tryConsume('b', now)).toBe(true);
    // And reset once the window rolls over.
    expect(limiter.tryConsume('a', now + 1001)).toBe(true);
  });
});

describe('withTimeout', () => {
  it('rejects when the promise does not settle in time', async () => {
    await expect(withTimeout(sleep(500), 20, 'slow thing')).rejects.toThrow(/timed out after 20ms/);
  });

  it('passes a fast result straight through', async () => {
    await expect(withTimeout(Promise.resolve(7), 500, 'fast thing')).resolves.toBe(7);
  });
});

describe('task locking', () => {
  it('lets exactly one claimant win a contested task', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;

    const task = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Contested task',
      description: '',
      createdBy: { type: 'user', id: user.id, name: user.displayName },
    });

    const now = Date.now();
    const winners = ['a', 'b', 'c', 'd', 'e']
      .map((holder) => app.repos.tasks.claim(task.id, holder, now, 60_000))
      .filter((t) => t !== null);

    expect(winners).toHaveLength(1);
    expect(app.repos.tasks.byId(task.id)!.status).toBe('in_progress');
  });

  it('lets a second claimant in once the lock has expired', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;

    const task = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Abandoned task',
      description: '',
      createdBy: { type: 'user', id: user.id, name: user.displayName },
    });

    const now = Date.now();
    expect(app.repos.tasks.claim(task.id, 'first', now, 1000)).not.toBeNull();
    // Still held.
    expect(app.repos.tasks.claim(task.id, 'second', now + 500, 1000)).toBeNull();

    // Put the task back in a claimable state, as the recovery sweep does, and
    // verify the expired lock no longer blocks a new holder.
    app.workspaces.mutateTask(task.id, () => ({ status: 'assigned' }));
    expect(app.repos.tasks.claim(task.id, 'second', now + 2000, 1000)).not.toBeNull();
    expect(app.repos.tasks.byId(task.id)!.lockedBy).toBe('second');
  });

  it('refuses a version-conflicting update rather than clobbering', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;

    const task = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Racy task',
      description: '',
      createdBy: { type: 'user', id: user.id, name: user.displayName },
    });

    const staleVersion = task.version;
    app.repos.tasks.update(task.id, staleVersion, { title: 'Winner' });

    expect(() => app.repos.tasks.update(task.id, staleVersion, { title: 'Loser' })).toThrow(
      /changed underneath/,
    );
    expect(app.repos.tasks.byId(task.id)!.title).toBe('Winner');
  });

  it('retries a conflicting mutation through mutateTask', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;

    const task = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Concurrent edits',
      description: '',
      createdBy: { type: 'user', id: user.id, name: user.displayName },
    });

    // Interleave a competing write on the first mutate attempt; mutateTask must
    // re-read and succeed rather than throwing.
    let interfered = false;
    const updated = app.workspaces.mutateTask(task.id, (current) => {
      if (!interfered) {
        interfered = true;
        app.repos.tasks.update(task.id, current.version, { priority: 'urgent' });
      }
      return { description: 'applied after retry' };
    });

    expect(updated.description).toBe('applied after retry');
    expect(updated.priority).toBe('urgent');
  });
});

describe('duplicate execution prevention', () => {
  it('creates only one run for the same task, agent and attempt', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;

    const orchestrator = harness.agentWithRole('Orchestrator');
    const task = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Only once',
      description: '',
      createdBy: { type: 'user', id: user.id, name: user.displayName },
    });

    const request = {
      workspaceId: workspace.id,
      agentId: orchestrator.id,
      taskId: task.id,
      objectiveId: task.objectiveId,
      depth: 0,
      trigger: { type: 'user' as const, id: user.id },
    };

    const first = app.runtime.createRun(request);
    const second = app.runtime.createRun(request);
    const third = app.runtime.createRun(request);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();

    // A retry is a different attempt and is allowed.
    expect(app.runtime.createRun({ ...request, attempt: 2 })).not.toBeNull();
  });
});
