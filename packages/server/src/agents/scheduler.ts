import { TERMINAL_TASK_STATUSES, truncate, type ActorRef, type AgentRun, type Task } from '@sup/shared';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repos/index.js';
import type { EventBus } from '../events/eventBus.js';
import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';
import { KeyedSemaphore, Semaphore } from '../concurrency/semaphore.js';
import { CancellationRegistry } from '../concurrency/cancellation.js';
import type { BlockingControl } from '../tools/types.js';
import { AgentRuntime, type RunOutcome, type RunRequest } from './runtime.js';
import type { AgentStatusManager } from './statusManager.js';
import type { WorkspaceService } from '../workspace/workspaceService.js';

/**
 * Decides what runs, when, and how many at once.
 *
 * Concurrency is bounded at three levels — process-wide, per workspace, and per
 * agent — so one busy workspace cannot starve another and a single agent cannot
 * be handed more work than it is configured to take.
 *
 * Tasks are claimed with an atomic compare-and-swap in the database, so several
 * dispatch passes racing on the same ready task produce exactly one run. Locks
 * carry an expiry, and expired locks are reclaimed, so a crashed process does
 * not strand work forever.
 */
export class AgentScheduler {
  private readonly global: Semaphore;
  private readonly perWorkspace: KeyedSemaphore;
  private readonly perAgent: KeyedSemaphore;
  private readonly inFlight = new Map<string, Promise<RunOutcome>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly repos: Repositories,
    private readonly workspaces: WorkspaceService,
    private readonly events: EventBus,
    private readonly status: AgentStatusManager,
    private readonly cancellations: CancellationRegistry,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.global = new Semaphore(config.limits.globalRunConcurrency);
    this.perWorkspace = new KeyedSemaphore((workspaceId) => {
      const workspace = this.repos.workspaces.byId(workspaceId);
      return workspace?.settings.maxConcurrentAgentRuns ?? 4;
    });
    this.perAgent = new KeyedSemaphore((agentId) => {
      const agent = this.repos.agents.byId(agentId);
      return agent?.maxConcurrency ?? 1;
    });
  }

  // -- lifecycle ------------------------------------------------------------

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((err: unknown) =>
        this.logger.error('scheduler sweep failed', { error: errorMessage(err) }),
      );
    }, 15_000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    // Let in-flight runs finish rather than orphaning their database rows.
    await Promise.allSettled([...this.inFlight.values()]);
  }

  get activeRunCount(): number {
    return this.inFlight.size;
  }

  // -- running --------------------------------------------------------------

  /**
   * Starts a run and resolves when it finishes.
   *
   * Returns null when the run was not created — either it already exists
   * (duplicate suppression) or the agent is unavailable.
   */
  async run(request: RunRequest): Promise<RunOutcome | null> {
    if (this.stopped) return null;

    const agent = this.repos.agents.byId(request.agentId);
    if (!agent) return null;
    if (!agent.enabled) {
      this.logger.debug('skipping disabled agent', { agent: agent.name });
      return null;
    }
    if (agent.paused) {
      this.logger.debug('skipping paused agent', { agent: agent.name });
      return null;
    }

    const run = this.runtime.createRun(request);
    if (!run) {
      // The idempotency key collided: this exact work is already running.
      this.logger.debug('duplicate run suppressed', {
        agentId: request.agentId,
        taskId: request.taskId,
      });
      return null;
    }

    const execution = this.executeWithSlots(request, run);
    this.inFlight.set(run.id, execution);
    try {
      return await execution;
    } finally {
      this.inFlight.delete(run.id);
    }
  }

  /** Fire-and-forget variant for callers that must not block (HTTP handlers). */
  runDetached(request: RunRequest): void {
    void this.run(request).catch((err: unknown) =>
      this.logger.error('detached run failed', {
        agentId: request.agentId,
        taskId: request.taskId,
        error: errorMessage(err),
      }),
    );
  }

  private async executeWithSlots(request: RunRequest, run: AgentRun): Promise<RunOutcome> {
    const lanes = [
      this.global,
      this.perWorkspace.for(request.workspaceId),
      this.perAgent.for(request.agentId),
    ];

    /**
     * Slots are always acquired in the same order (global, workspace, agent)
     * and released in reverse. A consistent order across every caller is what
     * keeps three nested semaphores from deadlocking against each other.
     */
    const acquireAll = async (): Promise<Array<() => void>> => {
      const releases: Array<() => void> = [];
      try {
        for (const lane of lanes) releases.push(await lane.acquire());
        return releases;
      } catch (err) {
        for (const release of releases.reverse()) release();
        throw err;
      }
    };

    // A holder, so `whileBlocked` can swap the releases out and the `finally`
    // below always sees the ones currently held.
    let held: Array<() => void> | null = await acquireAll();

    const releaseAll = () => {
      if (!held) return;
      for (const release of [...held].reverse()) release();
      held = null;
    };

    /**
     * While a run blocks on a delegated child or on a human, it hands its slots
     * back. Without this an orchestrator waiting on a researcher would occupy
     * the very capacity the researcher needs in order to start.
     */
    const blocking: BlockingControl = {
      whileBlocked: async <T>(fn: () => Promise<T>): Promise<T> => {
        releaseAll();
        try {
          return await fn();
        } finally {
          held = await acquireAll();
        }
      },
    };

    try {
      return await this.runtime.execute({ ...request, blocking }, run);
    } finally {
      releaseAll();
    }
  }

  // -- dispatch -------------------------------------------------------------

  /**
   * Claims and starts every task in a workspace that is ready to run.
   *
   * Claiming is the compare-and-swap in TaskRepo.claim; a task whose claim
   * fails was taken by someone else and is simply skipped.
   */
  dispatchReady(workspaceId: string): number {
    if (this.stopped) return 0;

    const ready = this.repos.tasks.findRunnable(workspaceId, 25);
    let started = 0;

    for (const task of ready) {
      if (!task.assignee || task.assignee.type !== 'agent') continue;

      const agent = this.repos.agents.byId(task.assignee.id);
      if (!agent || !agent.enabled || agent.paused) continue;

      const claimed = this.repos.tasks.claim(
        task.id,
        `agent:${agent.id}`,
        Date.now(),
        this.config.limits.taskLockTtlMs,
      );
      if (!claimed) continue;

      this.events.publish(workspaceId, {
        type: 'TASK_STARTED',
        actor: { type: 'agent', id: agent.id, name: agent.name },
        payload: { task: claimed, runId: '' } as never,
        taskId: claimed.id,
        objectiveId: claimed.objectiveId,
      });

      this.runDetached({
        workspaceId,
        agentId: agent.id,
        taskId: claimed.id,
        objectiveId: claimed.objectiveId,
        depth: claimed.depth,
        trigger: claimed.createdBy,
      });
      started += 1;
    }

    return started;
  }

  /** Re-evaluates tasks that were blocked once their dependencies complete. */
  unblockDependents(workspaceId: string, completedTaskId: string): void {
    const candidates = this.repos.tasks
      .listForWorkspace(workspaceId, 300)
      .filter((t) => t.dependsOn.includes(completedTaskId) && t.status === 'blocked');

    for (const task of candidates) {
      if (!this.repos.tasks.dependenciesSatisfied(task)) continue;
      try {
        this.workspaces.mutateTask(task.id, (current) =>
          current.status === 'blocked' ? { status: 'assigned', error: null } : null,
        );
      } catch (err) {
        this.logger.warn('failed to unblock task', { taskId: task.id, error: errorMessage(err) });
      }
    }

    this.dispatchReady(workspaceId);
  }

  // -- cancellation ---------------------------------------------------------

  /** Cancels every run belonging to an agent. Returns how many were stopped. */
  cancelAgent(agentId: string, by: ActorRef, reason: string): number {
    const active = this.repos.runs
      .listForAgent(agentId, 50)
      .filter((r) => r.status === 'running' || r.status === 'queued');

    let cancelled = 0;
    for (const run of active) {
      if (this.cancellations.cancel(run.id, reason)) cancelled += 1;
    }

    const agent = this.repos.agents.byId(agentId);
    if (agent && cancelled > 0) {
      this.events.publish(agent.workspaceId, {
        type: 'AGENT_CANCELLED',
        actor: by,
        payload: { agentId, runId: null, by, reason } as never,
      });
    }
    return cancelled;
  }

  cancelRun(runId: string, reason: string): boolean {
    return this.cancellations.cancel(runId, reason);
  }

  /** Cancels everything serving an objective. */
  cancelObjective(objectiveId: string, by: ActorRef, reason: string): number {
    const runs = this.repos.runs
      .listForObjective(objectiveId)
      .filter((r) => r.status === 'running' || r.status === 'queued');
    let cancelled = 0;
    for (const run of runs) {
      if (this.cancellations.cancel(run.id, reason)) cancelled += 1;
    }
    void by;
    return cancelled;
  }

  // -- recovery -------------------------------------------------------------

  /**
   * Periodic maintenance: reclaim expired task locks, expire stale approval
   * requests, and dispatch anything that became ready while nothing was
   * listening.
   */
  private async sweep(): Promise<void> {
    const now = Date.now();

    for (const task of this.repos.tasks.findStaleLocks(now, 50)) {
      // The lock expired but no run is live for it — the holder died.
      const stillRunning = [...this.inFlight.keys()].some((runId) => {
        const run = this.repos.runs.byId(runId, false);
        return run?.taskId === task.id;
      });
      if (stillRunning) {
        this.repos.tasks.renewLock(
          task.id,
          task.lockedBy ?? '',
          now,
          this.config.limits.taskLockTtlMs,
        );
        continue;
      }

      this.logger.warn('reclaiming stale task lock', { taskId: task.id, title: truncate(task.title, 60) });
      try {
        this.workspaces.mutateTask(task.id, (current) =>
          TERMINAL_TASK_STATUSES.includes(current.status)
            ? null
            : {
                status: 'assigned',
                lockedBy: null,
                lockExpiresAt: null,
                error: 'Recovered after the previous attempt stopped responding',
              },
        );
      } catch (err) {
        this.logger.warn('lock reclaim failed', { taskId: task.id, error: errorMessage(err) });
      }
    }

    this.workspaces.expireApprovals();

    for (const workspace of this.repos.workspaces.listAll()) {
      this.dispatchReady(workspace.id);
    }
  }

  /** Called once at boot to clean up state left by a previous process. */
  recoverAfterRestart(): void {
    const runs = this.repos.runs.failOrphaned('Server restarted while this run was in flight');
    const locks = this.repos.tasks.clearAllLocks();
    const agents = this.repos.agents.resetTransientState();
    if (runs || locks || agents) {
      this.logger.info('recovered state from previous process', { runs, locks, agents });
    }

    // Tasks left mid-flight go back to the ready queue rather than staying
    // 'in_progress' with nothing executing them.
    for (const workspace of this.repos.workspaces.listAll()) {
      for (const task of this.repos.tasks.listForWorkspace(workspace.id, 500)) {
        if (task.status !== 'in_progress') continue;
        try {
          this.workspaces.mutateTask(task.id, () => ({
            status: 'assigned',
            lockedBy: null,
            lockExpiresAt: null,
          }));
        } catch {
          // Best effort: a task we cannot recover is picked up by the sweep.
        }
      }
    }
  }

  stats(): { global: number; queued: number; inFlight: number } {
    return {
      global: this.global.inUse,
      queued: this.global.queued,
      inFlight: this.inFlight.size,
    };
  }
}

export type { Task };
