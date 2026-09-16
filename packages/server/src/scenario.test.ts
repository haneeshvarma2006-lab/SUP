import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Task, WorkspaceEvent } from '@sup/shared';
import { createTestWorkspace, type TestWorkspace } from './testing/harness.js';

/**
 * The scenario from the brief, run against the real system:
 *
 *   Human: "Build a competitor analysis for my startup."
 *     Orchestrator plans and delegates
 *     Researcher researches
 *     Analyst analyses
 *     Reviewer checks
 *     Writer produces the report
 *
 * Nothing here is stubbed except the language model, which is the offline
 * heuristic provider so the run is deterministic. The scheduler, event bus,
 * delegation guard, tool executor, memory service and task locking are all the
 * production implementations.
 */

let harness: TestWorkspace | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

describe('competitor analysis scenario', () => {
  it('runs an objective end to end across five agents in one workspace', async () => {
    harness = await createTestWorkspace();
    const { app, user, workspace } = harness;

    const roles = harness.agents.map((a) => a.role);
    expect(roles).toEqual(
      expect.arrayContaining(['Orchestrator', 'Researcher', 'Analyst', 'Reviewer', 'Writer']),
    );

    const started = app.orchestration.startObjective({
      workspaceId: workspace.id,
      title: 'Build a competitor analysis for my startup',
      description:
        'I am launching a developer-tools startup. I need to understand who else is in this space, ' +
        'how they position themselves, and where the gaps are.',
      requestedBy: user,
    });

    const completed = await harness.waitForEvent(
      (e) => e.type === 'OBJECTIVE_COMPLETED' && e.objectiveId === started.task.id,
      60_000,
    );

    // ---- the objective actually finished -----------------------------------

    const root = app.repos.tasks.byId(started.task.id)!;
    expect(root.status).toBe('completed');
    expect(root.result).toBeTruthy();
    expect((completed.payload as { objectiveId: string }).objectiveId).toBe(started.task.id);

    // ---- every specialist did a piece of it --------------------------------

    const tasks = app.repos.tasks.listForObjective(started.task.id);
    expect(tasks.length).toBeGreaterThanOrEqual(5);

    const workedBy = new Set(
      tasks
        .filter((t) => t.assignee?.type === 'agent' && t.status === 'completed')
        .map((t) => t.assignee!.name),
    );
    for (const role of ['Researcher', 'Analyst', 'Reviewer', 'Writer']) {
      const agent = harness.agentWithRole(role);
      expect(workedBy, `${role} (${agent.name}) should have completed a task`).toContain(agent.name);
    }

    // Every task under the objective reached a terminal state — nothing was
    // left hanging.
    expect(tasks.every((t) => ['completed', 'failed', 'cancelled'].includes(t.status))).toBe(true);

    // ---- delegation was recorded as a real graph ---------------------------

    const delegations = app.repos.delegations.listForObjective(started.task.id);
    const outbound = delegations.filter((d) => d.relation === 'delegate');
    const returns = delegations.filter((d) => d.relation === 'result');

    expect(outbound.length).toBeGreaterThanOrEqual(4);
    // Every delegation came back; the round trip is visible in the graph.
    expect(returns.length).toBe(outbound.length);

    const orchestrator = harness.agentWithRole('Orchestrator');
    expect(outbound.every((d) => d.fromAgentId === orchestrator.id)).toBe(true);

    // ---- dependencies were respected ---------------------------------------

    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const task of tasks) {
      for (const depId of task.dependsOn) {
        const dep = byId.get(depId);
        if (!dep?.completedAt || !task.startedAt) continue;
        expect(
          dep.completedAt,
          `"${task.title}" started before its dependency "${dep.title}" completed`,
        ).toBeLessThanOrEqual(task.startedAt);
      }
    }

    // ---- the event stream tells the whole story ----------------------------

    const types = harness.events.map((e) => e.type);
    for (const required of [
      'OBJECTIVE_STARTED',
      'TASK_CREATED',
      'TASK_DELEGATED',
      'AGENT_STARTED',
      'AGENT_STATUS_CHANGED',
      'AGENT_MESSAGE',
      'TOOL_CALLED',
      'TASK_COMPLETED',
      'MEMORY_CREATED',
      'AGENT_FINISHED',
      'OBJECTIVE_COMPLETED',
    ]) {
      expect(types, `expected a ${required} event`).toContain(required);
    }

    // Sequence numbers are gap-free and strictly increasing.
    const seqs = harness.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // ---- statuses moved through real execution phases ----------------------

    const statusEvents = harness
      .eventsOfType('AGENT_STATUS_CHANGED')
      .map((e) => e.payload as { agentId: string; status: string });

    const orchestratorStatuses = new Set(
      statusEvents.filter((s) => s.agentId === orchestrator.id).map((s) => s.status),
    );
    expect(orchestratorStatuses).toContain('thinking');
    expect(orchestratorStatuses).toContain('delegating');
    expect(orchestratorStatuses).toContain('waiting');
    expect(orchestratorStatuses).toContain('completed');

    // Everyone is back at rest afterwards.
    for (const agent of app.repos.agents.listForWorkspace(workspace.id)) {
      expect(agent.status, `${agent.name} should be idle`).toBe('idle');
      expect(agent.currentTaskId).toBeNull();
    }

    // ---- memory was written, and scoped ------------------------------------

    const memories = app.repos.memories.listForWorkspace(workspace.id, 200);
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.some((m) => m.scope === 'project')).toBe(true);
    expect(memories.some((m) => m.scope === 'episodic')).toBe(true);

    // ---- an artifact reached the human -------------------------------------

    const files = app.repos.files.listForWorkspace(workspace.id, true);
    expect(files.length).toBeGreaterThan(0);
    const report = files.find((f) => f.path.endsWith('.md'));
    expect(report?.content.length).toBeGreaterThan(200);

    // ---- the result came back to the human ---------------------------------

    const resultMessages = app.repos.messages
      .listRecent(workspace.id, 300)
      .filter((m) => m.kind === 'result');
    expect(resultMessages.length).toBeGreaterThanOrEqual(5);
  }, 90_000);

  it('feeds human feedback back into the next run for that agent', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher'] });
    const { app, user, workspace } = harness;

    const researcher = harness.agentWithRole('Researcher');

    await app.memory.recordFeedback({
      workspaceId: workspace.id,
      verdict: 'correct',
      comment:
        'Always list the pricing model for each competitor. The last report omitted it and we had to redo the work.',
      author: { type: 'user', id: user.id, name: user.displayName },
      agentId: researcher.id,
      taskId: null,
      taskTitle: 'Competitor research',
    });

    // The feedback is retrievable and lands in the agent's prompt context.
    const context = await app.memory.buildPromptContext({
      workspaceId: workspace.id,
      agentId: researcher.id,
      query: 'competitor research pricing',
    });

    expect(context.text).toContain('pricing model');
    expect(context.used.some((m) => m.kind === 'feedback')).toBe(true);

    // A correction is pinned and high-importance, so it survives ranking
    // pressure from later, more numerous memories.
    const stored = context.used.find((m) => m.kind === 'feedback')!;
    expect(stored.pinned).toBe(true);
    expect(stored.importance).toBeGreaterThan(0.9);
    expect(stored.scope).toBe('agent');
  });
});

/** Narrows an event payload for assertions without casting at each use site. */
export function payloadOf<T>(event: WorkspaceEvent): T {
  return event.payload as T;
}

export type { Agent, Task };
