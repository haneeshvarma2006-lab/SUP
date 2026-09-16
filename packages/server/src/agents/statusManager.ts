import type { ActorRef, Agent, AgentStatus } from '@sup/shared';
import type { Repositories } from '../db/repos/index.js';
import type { EventBus } from '../events/eventBus.js';

/**
 * Owns agent status.
 *
 * Status is written only here, and only at points where the runtime has
 * actually changed what it is doing — entering the model call, dispatching a
 * tool, blocking on a delegation, finishing. Nothing sets a status on a timer
 * or to make the UI look busy, so what a viewer sees is the real execution
 * state of the backend.
 */
export class AgentStatusManager {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventBus,
  ) {}

  set(
    agent: Agent,
    status: AgentStatus,
    detail: string,
    context: { taskId?: string | null; runId?: string | null; actor?: ActorRef } = {},
  ): void {
    const current = this.repos.agents.byId(agent.id);
    if (!current) return;

    const taskId = context.taskId !== undefined ? context.taskId : current.currentTaskId;
    const runId = context.runId !== undefined ? context.runId : current.currentRunId;

    // Suppress no-op transitions: they would flood the event log and make the
    // activity feed useless without changing anything.
    if (current.status === status && current.statusDetail === detail && current.currentTaskId === taskId) {
      return;
    }

    this.repos.agents.setStatus(agent.id, status, detail, taskId, runId);

    this.events.publish(agent.workspaceId, {
      type: 'AGENT_STATUS_CHANGED',
      actor: context.actor ?? { type: 'agent', id: agent.id, name: agent.name },
      payload: {
        agentId: agent.id,
        status,
        previousStatus: current.status,
        detail,
        taskId,
        runId,
      } as never,
      runId,
      taskId,
    });
  }

  /** Returns an agent to rest, clearing its task and run pointers. */
  idle(agent: Agent, detail = ''): void {
    const current = this.repos.agents.byId(agent.id);
    // A paused agent stays paused; finishing a run must not silently resume it.
    if (current?.paused) {
      this.set(agent, 'paused', 'Paused by a human', { taskId: null, runId: null });
      return;
    }
    this.set(agent, 'idle', detail, { taskId: null, runId: null });
  }

  current(agentId: string): Agent | null {
    return this.repos.agents.byId(agentId);
  }
}
