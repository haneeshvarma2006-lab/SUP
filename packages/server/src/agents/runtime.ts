import {
  EMPTY_RUN_USAGE,
  ID_PREFIXES,
  MAIN_CHANNEL,
  newId,
  taskChannel,
  truncate,
  type ActorRef,
  type Agent,
  type AgentRun,
  type AgentStatus,
  type RunStep,
  type RunUsage,
  type Task,
  type Workspace,
} from '@sup/shared';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repos/index.js';
import type { EventBus } from '../events/eventBus.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { Logger } from '../util/logger.js';
import { CancellationError, errorMessage, isCancellation } from '../util/errors.js';
import { CancellationRegistry } from '../concurrency/cancellation.js';
import { isTransientHttpError, withRetry } from '../concurrency/retry.js';
import { ProviderRegistry } from '../ai/registry.js';
import {
  assistantMessage,
  collectText,
  collectToolUses,
  userMessage,
  type ContentBlock,
  type ModelMessage,
  type ToolResultBlock,
} from '../ai/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { BlockingControl, ToolContext, ToolServices } from '../tools/types.js';
import { AgentStatusManager } from './statusManager.js';
import {
  buildMemoryBlock,
  buildOpeningMessage,
  buildRoster,
  buildSystemPrompt,
  buildToolSpecs,
} from './promptBuilder.js';
import type { WorkspaceService } from '../workspace/workspaceService.js';

export interface RunRequest {
  workspaceId: string;
  agentId: string;
  taskId: string | null;
  objectiveId: string;
  depth: number;
  /** Who caused this run to start. */
  trigger: ActorRef;
  attempt?: number;
  /** Free-form instruction used when there is no task (e.g. a direct mention). */
  instruction?: string;
  blocking?: BlockingControl;
}

export interface RunOutcome {
  run: AgentRun;
  /** The deliverable, when the run produced one. */
  result: string | null;
  summary: string;
  artifactPath: string | null;
}

/** Status an agent shows while a given tool is in flight. */
const TOOL_STATUS: Record<string, AgentStatus> = {
  delegate_task: 'delegating',
  request_review: 'reviewing',
  ask_agent: 'asking',
  ask_human: 'asking',
  web_search: 'working',
  code_exec: 'working',
};

const NO_BLOCKING: BlockingControl = {
  async whileBlocked<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  },
};

/**
 * Executes one agent against one task.
 *
 * The loop is: call the model, run whatever tools it asked for, feed the
 * results back, repeat — bounded by the workspace's step limit and a wall-clock
 * timeout, and interruptible at every step boundary. `return_result` is the
 * only clean terminator; everything else ends the run as incomplete and says so.
 */
export class AgentRuntime {
  /** Set once at composition time; breaks the runtime <-> orchestration cycle. */
  private services: ToolServices | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly events: EventBus,
    private readonly workspaces: WorkspaceService,
    private readonly memory: MemoryService,
    private readonly providers: ProviderRegistry,
    private readonly tools: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly status: AgentStatusManager,
    private readonly cancellations: CancellationRegistry,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  attachServices(services: ToolServices): void {
    this.services = services;
  }

  /**
   * Starts a run, or returns null if an identical run already exists.
   *
   * The idempotency key is `(task, agent, attempt)` and is enforced by a unique
   * index, so two schedulers racing on the same ready task produce one run, not
   * two. This is the duplicate-execution guard.
   */
  createRun(request: RunRequest): AgentRun | null {
    const attempt = request.attempt ?? 1;
    const idempotencyKey = request.taskId
      ? `task:${request.taskId}:agent:${request.agentId}:attempt:${attempt}`
      : `adhoc:${newId(ID_PREFIXES.run)}`;

    const run: AgentRun = {
      id: newId(ID_PREFIXES.run),
      workspaceId: request.workspaceId,
      agentId: request.agentId,
      taskId: request.taskId,
      status: 'queued',
      depth: request.depth,
      objectiveId: request.objectiveId,
      attempt,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      result: null,
      usage: { ...EMPTY_RUN_USAGE },
      steps: [],
    };

    return this.repos.runs.insertIfAbsent(run, idempotencyKey);
  }

  async execute(request: RunRequest, run: AgentRun): Promise<RunOutcome> {
    if (!this.services) throw new Error('AgentRuntime.attachServices was never called');

    const workspace = this.workspaces.requireWorkspace(request.workspaceId);
    const agent = this.workspaces.requireAgent(request.agentId);
    const task = request.taskId ? this.repos.tasks.byId(request.taskId) : null;
    const actor: ActorRef = { type: 'agent', id: agent.id, name: agent.name };
    const blocking = request.blocking ?? NO_BLOCKING;

    const cancellation = this.cancellations.create(run.id);
    const deadline = Date.now() + this.config.limits.runTimeoutMs;

    const usage: RunUsage = { ...EMPTY_RUN_USAGE };
    const toolsUsed: string[] = [];
    let stepIndex = 0;

    this.repos.runs.setStatus(run.id, 'running');
    this.status.set(agent, 'thinking', task ? `Starting "${truncate(task.title, 60)}"` : 'Starting', {
      taskId: task?.id ?? null,
      runId: run.id,
    });

    this.events.publish(workspace.id, {
      type: 'AGENT_STARTED',
      actor,
      payload: {
        agentId: agent.id,
        runId: run.id,
        taskId: task?.id ?? null,
        objectiveId: request.objectiveId,
      } as never,
      runId: run.id,
      taskId: task?.id ?? null,
      objectiveId: request.objectiveId,
    });

    const recordStep = (
      partial: Omit<RunStep, 'id' | 'runId' | 'index' | 'createdAt'>,
    ): RunStep => {
      const step: RunStep = {
        ...partial,
        id: newId(ID_PREFIXES.step),
        runId: run.id,
        index: stepIndex++,
        createdAt: Date.now(),
      };
      this.repos.runs.appendStep(step);
      this.events.publish(workspace.id, {
        type: 'AGENT_STEP',
        actor,
        payload: { agentId: agent.id, runId: run.id, step } as never,
        runId: run.id,
        taskId: task?.id ?? null,
        objectiveId: request.objectiveId,
      });
      return step;
    };

    try {
      const objective = this.resolveObjective(request, task);
      const query = task ? `${task.title}\n${task.description}` : (request.instruction ?? objective);

      const memoryBlock = await buildMemoryBlock(this.memory, {
        workspaceId: workspace.id,
        agentId: agent.id,
        query,
        taskId: task?.id ?? null,
      });

      const delegationsUsed = this.repos.delegations.countForObjective(request.objectiveId);
      const roster = buildRoster(this.repos, workspace.id, agent.id);

      const system = buildSystemPrompt({
        workspace,
        agent,
        task,
        objective,
        roster,
        memoryText: memoryBlock.text,
        depth: request.depth,
        remainingDelegations: Math.max(
          0,
          workspace.settings.maxDelegationsPerObjective - delegationsUsed,
        ),
      });

      const upstream = this.upstreamResults(task);

      const conversation: ModelMessage[] = [
        userMessage(
          request.instruction ??
            buildOpeningMessage({
              task,
              objective,
              priorMessages: this.recentContext(workspace.id, task),
              upstream,
            }),
        ),
      ];

      const toolSpecs = buildToolSpecs(agent, this.tools);
      const { provider, model } = this.providers.resolve(agent.model);
      usage.provider = provider.name;
      usage.model = model;

      const maxSteps = workspace.settings.maxStepsPerRun;
      let outcome: RunOutcome | null = null;

      for (let step = 0; step < maxSteps; step++) {
        cancellation.throwIfCancelled();
        if (Date.now() > deadline) {
          throw new Error(`Run exceeded its ${Math.round(this.config.limits.runTimeoutMs / 1000)}s budget`);
        }

        this.status.set(agent, 'thinking', `Working through step ${step + 1}`, {
          taskId: task?.id ?? null,
          runId: run.id,
        });
        this.events.publish(workspace.id, {
          type: 'AGENT_THINKING',
          actor,
          payload: { agentId: agent.id, runId: run.id, detail: `step ${step + 1}/${maxSteps}` } as never,
          runId: run.id,
          taskId: task?.id ?? null,
          objectiveId: request.objectiveId,
        });

        const response = await withRetry(
          () =>
            provider.generate(
              {
                model,
                system,
                messages: conversation,
                tools: toolSpecs,
                temperature: agent.temperature,
                maxTokens: this.config.ai.anthropic.maxTokens,
                metadata: {
                  role: agent.role,
                  agentName: agent.name,
                  objective,
                  taskTitle: task?.title ?? '',
                  taskDescription: task?.description ?? request.instruction ?? '',
                  upstream,
                  roster,
                },
              },
              cancellation.signal,
            ),
          {
            attempts: 3,
            baseDelayMs: 750,
            maxDelayMs: 10_000,
            signal: cancellation.signal,
            isRetryable: isTransientHttpError,
            onRetry: (err, attempt, delayMs) =>
              this.logger.warn('model call failed; retrying', {
                agent: agent.name,
                attempt,
                delayMs,
                error: errorMessage(err),
              }),
          },
        );

        usage.modelCalls += 1;
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.steps = stepIndex;

        const text = collectText(response.content);
        const toolUses = collectToolUses(response.content);

        if (text) {
          recordStep({
            kind: 'reasoning',
            summary: truncate(text, 2000),
            toolName: null,
            toolInput: null,
            toolOutput: null,
            ok: true,
            durationMs: 0,
          });
        }

        if (toolUses.length === 0) {
          // The model stopped without calling return_result. Its final text is
          // the best result available, so take it rather than discarding work.
          outcome = {
            run,
            result: text || null,
            summary: truncate(text || 'Finished without a result', 200),
            artifactPath: null,
          };
          break;
        }

        conversation.push(assistantMessage(response.content));
        const toolResults: ContentBlock[] = [];

        for (const use of toolUses) {
          cancellation.throwIfCancelled();
          toolsUsed.push(use.name);

          this.status.set(agent, TOOL_STATUS[use.name] ?? 'working', describeToolUse(use.name, use.input), {
            taskId: task?.id ?? null,
            runId: run.id,
          });

          const ctx: ToolContext = {
            workspace,
            agent,
            run,
            task,
            actor,
            objectiveId: request.objectiveId,
            depth: request.depth,
            signal: cancellation.signal,
            config: this.config,
            repos: this.repos,
            events: this.events,
            memory: this.memory,
            logger: this.logger,
            services: this.services,
            blocking,
          };

          const startedAt = Date.now();
          const result = await this.executor.execute(
            { callId: use.id, name: use.name, input: use.input },
            ctx,
          );
          const durationMs = Date.now() - startedAt;
          usage.toolCalls += 1;

          recordStep({
            kind: result.ok ? 'tool_call' : 'error',
            summary: result.summary,
            toolName: use.name,
            toolInput: use.input,
            toolOutput: truncate(result.content, 4000),
            ok: result.ok,
            durationMs,
          });

          toolResults.push({
            type: 'tool_result',
            toolUseId: use.id,
            content: truncate(result.content, 12_000),
            isError: !result.ok,
          } satisfies ToolResultBlock);

          // return_result is the clean exit. Take its payload and stop.
          if (use.name === 'return_result' && result.ok) {
            const payload = parseJson(result.content) as {
              summary?: string;
              result?: string;
              artifact_path?: string | null;
            } | null;
            outcome = {
              run,
              result: payload?.result ?? result.content,
              summary: payload?.summary ?? result.summary,
              artifactPath: payload?.artifact_path ?? null,
            };
            break;
          }
        }

        if (outcome) break;
        conversation.push({ role: 'user', content: toolResults });
      }

      if (!outcome) {
        // Ran out of steps. This is a real, reportable outcome — the task is
        // marked incomplete rather than quietly presented as finished.
        const lastReasoning = this.repos.runs
          .stepsFor(run.id)
          .filter((s) => s.kind === 'reasoning')
          .at(-1);
        throw new Error(
          `Reached the ${maxSteps}-step limit without calling return_result.` +
            (lastReasoning ? ` Last reasoning: ${truncate(lastReasoning.summary, 300)}` : ''),
        );
      }

      usage.steps = stepIndex;
      return await this.finishSuccessfully({
        workspace,
        agent,
        task,
        run,
        actor,
        outcome,
        usage,
        toolsUsed,
        objectiveId: request.objectiveId,
      });
    } catch (err) {
      usage.steps = stepIndex;
      return await this.finishWithError({
        workspace,
        agent,
        task,
        run,
        actor,
        error: err,
        usage,
        toolsUsed,
        objectiveId: request.objectiveId,
        cancellationReason: cancellation.reason,
      });
    } finally {
      this.cancellations.release(run.id);
    }
  }

  // -- completion paths -----------------------------------------------------

  private async finishSuccessfully(input: {
    workspace: Workspace;
    agent: Agent;
    task: Task | null;
    run: AgentRun;
    actor: ActorRef;
    outcome: RunOutcome;
    usage: RunUsage;
    toolsUsed: string[];
    objectiveId: string;
  }): Promise<RunOutcome> {
    const { workspace, agent, task, run, actor, outcome, usage } = input;

    this.repos.runs.finish(run.id, 'succeeded', { result: outcome.result, usage });
    this.repos.agents.bumpStat(agent.id, 'tasksCompleted');

    // Everything from here to `status.idle` runs without awaiting, so an
    // observer never sees a completed objective alongside an agent still
    // marked as working. The episodic write is deliberately last: it is the
    // only genuinely async step and nothing observable depends on it.
    this.status.set(agent, 'completed', truncate(outcome.summary, 120), {
      taskId: task?.id ?? null,
      runId: run.id,
    });

    const artifactIds = this.resolveArtifactIds(workspace.id, outcome.artifactPath);

    if (task) {
      if (task.requiresHumanApproval) {
        // The agent is done, but a human still has to sign off. The task waits
        // rather than closing itself.
        this.workspaces.mutateTask(task.id, (current) => ({
          status: 'awaiting_approval',
          result: outcome.result,
          artifactIds: [...new Set([...current.artifactIds, ...artifactIds])],
          lockedBy: null,
          lockExpiresAt: null,
        }));
        this.events.publish(workspace.id, {
          type: 'TASK_REVIEW_REQUESTED',
          actor,
          payload: {
            task: this.repos.tasks.byId(task.id)!,
            reviewerId: '',
            edge: {
              id: '',
              workspaceId: workspace.id,
              objectiveId: input.objectiveId,
              fromAgentId: agent.id,
              toAgentId: '',
              taskId: task.id,
              relation: 'review',
              note: 'Awaiting human approval',
              depth: 0,
              createdAt: Date.now(),
            },
          } as never,
          taskId: task.id,
          objectiveId: input.objectiveId,
        });
      } else {
        this.workspaces.completeTask({
          taskId: task.id,
          by: actor,
          result: outcome.result ?? outcome.summary,
          artifactIds,
        });
      }
      this.memory.clearShortTermForTask(task.id);
    }

    this.workspaces.postMessage({
      workspaceId: workspace.id,
      channel: task ? taskChannel(task.id) : MAIN_CHANNEL,
      author: actor,
      kind: 'result',
      body: outcome.result ?? outcome.summary,
      taskId: task?.id ?? null,
      runId: run.id,
      metadata: { summary: outcome.summary, artifactPath: outcome.artifactPath },
    });

    const finalRun = this.repos.runs.byId(run.id) ?? run;
    this.events.publish(workspace.id, {
      type: 'AGENT_FINISHED',
      actor,
      payload: { agentId: agent.id, run: finalRun } as never,
      runId: run.id,
      taskId: task?.id ?? null,
      objectiveId: input.objectiveId,
    });

    // `completed` is a momentary state; the agent returns to idle so the roster
    // reflects availability rather than the last thing that happened.
    this.status.idle(agent);

    await this.memory.recordEpisode({
      workspaceId: workspace.id,
      agentId: agent.id,
      agentName: agent.name,
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? outcome.summary,
      outcome: 'succeeded',
      summary: outcome.summary,
      durationMs: Date.now() - run.startedAt,
      toolsUsed: [...new Set(input.toolsUsed)],
    });

    return { ...outcome, run: finalRun };
  }

  private async finishWithError(input: {
    workspace: Workspace;
    agent: Agent;
    task: Task | null;
    run: AgentRun;
    actor: ActorRef;
    error: unknown;
    usage: RunUsage;
    toolsUsed: string[];
    objectiveId: string;
    cancellationReason: string | null;
  }): Promise<RunOutcome> {
    const { workspace, agent, task, run, actor, error, usage } = input;
    const cancelled = isCancellation(error);
    const message = cancelled ? (input.cancellationReason ?? 'Cancelled') : errorMessage(error);

    this.repos.runs.finish(run.id, cancelled ? 'cancelled' : 'failed', { error: message, usage });
    if (!cancelled) this.repos.agents.bumpStat(agent.id, 'tasksFailed');

    // Same ordering rule as the success path: the agent's terminal status is
    // written before the task and objective events that observers act on.
    this.status.set(agent, cancelled ? 'cancelled' : 'error', truncate(message, 120), {
      taskId: task?.id ?? null,
      runId: run.id,
    });

    if (task) {
      if (cancelled) {
        this.workspaces.cancelTask({ taskId: task.id, by: actor, reason: message, cascade: false });
      } else {
        this.workspaces.failTask({ taskId: task.id, by: actor, error: message });
      }
      this.memory.clearShortTermForTask(task.id);
    }

    if (cancelled) {
      this.events.publish(workspace.id, {
        type: 'AGENT_CANCELLED',
        actor,
        payload: { agentId: agent.id, runId: run.id, by: actor, reason: message } as never,
        runId: run.id,
        taskId: task?.id ?? null,
        objectiveId: input.objectiveId,
      });
    } else {
      this.logger.warn('agent run failed', { agent: agent.name, runId: run.id, error: message });
      this.events.publish(workspace.id, {
        type: 'AGENT_ERROR',
        actor,
        payload: {
          agentId: agent.id,
          runId: run.id,
          message: truncate(message, 500),
          retryable: isTransientHttpError(error),
        } as never,
        runId: run.id,
        taskId: task?.id ?? null,
        objectiveId: input.objectiveId,
      });
    }

    const finalRun = this.repos.runs.byId(run.id) ?? run;
    this.events.publish(workspace.id, {
      type: 'AGENT_FINISHED',
      actor,
      payload: { agentId: agent.id, run: finalRun } as never,
      runId: run.id,
      taskId: task?.id ?? null,
      objectiveId: input.objectiveId,
    });

    this.status.idle(agent);

    await this.memory.recordEpisode({
      workspaceId: workspace.id,
      agentId: agent.id,
      agentName: agent.name,
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? 'ad-hoc run',
      outcome: cancelled ? 'cancelled' : 'failed',
      summary: message,
      durationMs: Date.now() - run.startedAt,
      toolsUsed: [...new Set(input.toolsUsed)],
    });

    return { run: finalRun, result: null, summary: message, artifactPath: null };
  }

  // -- helpers --------------------------------------------------------------

  private resolveObjective(request: RunRequest, task: Task | null): string {
    const root = this.repos.tasks.byId(request.objectiveId);
    if (root) return `${root.title}${root.description ? `\n\n${root.description}` : ''}`;
    if (task) return task.title;
    return request.instruction ?? '';
  }

  /**
   * Results of the tasks this task depends on.
   *
   * Dependencies are not just an ordering constraint — they are how output
   * flows between agents. An analyst whose task depends on the research task
   * receives the research here, as its actual input.
   */
  private upstreamResults(task: Task | null): Array<{ title: string; author: string; result: string }> {
    if (!task || task.dependsOn.length === 0) return [];
    return this.repos.tasks
      .byIds(task.dependsOn)
      .filter((dep) => dep.status === 'completed' && dep.result)
      .map((dep) => ({
        title: dep.title,
        author: dep.assignee?.name ?? 'a teammate',
        result: dep.result ?? '',
      }));
  }

  /** A short slice of workspace conversation so an agent is not context-blind. */
  private recentContext(workspaceId: string, task: Task | null): Array<{ author: string; body: string }> {
    const messages = task
      ? this.repos.messages.listForTask(task.id, 10)
      : this.repos.messages.listChannel(workspaceId, MAIN_CHANNEL, 10);

    return messages
      .filter((m) => m.kind === 'chat' || m.kind === 'question' || m.kind === 'feedback')
      .slice(-6)
      .map((m) => ({ author: m.author.name ?? m.author.id, body: m.body }));
  }

  private resolveArtifactIds(workspaceId: string, artifactPath: string | null): string[] {
    if (!artifactPath) return [];
    const file = this.repos.files.byPath(workspaceId, artifactPath);
    return file ? [file.id] : [];
  }
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  const target = typeof input.agent === 'string' ? input.agent : null;
  switch (name) {
    case 'delegate_task':
      return target ? `Delegating to ${target}` : 'Delegating';
    case 'request_review':
      return target ? `Asking ${target} to review` : 'Requesting review';
    case 'ask_agent':
      return target ? `Asking ${target}` : 'Asking a teammate';
    case 'ask_human':
      return 'Waiting on a human';
    case 'web_search':
      return typeof input.query === 'string' ? `Searching: ${truncate(input.query, 50)}` : 'Searching';
    case 'file_write':
      return typeof input.path === 'string' ? `Writing ${input.path}` : 'Writing a file';
    case 'memory_search':
      return 'Checking memory';
    case 'memory_write':
      return 'Recording to memory';
    case 'code_exec':
      return 'Running code';
    case 'return_result':
      return 'Returning the result';
    default:
      return `Using ${name}`;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export { CancellationError };
