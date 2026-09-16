import type { Message, Task, WorkspaceEvent } from '@sup/shared';
import type { Repositories } from '../db/repos/index.js';
import type { EventBus } from '../events/eventBus.js';
import type { AgentScheduler } from '../agents/scheduler.js';
import type { OrchestrationService } from './orchestrationService.js';
import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';

/**
 * Turns events into follow-on work.
 *
 * Everything reactive in the system lives here rather than being scattered
 * through the services that publish events: when a task completes, dependents
 * unblock; when a human @mentions an agent, that agent starts.
 *
 * The one rule that keeps this from looping: reactions are only triggered by
 * *human* actions and by task terminal states. An agent's own message never
 * causes another agent to start — that path goes through delegation, which is
 * budgeted and cycle-checked.
 */
export class EventReactor {
  private subscription: { unsubscribe(): void } | null = null;

  constructor(
    private readonly events: EventBus,
    private readonly repos: Repositories,
    private readonly scheduler: AgentScheduler,
    private readonly orchestration: OrchestrationService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.subscription) return;
    this.subscription = this.events.subscribeAll((event) => this.handle(event));
  }

  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  private handle(event: WorkspaceEvent): void {
    try {
      switch (event.type) {
        case 'TASK_COMPLETED':
          this.onTaskSettled(event, (event.payload as { task: Task }).task);
          return;
        case 'TASK_FAILED':
        case 'TASK_CANCELLED':
          this.onTaskSettled(event, (event.payload as { task: Task }).task, false);
          return;
        case 'MESSAGE_CREATED':
          this.onMessage(event, (event.payload as { message: Message }).message);
          return;
        case 'TASK_ASSIGNED':
          // A newly assigned task may be immediately runnable.
          this.scheduler.dispatchReady(event.workspaceId);
          return;
        default:
          return;
      }
    } catch (err) {
      this.logger.error('reactor failed to handle event', {
        type: event.type,
        seq: event.seq,
        error: errorMessage(err),
      });
    }
  }

  private onTaskSettled(event: WorkspaceEvent, task: Task, unblock = true): void {
    if (unblock) {
      this.scheduler.unblockDependents(event.workspaceId, task.id);
    } else {
      // A failed dependency will never be satisfied. Mark anything waiting on
      // it as blocked with a reason rather than leaving it silently stuck.
      this.blockOrphanedDependents(event.workspaceId, task);
    }
    this.orchestration.maybeCompleteObjective(event.workspaceId, task.objectiveId);
  }

  private blockOrphanedDependents(workspaceId: string, failed: Task): void {
    const dependents = this.repos.tasks
      .listForWorkspace(workspaceId, 300)
      .filter(
        (t) =>
          t.dependsOn.includes(failed.id) &&
          !['completed', 'failed', 'cancelled'].includes(t.status),
      );

    for (const dependent of dependents) {
      this.events.publish(workspaceId, {
        type: 'TASK_BLOCKED',
        actor: { type: 'system', id: 'system', name: 'System' },
        payload: {
          task: dependent,
          reason: `Depends on "${failed.title}", which ended as ${failed.status}`,
        } as never,
        taskId: dependent.id,
        objectiveId: dependent.objectiveId,
      });
    }
  }

  /**
   * A human mentioning an agent starts that agent.
   *
   * Only human-authored messages trigger this. An agent mentioning another
   * agent in chat is just conversation; work is handed over through
   * delegate_task, which is subject to the delegation budget and cycle checks.
   */
  private onMessage(event: WorkspaceEvent, message: Message): void {
    if (message.author.type !== 'user') return;
    if (message.kind === 'feedback') return;

    const mentionedAgents = message.mentions.filter((m) => m.type === 'agent');
    if (mentionedAgents.length === 0) return;

    const author = this.repos.users.byId(message.author.id);
    if (!author) return;

    for (const mention of mentionedAgents) {
      const agent = this.repos.agents.byId(mention.id);
      if (!agent || agent.workspaceId !== event.workspaceId) continue;
      if (!agent.enabled || agent.paused) {
        this.logger.debug('mention ignored: agent unavailable', { agent: agent.name });
        continue;
      }

      try {
        this.orchestration.mentionAgent({
          workspaceId: event.workspaceId,
          agentId: agent.id,
          instruction: message.body,
          by: author,
        });
      } catch (err) {
        this.logger.warn('failed to start mentioned agent', {
          agent: agent.name,
          error: errorMessage(err),
        });
      }
    }
  }
}
