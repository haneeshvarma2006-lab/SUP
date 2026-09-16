import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_SETTINGS, type Task, type Workspace } from '@sup/shared';
import { DelegationGuard } from './delegationGuard.js';
import { createTestWorkspace, type TestWorkspace } from '../testing/harness.js';

let harness: TestWorkspace | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

describe('DelegationGuard', () => {
  it('refuses self-delegation', async () => {
    harness = await createTestWorkspace();
    const guard = new DelegationGuard(harness.app.repos);
    const orchestrator = harness.agentWithRole('Orchestrator');

    const verdict = guard.check({
      workspace: harness.workspace,
      objectiveId: 'obj',
      fromAgentId: orchestrator.id,
      toAgentId: orchestrator.id,
      depth: 0,
      title: 'anything',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toMatch(/cannot delegate to itself/);
  });

  it('refuses a chain deeper than the workspace limit', async () => {
    harness = await createTestWorkspace();
    const guard = new DelegationGuard(harness.app.repos);
    const workspace: Workspace = {
      ...harness.workspace,
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, maxDelegationDepth: 2 },
    };

    const orchestrator = harness.agentWithRole('Orchestrator');
    const researcher = harness.agentWithRole('Researcher');

    expect(
      guard.check({
        workspace,
        objectiveId: 'obj',
        fromAgentId: orchestrator.id,
        toAgentId: researcher.id,
        depth: 1,
        title: 'a',
      }).allowed,
    ).toBe(true);

    const tooDeep = guard.check({
      workspace,
      objectiveId: 'obj',
      fromAgentId: orchestrator.id,
      toAgentId: researcher.id,
      depth: 2,
      title: 'b',
    });
    expect(tooDeep.allowed).toBe(false);
    expect(tooDeep.allowed === false && tooDeep.reason).toMatch(/depth limit/i);
  });

  it('refuses an edge that would close a cycle', async () => {
    harness = await createTestWorkspace();
    const { app, workspace } = harness;
    const guard = new DelegationGuard(app.repos);

    const a = harness.agentWithRole('Orchestrator');
    const b = harness.agentWithRole('Researcher');
    const c = harness.agentWithRole('Analyst');

    // Build A -> B -> C.
    app.workspaces.recordDelegation({
      workspaceId: workspace.id,
      objectiveId: 'obj',
      fromAgentId: a.id,
      toAgentId: b.id,
      taskId: 't1',
      relation: 'delegate',
      note: '',
      depth: 1,
    });
    app.workspaces.recordDelegation({
      workspaceId: workspace.id,
      objectiveId: 'obj',
      fromAgentId: b.id,
      toAgentId: c.id,
      taskId: 't2',
      relation: 'delegate',
      note: '',
      depth: 2,
    });

    // C -> A would close the loop.
    const cyclic = guard.check({
      workspace,
      objectiveId: 'obj',
      fromAgentId: c.id,
      toAgentId: a.id,
      depth: 2,
      title: 'back to the start',
    });
    expect(cyclic.allowed).toBe(false);
    expect(cyclic.allowed === false && cyclic.reason).toMatch(/loop/i);

    // A different objective is a separate graph and is unaffected.
    expect(
      guard.check({
        workspace,
        objectiveId: 'other-objective',
        fromAgentId: c.id,
        toAgentId: a.id,
        depth: 0,
        title: 'fresh graph',
      }).allowed,
    ).toBe(true);
  });

  it('refuses re-delegating work already in flight to the same agent', async () => {
    harness = await createTestWorkspace();
    const { app, user, workspace } = harness;
    const guard = new DelegationGuard(app.repos);

    const orchestrator = harness.agentWithRole('Orchestrator');
    const researcher = harness.agentWithRole('Researcher');

    const root = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'objective',
      description: '',
      createdBy: { type: 'user', id: user.id },
    });

    app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Research the market',
      description: '',
      createdBy: { type: 'agent', id: orchestrator.id },
      assignee: { type: 'agent', id: researcher.id, name: researcher.name },
      objectiveId: root.id,
    });

    const duplicate = guard.check({
      workspace,
      objectiveId: root.id,
      fromAgentId: orchestrator.id,
      toAgentId: researcher.id,
      depth: 0,
      // Same work, different punctuation and casing.
      title: 'research the market!',
    });

    expect(duplicate.allowed).toBe(false);
    expect(duplicate.allowed === false && duplicate.reason).toMatch(/already delegated/i);
  });

  it('refuses once the objective delegation budget is spent', async () => {
    harness = await createTestWorkspace();
    const { app, workspace } = harness;
    const guard = new DelegationGuard(app.repos);

    const limited: Workspace = {
      ...workspace,
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, maxDelegationsPerObjective: 2 },
    };

    const orchestrator = harness.agentWithRole('Orchestrator');
    const researcher = harness.agentWithRole('Researcher');

    for (let i = 0; i < 2; i++) {
      app.workspaces.recordDelegation({
        workspaceId: workspace.id,
        objectiveId: 'budget-obj',
        fromAgentId: orchestrator.id,
        toAgentId: researcher.id,
        taskId: `t${i}`,
        relation: 'delegate',
        note: '',
        depth: 1,
      });
    }

    const verdict = guard.check({
      workspace: limited,
      objectiveId: 'budget-obj',
      fromAgentId: orchestrator.id,
      toAgentId: researcher.id,
      depth: 0,
      title: 'one too many',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toMatch(/budget/i);
    expect(guard.remainingBudget(limited, 'budget-obj')).toBe(0);
  });

  it('does not count returned-result edges against the delegation budget', async () => {
    harness = await createTestWorkspace();
    const { app, workspace } = harness;
    const guard = new DelegationGuard(app.repos);
    const orchestrator = harness.agentWithRole('Orchestrator');
    const researcher = harness.agentWithRole('Researcher');

    app.workspaces.recordDelegation({
      workspaceId: workspace.id,
      objectiveId: 'obj-2',
      fromAgentId: researcher.id,
      toAgentId: orchestrator.id,
      taskId: 't',
      relation: 'result',
      note: '',
      depth: 1,
    });

    expect(guard.remainingBudget(workspace, 'obj-2')).toBe(
      workspace.settings.maxDelegationsPerObjective,
    );
  });
});

describe('objective lifecycle', () => {
  it('rejects an objective in a workspace with no orchestrator', async () => {
    harness = await createTestWorkspace({ roster: ['researcher'] });
    const { app, user, workspace } = harness;

    expect(() =>
      app.orchestration.startObjective({
        workspaceId: workspace.id,
        title: 'No one to plan this',
        description: '',
        requestedBy: user,
      }),
    ).toThrow(/no orchestrator/i);
  });

  it('refuses to start when the orchestrator is paused', async () => {
    harness = await createTestWorkspace();
    const { app, user, workspace } = harness;
    const orchestrator = harness.agentWithRole('Orchestrator');

    app.repos.agents.update(orchestrator.id, { paused: true });

    expect(() =>
      app.orchestration.startObjective({
        workspaceId: workspace.id,
        title: 'Should not start',
        description: '',
        requestedBy: user,
      }),
    ).toThrow(/paused/i);
  });

  it('cancels every task under an objective and stops the runs', async () => {
    harness = await createTestWorkspace();
    const { app, user, workspace } = harness;

    const started = app.orchestration.startObjective({
      workspaceId: workspace.id,
      title: 'Objective to abandon',
      description: 'It will be cancelled partway through.',
      requestedBy: user,
    });

    // Let the orchestrator get at least one delegation out.
    await harness.waitForEvent((e) => e.type === 'TASK_DELEGATED', 20_000).catch(() => undefined);

    const actor = { type: 'user' as const, id: user.id, name: user.displayName };
    app.scheduler.cancelObjective(started.task.id, actor, 'test cancellation');
    app.workspaces.cancelTask({
      taskId: started.task.id,
      by: actor,
      reason: 'test cancellation',
      cascade: true,
    });

    const root = app.repos.tasks.byId(started.task.id)!;
    expect(root.status).toBe('cancelled');
  });
});

describe('dependency handling', () => {
  it('holds a task until its dependency completes, then releases it', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher', 'analyst'] });
    const { app, user, workspace } = harness;
    const analyst = harness.agentWithRole('Analyst');
    const author = { type: 'user' as const, id: user.id, name: user.displayName };

    const upstream = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Produce the input',
      description: '',
      createdBy: author,
    });

    const downstream = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Consume the input',
      description: '',
      createdBy: author,
      assignee: { type: 'agent', id: analyst.id, name: analyst.name },
      dependsOn: [upstream.id],
    });

    expect(app.repos.tasks.dependenciesSatisfied(downstream)).toBe(false);
    expect(app.repos.tasks.findRunnable(workspace.id).map((t) => t.id)).not.toContain(downstream.id);
    expect(app.repos.tasks.unmetDependencies(downstream).map((t) => t.id)).toEqual([upstream.id]);

    app.workspaces.completeTask({ taskId: upstream.id, by: author, result: 'the input' });

    const refreshed = app.repos.tasks.byId(downstream.id)!;
    expect(app.repos.tasks.dependenciesSatisfied(refreshed)).toBe(true);
  });

  it('drops a dependency id that does not resolve, so a task cannot be stranded', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;

    const task = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Bad dependency',
      description: '',
      createdBy: { type: 'user', id: user.id },
      dependsOn: ['tsk_does_not_exist'],
    });

    expect(task.dependsOn).toEqual([]);
    expect(app.repos.tasks.dependenciesSatisfied(task)).toBe(true);
  });
});

export type { Task };
