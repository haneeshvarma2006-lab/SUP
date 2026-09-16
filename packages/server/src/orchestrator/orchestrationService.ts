import {
  MAIN_CHANNEL,
  TERMINAL_TASK_STATUSES,
  taskChannel,
  truncate,
  type ActorRef,
  type DelegationEdge,
  type Task,
  type User,
  type WorkspaceEvent,
} from '@sup/shared';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repos/index.js';
import type { EventBus } from '../events/eventBus.js';
import type { Logger } from '../util/logger.js';
import { CancellationError, badRequest, errorMessage, notFound } from '../util/errors.js';
import { RateLimiter } from '../concurrency/retry.js';
import type { WorkspaceService } from '../workspace/workspaceService.js';
import type { AgentScheduler } from '../agents/scheduler.js';
import type { AgentStatusManager } from '../agents/statusManager.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { CodeSandbox } from '../tools/sandbox.js';
import type { WebSearchService } from '../tools/webSearch.js';
import type { ToolContext, ToolServices } from '../tools/types.js';
import { DelegationGuard } from './delegationGuard.js';

/**
 * The coordination layer between agents.
 *
 * It implements every capability a tool needs that touches more than one agent:
 * delegation, inter-agent messaging, asking a human, and approval gating. Tools
 * hold a reference to this interface rather than to the scheduler or the
 * runtime, which keeps the dependency graph acyclic and makes each of these
 * behaviours independently testable.
 */
export class OrchestrationService implements ToolServices {
  private readonly guard: DelegationGuard;
  private readonly messageLimiter: RateLimiter;
  /** Set after construction; the scheduler needs this service and vice versa. */
  private scheduler: AgentScheduler | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly workspaces: WorkspaceService,
    private readonly events: EventBus,
    private readonly memory: MemoryService,
    private readonly status: AgentStatusManager,
    private readonly sandbox: CodeSandbox,
    private readonly search: WebSearchService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.guard = new DelegationGuard(repos);
    this.messageLimiter = new RateLimiter(config.limits.agentMessageRatePerMinute, 60_000);
  }

  attachScheduler(scheduler: AgentScheduler): void {
    this.scheduler = scheduler;
  }

  private requireScheduler(): AgentScheduler {
    if (!this.scheduler) throw new Error('OrchestrationService.attachScheduler was never called');
    return this.scheduler;
  }

  // -- objectives -----------------------------------------------------------

  /**
   * Turns a human request into a running objective.
   *
   * The root task is assigned to the workspace orchestrator, which plans and
   * delegates. Everything produced under it shares the root task's id as its
   * `objectiveId`, which is what ties the delegation graph, the event stream
   * and the budget counters together.
   */
  startObjective(input: {
    workspaceId: string;
    title: string;
    description: string;
    requestedBy: User;
    requiresHumanApproval?: boolean;
  }): { task: Task; orchestratorId: string } {
    const workspace = this.workspaces.requireWorkspace(input.workspaceId);
    const orchestrator = this.repos.agents.orchestratorFor(workspace.id);
    if (!orchestrator) {
      throw badRequest(
        'This workspace has no orchestrator. Create an agent with the orchestrator role first.',
      );
    }
    if (!orchestrator.enabled || orchestrator.paused) {
      throw badRequest(`${orchestrator.name} is ${orchestrator.paused ? 'paused' : 'disabled'}`);
    }

    const actor: ActorRef = { type: 'user', id: input.requestedBy.id, name: input.requestedBy.displayName };

    const task = this.workspaces.createTask({
      workspaceId: workspace.id,
      title: input.title,
      description: input.description,
      createdBy: actor,
      assignee: { type: 'agent', id: orchestrator.id, name: orchestrator.name },
      priority: 'high',
      depth: 0,
      requiresHumanApproval: input.requiresHumanApproval ?? false,
    });

    this.events.publish(workspace.id, {
      type: 'OBJECTIVE_STARTED',
      actor,
      payload: { objectiveId: task.id, title: task.title, requestedBy: actor } as never,
      taskId: task.id,
      objectiveId: task.id,
    });

    // Claim before dispatch so the periodic sweep cannot also pick it up.
    const claimed = this.repos.tasks.claim(
      task.id,
      `agent:${orchestrator.id}`,
      Date.now(),
      this.config.limits.taskLockTtlMs,
    );

    this.requireScheduler().runDetached({
      workspaceId: workspace.id,
      agentId: orchestrator.id,
      taskId: (claimed ?? task).id,
      objectiveId: task.id,
      depth: 0,
      trigger: actor,
    });

    return { task, orchestratorId: orchestrator.id };
  }

  /** Publishes the objective-complete event once every task under it settles. */
  maybeCompleteObjective(workspaceId: string, objectiveId: string): void {
    const root = this.repos.tasks.byId(objectiveId);
    if (!root) return;
    if (!TERMINAL_TASK_STATUSES.includes(root.status)) return;
    if (!this.repos.tasks.objectiveSettled(objectiveId)) return;

    const tasks = this.repos.tasks.listForObjective(objectiveId);
    const artifactIds = [...new Set(tasks.flatMap((t) => t.artifactIds))];

    this.events.publish(workspaceId, {
      type: 'OBJECTIVE_COMPLETED',
      actor: { type: 'system', id: 'system', name: 'System' },
      payload: {
        objectiveId,
        title: root.title,
        summary: root.result ?? root.error ?? 'Objective finished',
        rootTaskId: root.id,
        artifactIds,
      } as never,
      taskId: root.id,
      objectiveId,
    });
  }

  // -- ToolServices: tasks --------------------------------------------------

  createTask(input: Parameters<ToolServices['createTask']>[0]): Task {
    return this.workspaces.createTask(input);
  }

  assignTask(input: Parameters<ToolServices['assignTask']>[0]): Task {
    return this.workspaces.assignTask(input);
  }

  updateTask(input: Parameters<ToolServices['updateTask']>[0]): Task {
    return this.workspaces.updateTask(input);
  }

  // -- ToolServices: delegation --------------------------------------------

  async delegateAndWait(input: {
    ctx: ToolContext;
    toAgentId: string;
    title: string;
    description: string;
    dependsOn: string[];
    relation: 'delegate' | 'review' | 'ask';
    priority?: Task['priority'];
  }): Promise<{ taskId: string; ok: boolean; result: string; error: string | null }> {
    const { ctx } = input;

    const verdict = this.guard.check({
      workspace: ctx.workspace,
      objectiveId: ctx.objectiveId,
      fromAgentId: ctx.agent.id,
      toAgentId: input.toAgentId,
      depth: ctx.depth,
      title: input.title,
    });
    if (!verdict.allowed) {
      return { taskId: '', ok: false, result: '', error: verdict.reason };
    }

    const target = this.repos.agents.byId(input.toAgentId);
    if (!target) return { taskId: '', ok: false, result: '', error: 'That agent no longer exists' };
    if (!target.enabled || target.paused) {
      return {
        taskId: '',
        ok: false,
        result: '',
        error: `${target.name} is currently ${target.paused ? 'paused' : 'disabled'} and cannot take work`,
      };
    }

    const childTask = this.workspaces.createTask({
      workspaceId: ctx.workspace.id,
      title: input.title,
      description: input.description,
      createdBy: ctx.actor,
      assignee: { type: 'agent', id: target.id, name: target.name },
      parentTaskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
      dependsOn: input.dependsOn,
      depth: ctx.depth + 1,
      priority: input.priority ?? 'normal',
    });

    const edge = this.workspaces.recordDelegation({
      workspaceId: ctx.workspace.id,
      objectiveId: ctx.objectiveId,
      fromAgentId: ctx.agent.id,
      toAgentId: target.id,
      taskId: childTask.id,
      relation: input.relation,
      note: input.title,
      depth: ctx.depth + 1,
    });

    this.repos.agents.bumpStat(ctx.agent.id, 'delegationsMade');

    this.events.publish(ctx.workspace.id, {
      type: 'TASK_DELEGATED',
      actor: ctx.actor,
      payload: { task: childTask, edge } as never,
      taskId: childTask.id,
      runId: ctx.run.id,
      objectiveId: ctx.objectiveId,
    });

    // The edge was recorded above; pass it through rather than letting
    // postAgentMessage create a second one for the same delegation.
    this.postAgentMessage({
      ctx,
      channel: taskChannel(childTask.id),
      body: this.delegationMessage(input.relation, target.name, input.title, input.description),
      recipient: { type: 'agent', id: target.id, name: target.name },
      kind: 'agent_to_agent',
      existingEdge: edge,
    });

    this.status.set(ctx.agent, 'delegating', `Handing "${truncate(input.title, 50)}" to ${target.name}`, {
      taskId: ctx.task?.id ?? null,
      runId: ctx.run.id,
    });

    try {
      const finished = await ctx.blocking.whileBlocked(async () => {
        this.status.set(ctx.agent, 'waiting', `Waiting on ${target.name}`, {
          taskId: ctx.task?.id ?? null,
          runId: ctx.run.id,
        });
        return this.awaitTaskCompletion(ctx, childTask);
      });

      this.status.set(ctx.agent, 'working', `Got ${target.name}'s result`, {
        taskId: ctx.task?.id ?? null,
        runId: ctx.run.id,
      });

      // Record the return edge so the UI can draw the round trip, not just the
      // outbound half.
      this.workspaces.recordDelegation({
        workspaceId: ctx.workspace.id,
        objectiveId: ctx.objectiveId,
        fromAgentId: target.id,
        toAgentId: ctx.agent.id,
        taskId: childTask.id,
        relation: 'result',
        note: finished.status === 'completed' ? 'Returned result' : `Ended ${finished.status}`,
        depth: ctx.depth + 1,
      });

      if (finished.status === 'completed') {
        return {
          taskId: childTask.id,
          ok: true,
          result: finished.result ?? '',
          error: null,
        };
      }
      return {
        taskId: childTask.id,
        ok: false,
        result: '',
        error: finished.error ?? `The delegated task ended as ${finished.status}`,
      };
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      return {
        taskId: childTask.id,
        ok: false,
        result: '',
        error: errorMessage(err),
      };
    }
  }

  /**
   * Runs a delegated task and waits for it to settle.
   *
   * If this caller wins the claim it executes the child directly; if another
   * dispatcher already took it, this falls back to waiting on the task's
   * terminal event. Either way exactly one execution happens.
   */
  private async awaitTaskCompletion(ctx: ToolContext, childTask: Task): Promise<Task> {
    const scheduler = this.requireScheduler();
    const target = childTask.assignee!;

    const dependenciesMet = this.repos.tasks.dependenciesSatisfied(childTask);

    if (dependenciesMet) {
      const claimed = this.repos.tasks.claim(
        childTask.id,
        `agent:${target.id}`,
        Date.now(),
        this.config.limits.taskLockTtlMs,
      );

      if (claimed) {
        this.events.publish(ctx.workspace.id, {
          type: 'TASK_STARTED',
          actor: target,
          payload: { task: claimed, runId: '' } as never,
          taskId: claimed.id,
          objectiveId: claimed.objectiveId,
        });

        await scheduler.run({
          workspaceId: ctx.workspace.id,
          agentId: target.id,
          taskId: claimed.id,
          objectiveId: ctx.objectiveId,
          depth: childTask.depth,
          trigger: ctx.actor,
        });

        return this.repos.tasks.byId(childTask.id) ?? childTask;
      }
    }

    // Either the dependencies are not met yet or someone else is executing it.
    // Wait for the task to reach a terminal state.
    const terminal = new Set(['TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED']);
    const timeoutMs = this.config.limits.runTimeoutMs;

    try {
      await this.events.waitFor(
        ctx.workspace.id,
        (event: WorkspaceEvent) => terminal.has(event.type) && event.taskId === childTask.id,
        timeoutMs,
        ctx.signal,
      );
    } catch (err) {
      if (ctx.signal.aborted) throw new CancellationError();
      const current = this.repos.tasks.byId(childTask.id);
      if (current && TERMINAL_TASK_STATUSES.includes(current.status)) return current;
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for "${truncate(childTask.title, 60)}": ${errorMessage(err)}`,
      );
    }

    return this.repos.tasks.byId(childTask.id) ?? childTask;
  }

  private delegationMessage(
    relation: 'delegate' | 'review' | 'ask',
    targetName: string,
    title: string,
    description: string,
  ): string {
    const lead =
      relation === 'review'
        ? `@${targetName} please review this.`
        : relation === 'ask'
          ? `@${targetName} a question for you.`
          : `@${targetName} taking this one: **${title}**`;
    return description && description !== title
      ? `${lead}\n\n${truncate(description, 1200)}`
      : lead;
  }

  // -- ToolServices: messaging ---------------------------------------------

  postAgentMessage(input: Parameters<ToolServices['postAgentMessage']>[0]): {
    ok: boolean;
    reason?: string;
  } {
    const { ctx } = input;

    // Agents that fall into a reply loop burn their budget and get refused,
    // rather than being allowed to flood the workspace.
    if (!this.messageLimiter.tryConsume(ctx.agent.id)) {
      return {
        ok: false,
        reason: `Message rate limit reached (${this.config.limits.agentMessageRatePerMinute}/min). Consolidate what you have to say.`,
      };
    }

    const message = this.workspaces.postMessage({
      workspaceId: ctx.workspace.id,
      channel: input.channel,
      author: ctx.actor,
      recipient: input.recipient ?? null,
      kind: input.kind ?? 'agent_to_agent',
      body: input.body,
      taskId: ctx.task?.id ?? null,
      runId: ctx.run.id,
    });

    let edge: DelegationEdge | null = input.existingEdge ?? null;
    if (!edge && input.toAgentId && input.relation) {
      edge = this.workspaces.recordDelegation({
        workspaceId: ctx.workspace.id,
        objectiveId: ctx.objectiveId,
        fromAgentId: ctx.agent.id,
        toAgentId: input.toAgentId,
        taskId: ctx.task?.id ?? '',
        relation: input.relation,
        note: truncate(input.body, 200),
        depth: ctx.depth,
      });
    }

    this.events.publish(ctx.workspace.id, {
      type: 'AGENT_MESSAGE',
      actor: ctx.actor,
      payload: { message, edge } as never,
      runId: ctx.run.id,
      taskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
    });

    return { ok: true };
  }

  // -- ToolServices: human in the loop -------------------------------------

  async askHuman(input: {
    ctx: ToolContext;
    question: string;
    timeoutMs: number;
  }): Promise<{ answered: boolean; answer: string }> {
    const { ctx } = input;

    const question = this.workspaces.postMessage({
      workspaceId: ctx.workspace.id,
      channel: ctx.task ? taskChannel(ctx.task.id) : MAIN_CHANNEL,
      author: ctx.actor,
      kind: 'question',
      body: input.question,
      taskId: ctx.task?.id ?? null,
      runId: ctx.run.id,
      metadata: { awaitingHuman: true },
    });

    this.events.publish(ctx.workspace.id, {
      type: 'AGENT_QUESTION',
      actor: ctx.actor,
      payload: { message: question, agentId: ctx.agent.id, taskId: ctx.task?.id ?? null } as never,
      runId: ctx.run.id,
      taskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
    });

    this.repos.runs.setStatus(ctx.run.id, 'awaiting_human');

    try {
      const answer = await ctx.blocking.whileBlocked(async () => {
        this.status.set(ctx.agent, 'asking', 'Waiting for a human to answer', {
          taskId: ctx.task?.id ?? null,
          runId: ctx.run.id,
        });

        const event = await this.events.waitFor(
          ctx.workspace.id,
          (e: WorkspaceEvent) => {
            if (e.type !== 'MESSAGE_CREATED') return false;
            const payload = e.payload as { message: { author: ActorRef; parentId: string | null; channel: string; createdAt: number } };
            const message = payload.message;
            if (message.author.type !== 'user') return false;
            // Either an explicit reply to the question, or any human message in
            // the same channel after it was asked.
            return (
              message.parentId === question.id ||
              (message.channel === question.channel && message.createdAt > question.createdAt)
            );
          },
          input.timeoutMs,
          ctx.signal,
        );

        const payload = event.payload as { message: { body: string; author: ActorRef } };
        return payload.message.body;
      });

      this.repos.runs.setStatus(ctx.run.id, 'running');
      this.status.set(ctx.agent, 'working', 'Got an answer', {
        taskId: ctx.task?.id ?? null,
        runId: ctx.run.id,
      });
      return { answered: true, answer };
    } catch (err) {
      this.repos.runs.setStatus(ctx.run.id, 'running');
      if (ctx.signal.aborted) throw new CancellationError();
      this.logger.debug('ask_human timed out', { agent: ctx.agent.name, error: errorMessage(err) });
      return { answered: false, answer: '' };
    }
  }

  async requestApproval(input: {
    ctx: ToolContext;
    action: string;
    reason: string;
    payload: unknown;
  }): Promise<{ approved: boolean; note: string }> {
    const { ctx } = input;

    const approval = this.workspaces.createApproval({
      workspaceId: ctx.workspace.id,
      requestedBy: ctx.actor,
      runId: ctx.run.id,
      taskId: ctx.task?.id ?? null,
      action: input.action,
      reason: input.reason,
      payload: input.payload,
    });

    this.repos.runs.setStatus(ctx.run.id, 'awaiting_approval');

    try {
      const resolved = await ctx.blocking.whileBlocked(async () => {
        this.status.set(ctx.agent, 'waiting', `Waiting for approval: ${input.action}`, {
          taskId: ctx.task?.id ?? null,
          runId: ctx.run.id,
        });

        const event = await this.events.waitFor(
          ctx.workspace.id,
          (e: WorkspaceEvent) =>
            e.type === 'APPROVAL_RESOLVED' &&
            (e.payload as { approval: { id: string } }).approval.id === approval.id,
          // Outlive the approval's own TTL, so an expiry resolves this wait
          // rather than racing it.
          this.config.limits.approvalTtlMs + 5000,
          ctx.signal,
        );

        return (event.payload as { approval: { status: string; resolutionNote: string } }).approval;
      });

      this.repos.runs.setStatus(ctx.run.id, 'running');

      if (resolved.status === 'approved') {
        return { approved: true, note: resolved.resolutionNote };
      }
      return {
        approved: false,
        note: resolved.resolutionNote || `Request was ${resolved.status}`,
      };
    } catch (err) {
      this.repos.runs.setStatus(ctx.run.id, 'running');
      if (ctx.signal.aborted) throw new CancellationError();
      return { approved: false, note: `No decision was made in time (${errorMessage(err)})` };
    }
  }

  // -- ToolServices: side effects ------------------------------------------

  writeFile(input: Parameters<ToolServices['writeFile']>[0]): {
    fileId: string;
    path: string;
    version: number;
  } {
    const file = this.workspaces.writeFile({
      workspaceId: input.ctx.workspace.id,
      path: input.path,
      content: input.content,
      mimeType: input.mimeType,
      author: input.ctx.actor,
      taskId: input.ctx.task?.id ?? null,
    });
    return { fileId: file.id, path: file.path, version: file.version };
  }

  async webSearch(input: { query: string; limit: number; signal: AbortSignal }) {
    return this.search.search(input.query, input.limit, input.signal);
  }

  async executeCode(input: {
    language: string;
    source: string;
    stdin?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }) {
    return this.sandbox.execute({
      language: input.language,
      source: input.source,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  // -- direct invocation ----------------------------------------------------

  /**
   * Starts an agent on a free-form instruction, outside the task board. This is
   * what an `@mention` in chat resolves to.
   */
  mentionAgent(input: {
    workspaceId: string;
    agentId: string;
    instruction: string;
    by: User;
  }): void {
    const agent = this.repos.agents.byId(input.agentId);
    if (!agent) throw notFound('Agent');
    if (!agent.enabled) throw badRequest(`${agent.name} is disabled`);
    if (agent.paused) throw badRequest(`${agent.name} is paused`);

    const actor: ActorRef = { type: 'user', id: input.by.id, name: input.by.displayName };

    const task = this.workspaces.createTask({
      workspaceId: input.workspaceId,
      title: truncate(input.instruction, 120),
      description: input.instruction,
      createdBy: actor,
      assignee: { type: 'agent', id: agent.id, name: agent.name },
      priority: 'high',
    });

    const claimed = this.repos.tasks.claim(
      task.id,
      `agent:${agent.id}`,
      Date.now(),
      this.config.limits.taskLockTtlMs,
    );

    this.requireScheduler().runDetached({
      workspaceId: input.workspaceId,
      agentId: agent.id,
      taskId: (claimed ?? task).id,
      objectiveId: task.objectiveId,
      depth: 0,
      trigger: actor,
    });
  }

  get delegationGuard(): DelegationGuard {
    return this.guard;
  }

  get memoryService(): MemoryService {
    return this.memory;
  }
}
