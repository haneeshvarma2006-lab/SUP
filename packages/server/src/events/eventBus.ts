import {
  ID_PREFIXES,
  newId,
  type EventDraft,
  type EventType,
  type WorkspaceEvent,
} from '@sup/shared';
import type { DbHandle } from '../db/index.js';
import type { Repositories } from '../db/repos/index.js';
import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';

export type EventHandler = (event: WorkspaceEvent) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

/**
 * The single publication point for workspace state changes.
 *
 * Guarantees:
 *  - Every published event is durably written with a gap-free, monotonically
 *    increasing per-workspace `seq` before any subscriber sees it.
 *  - Subscribers are invoked in strict `seq` order, even when a handler
 *    publishes further events re-entrantly. Re-entrant publishes are queued
 *    behind the current drain rather than interleaving.
 *  - A throwing subscriber is logged and skipped; it cannot stall the stream or
 *    roll back the write.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly globalHandlers = new Set<EventHandler>();
  private readonly outbox: WorkspaceEvent[] = [];
  private draining = false;
  private eventsSincePrune = 0;

  constructor(
    private readonly handle: DbHandle,
    private readonly repos: Repositories,
    private readonly logger: Logger,
    private readonly retention: number,
  ) {}

  subscribe(workspaceId: string, handler: EventHandler): Subscription {
    let set = this.handlers.get(workspaceId);
    if (!set) {
      set = new Set();
      this.handlers.set(workspaceId, set);
    }
    set.add(handler);
    return {
      unsubscribe: () => {
        set!.delete(handler);
        if (set!.size === 0) this.handlers.delete(workspaceId);
      },
    };
  }

  /** Receives every event in every workspace — used by the agent scheduler. */
  subscribeAll(handler: EventHandler): Subscription {
    this.globalHandlers.add(handler);
    return { unsubscribe: () => this.globalHandlers.delete(handler) };
  }

  /**
   * Persists and dispatches an event. Returns the stored event including its
   * assigned sequence number.
   */
  publish<T extends EventType>(workspaceId: string, draft: EventDraft<T>): WorkspaceEvent<T> {
    const now = Date.now();
    const stored = this.handle.tx((): WorkspaceEvent => {
      return this.repos.events.appendInTransaction(workspaceId, {
        id: newId(ID_PREFIXES.event, now),
        workspaceId,
        type: draft.type,
        actor: draft.actor,
        payload: draft.payload,
        runId: draft.runId ?? null,
        taskId: draft.taskId ?? null,
        objectiveId: draft.objectiveId ?? null,
        createdAt: now,
      });
    });

    this.outbox.push(stored);
    this.drain();
    this.maybePrune(workspaceId);
    return stored as WorkspaceEvent<T>;
  }

  /**
   * Publishes several events as one atomic batch. Either all of them get a
   * sequence number or none do — used where a partial write would leave clients
   * with an inconsistent view (e.g. a plan and its tasks).
   */
  publishBatch(workspaceId: string, drafts: EventDraft[]): WorkspaceEvent[] {
    if (drafts.length === 0) return [];
    const now = Date.now();
    const stored = this.handle.tx((): WorkspaceEvent[] =>
      drafts.map((draft) =>
        this.repos.events.appendInTransaction(workspaceId, {
          id: newId(ID_PREFIXES.event, now),
          workspaceId,
          type: draft.type,
          actor: draft.actor,
          payload: draft.payload,
          runId: draft.runId ?? null,
          taskId: draft.taskId ?? null,
          objectiveId: draft.objectiveId ?? null,
          createdAt: now,
        }),
      ),
    );

    this.outbox.push(...stored);
    this.drain();
    this.maybePrune(workspaceId);
    return stored;
  }

  /**
   * Delivers queued events one at a time. The `draining` guard is what makes
   * re-entrant publishes safe: a handler that publishes appends to the outbox
   * and returns, and its event is delivered after the current one completes.
   */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0) {
        const event = this.outbox.shift()!;
        const targets = this.handlers.get(event.workspaceId);
        if (targets) {
          for (const handler of [...targets]) this.invoke(handler, event);
        }
        for (const handler of [...this.globalHandlers]) this.invoke(handler, event);
      }
    } finally {
      this.draining = false;
    }
  }

  private invoke(handler: EventHandler, event: WorkspaceEvent): void {
    try {
      const result = handler(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          this.logger.error('event handler rejected', {
            type: event.type,
            seq: event.seq,
            error: errorMessage(err),
          });
        });
      }
    } catch (err) {
      this.logger.error('event handler threw', {
        type: event.type,
        seq: event.seq,
        error: errorMessage(err),
      });
    }
  }

  /** Keeps the replay log bounded without doing IO on every publish. */
  private maybePrune(workspaceId: string): void {
    this.eventsSincePrune += 1;
    if (this.eventsSincePrune < 500) return;
    this.eventsSincePrune = 0;
    try {
      const removed = this.repos.events.prune(workspaceId, this.retention);
      if (removed > 0) {
        this.logger.debug('pruned event log', { workspaceId, removed });
      }
    } catch (err) {
      this.logger.warn('event log prune failed', { error: errorMessage(err) });
    }
  }

  /** Replay window for a reconnecting client. */
  replay(workspaceId: string, fromSeqExclusive: number, limit = 500): WorkspaceEvent[] {
    return this.repos.events.range(workspaceId, fromSeqExclusive, limit);
  }

  currentSeq(workspaceId: string): number {
    return this.repos.events.currentSeq(workspaceId);
  }

  oldestRetainedSeq(workspaceId: string): number {
    return this.repos.events.oldestSeq(workspaceId);
  }

  /**
   * Resolves once an event matching `predicate` is published, or rejects on
   * timeout. This is how the orchestrator waits for delegated work to finish
   * without polling.
   */
  waitFor(
    workspaceId: string,
    predicate: (event: WorkspaceEvent) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceEvent> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription.unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        fn();
      };

      const onAbort = () => finish(() => reject(new Error('aborted')));
      const timer = setTimeout(
        () => finish(() => reject(new Error(`timed out after ${timeoutMs}ms`))),
        timeoutMs,
      );
      // Do not hold the process open purely to wait for an event.
      if (typeof timer.unref === 'function') timer.unref();

      const subscription = this.subscribe(workspaceId, (event) => {
        if (predicate(event)) finish(() => resolve(event));
      });

      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
