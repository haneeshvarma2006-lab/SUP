import { afterEach, describe, expect, it } from 'vitest';
import { roleAtLeast, roleHasPermission, type WorkspaceEvent } from '@sup/shared';
import { createTestWorkspace, type TestWorkspace } from '../testing/harness.js';
import { AppError } from '../util/errors.js';

let harness: TestWorkspace | null = null;
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

const systemActor = { type: 'system' as const, id: 'system', name: 'System' };

describe('EventBus ordering and durability', () => {
  it('assigns gap-free, strictly increasing sequence numbers', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const published = Array.from({ length: 50 }, (_, i) =>
      app.events.publish(workspace.id, {
        type: 'SYSTEM_NOTICE',
        actor: systemActor,
        payload: { level: 'info', message: `notice ${i}` },
      }),
    );

    const seqs = published.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }
    expect(app.events.currentSeq(workspace.id)).toBe(seqs[seqs.length - 1]);
  });

  it('delivers to subscribers in seq order even when a handler publishes re-entrantly', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const seen: number[] = [];
    let reentered = false;

    app.events.subscribe(workspace.id, (event) => {
      seen.push(event.seq);
      // A handler that publishes must not have its event delivered before the
      // one currently being processed finishes.
      if (!reentered && event.type === 'SYSTEM_NOTICE') {
        reentered = true;
        app.events.publish(workspace.id, {
          type: 'SYSTEM_NOTICE',
          actor: systemActor,
          payload: { level: 'info', message: 'from inside a handler' },
        });
      }
    });

    app.events.publish(workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'outer' },
    });

    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps delivering after a subscriber throws', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const good: number[] = [];
    app.events.subscribe(workspace.id, () => {
      throw new Error('this subscriber is broken');
    });
    app.events.subscribe(workspace.id, (e) => {
      good.push(e.seq);
    });

    app.events.publish(workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'one' },
    });
    app.events.publish(workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'two' },
    });

    expect(good).toHaveLength(2);
  });

  it('replays a window from the durable log', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const before = app.events.currentSeq(workspace.id);
    for (let i = 0; i < 10; i++) {
      app.events.publish(workspace.id, {
        type: 'SYSTEM_NOTICE',
        actor: systemActor,
        payload: { level: 'info', message: `n${i}` },
      });
    }

    const replayed = app.events.replay(workspace.id, before, 100);
    expect(replayed).toHaveLength(10);
    expect(replayed.map((e) => e.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => before + i + 1),
    );

    // A client already up to date gets nothing, not a duplicate burst.
    expect(app.events.replay(workspace.id, app.events.currentSeq(workspace.id))).toHaveLength(0);
  });

  it('writes a batch atomically with contiguous seqs', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const batch = app.events.publishBatch(workspace.id, [
      { type: 'SYSTEM_NOTICE', actor: systemActor, payload: { level: 'info', message: 'a' } },
      { type: 'SYSTEM_NOTICE', actor: systemActor, payload: { level: 'info', message: 'b' } },
      { type: 'SYSTEM_NOTICE', actor: systemActor, payload: { level: 'info', message: 'c' } },
    ]);

    expect(batch).toHaveLength(3);
    expect(batch[1]!.seq).toBe(batch[0]!.seq + 1);
    expect(batch[2]!.seq).toBe(batch[1]!.seq + 1);
  });

  it('keeps sequences independent per workspace', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user } = harness;

    const second = app.workspaces.createWorkspace({
      name: 'Second workspace',
      owner: user,
      roster: ['orchestrator'],
    });

    const secondSeqBefore = app.events.currentSeq(second.workspace.id);

    // Twenty events in the first workspace must not advance the second's
    // counter by even one — the sequences are per workspace, not global.
    for (let i = 0; i < 20; i++) {
      app.events.publish(harness.workspace.id, {
        type: 'SYSTEM_NOTICE',
        actor: systemActor,
        payload: { level: 'info', message: `first ws ${i}` },
      });
    }

    expect(app.events.currentSeq(second.workspace.id)).toBe(secondSeqBefore);

    const b = app.events.publish(second.workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'second ws' },
    });
    expect(b.seq).toBe(secondSeqBefore + 1);
    expect(app.events.currentSeq(harness.workspace.id)).toBeGreaterThan(b.seq);

    // And a replay in one workspace never returns the other's events.
    const replay = app.events.replay(second.workspace.id, 0, 100);
    expect(replay.every((e) => e.workspaceId === second.workspace.id)).toBe(true);
  });

  it('resolves waitFor when a matching event arrives, and times out otherwise', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const waiting = app.events.waitFor(
      workspace.id,
      (e: WorkspaceEvent) =>
        e.type === 'SYSTEM_NOTICE' &&
        (e.payload as { message: string }).message === 'the one I want',
      5000,
    );

    app.events.publish(workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'not it' },
    });
    app.events.publish(workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'the one I want' },
    });

    await expect(waiting).resolves.toMatchObject({ type: 'SYSTEM_NOTICE' });
    await expect(app.events.waitFor(workspace.id, () => false, 40)).rejects.toThrow(/timed out/);
  });

  it('stops delivering after unsubscribe', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    let count = 0;
    const subscription = app.events.subscribe(workspace.id, () => {
      count += 1;
    });

    app.events.publish(workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'one' },
    });
    subscription.unsubscribe();
    app.events.publish(workspace.id, {
      type: 'SYSTEM_NOTICE',
      actor: systemActor,
      payload: { level: 'info', message: 'two' },
    });

    expect(count).toBe(1);
  });
});

describe('presence', () => {
  it('counts connections per user and only reports a departure on the last one', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;

    expect(app.presence.join(workspace.id, user, 'conn-1')).toBe(true);
    expect(app.presence.join(workspace.id, user, 'conn-2')).toBe(false);
    expect(app.presence.entry(workspace.id, user.id)!.connections).toBe(2);

    // Closing one tab must not make the person look like they left.
    expect(app.presence.leave(workspace.id, user.id, 'conn-1')).toBe(false);
    expect(app.presence.leave(workspace.id, user.id, 'conn-2')).toBe(true);
    expect(app.presence.list(workspace.id)).toHaveLength(0);
  });

  it('drops a connection from every workspace it was in', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user } = harness;

    const second = app.workspaces.createWorkspace({
      name: 'Other',
      owner: user,
      roster: ['orchestrator'],
    });

    app.presence.join(harness.workspace.id, user, 'conn-1');
    app.presence.join(second.workspace.id, user, 'conn-1');

    const departures = app.presence.dropConnection('conn-1');
    expect(departures).toHaveLength(2);
    expect(app.presence.totalConnections()).toBe(0);
  });
});

describe('authentication', () => {
  it('issues a working token and resolves it back to the user', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app } = harness;

    const registered = app.auth.register({
      email: 'new@example.com',
      password: 'a-long-enough-password',
      displayName: 'New Person',
    });

    const session = app.auth.authenticate(registered.token);
    expect(session?.user.id).toBe(registered.user.id);

    app.auth.logout(session!.sessionId);
    expect(app.auth.authenticate(registered.token)).toBeNull();
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app } = harness;

    app.auth.register({
      email: 'known@example.com',
      password: 'a-long-enough-password',
      displayName: 'Known',
    });

    const unknownEmail = captureError(() =>
      app.auth.login({ email: 'nobody@example.com', password: 'whatever' }),
    );
    const wrongPassword = captureError(() =>
      app.auth.login({ email: 'known@example.com', password: 'wrong-password' }),
    );

    // Distinguishable messages here would leak which accounts exist.
    expect(unknownEmail?.message).toBe(wrongPassword?.message);
    expect(unknownEmail?.status).toBe(401);
  });

  it('rejects weak or malformed registrations', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app } = harness;

    expect(() =>
      app.auth.register({ email: 'not-an-email', password: 'a-long-enough-password', displayName: 'X' }),
    ).toThrow(/valid email/i);
    expect(() =>
      app.auth.register({ email: 'x@example.com', password: 'short', displayName: 'X' }),
    ).toThrow(/8 characters/i);
    expect(() =>
      app.auth.register({ email: 'y@example.com', password: 'a-long-enough-password', displayName: '' }),
    ).toThrow(/display name/i);
  });

  it('never stores the password or the raw token', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app } = harness;

    const password = 'a-very-distinctive-password';
    const registered = app.auth.register({
      email: 'secrets@example.com',
      password,
      displayName: 'Secrets',
    });

    const stored = app.repos.users.byEmail('secrets@example.com')!;
    expect(stored.passwordHash).not.toContain(password);
    expect(app.repos.sessions.byTokenHash(registered.token)).toBeNull();
  });
});

describe('permissions', () => {
  it('encodes the role hierarchy', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
    expect(roleHasPermission('viewer', 'message:send')).toBe(false);
    expect(roleHasPermission('viewer', 'workspace:read')).toBe(true);
    expect(roleHasPermission('member', 'objective:start')).toBe(true);
    expect(roleHasPermission('member', 'agent:delete')).toBe(false);
    expect(roleHasPermission('admin', 'agent:delete')).toBe(true);
    expect(roleHasPermission('admin', 'workspace:delete')).toBe(false);
    expect(roleHasPermission('owner', 'workspace:delete')).toBe(true);
  });

  it('hides a workspace from a non-member as not-found, not forbidden', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const outsider = app.auth.register({
      email: 'outsider@example.com',
      password: 'a-long-enough-password',
      displayName: 'Outsider',
    });

    const err = captureError(() => app.permissions.contextFor(workspace.id, outsider.user));
    // A 403 would confirm the workspace exists to someone who should not know.
    expect(err?.status).toBe(404);
  });

  it('refuses an action the caller lacks permission for', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, workspace } = harness;

    const viewer = app.auth.register({
      email: 'viewer@example.com',
      password: 'a-long-enough-password',
      displayName: 'Viewer',
    });
    app.workspaces.addMember(workspace.id, viewer.user.id, 'viewer');

    const ctx = app.permissions.contextFor(workspace.id, viewer.user);
    expect(app.permissions.can(ctx, 'workspace:read')).toBe(true);
    expect(app.permissions.can(ctx, 'objective:start')).toBe(false);

    const err = captureError(() => app.permissions.require(ctx, 'objective:start'));
    expect(err?.status).toBe(403);
  });
});

describe('human controls', () => {
  it('pausing an agent keeps it out of the scheduler', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher'] });
    const { app, user, workspace } = harness;
    const researcher = harness.agentWithRole('Researcher');

    app.repos.agents.update(researcher.id, { paused: true });

    const task = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Work for a paused agent',
      description: '',
      createdBy: { type: 'user', id: user.id, name: user.displayName },
      assignee: { type: 'agent', id: researcher.id, name: researcher.name },
    });

    expect(app.scheduler.dispatchReady(workspace.id)).toBe(0);
    expect(app.repos.tasks.byId(task.id)!.status).toBe('assigned');

    // Resuming makes the same work runnable without recreating it.
    app.repos.agents.update(researcher.id, { paused: false });
    expect(app.scheduler.dispatchReady(workspace.id)).toBe(1);
  });

  it('an approval can only be resolved once', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;
    const orchestrator = harness.agentWithRole('Orchestrator');
    const actor = { type: 'user' as const, id: user.id, name: user.displayName };

    const approval = app.workspaces.createApproval({
      workspaceId: workspace.id,
      requestedBy: { type: 'agent', id: orchestrator.id, name: orchestrator.name },
      runId: null,
      taskId: null,
      action: 'tool:code_exec',
      reason: 'wants to run a script',
      payload: { language: 'python' },
    });

    const resolved = app.workspaces.resolveApproval({
      approvalId: approval.id,
      approved: true,
      resolvedBy: actor,
      note: 'fine',
    });
    expect(resolved.status).toBe('approved');

    const err = captureError(() =>
      app.workspaces.resolveApproval({
        approvalId: approval.id,
        approved: false,
        resolvedBy: actor,
      }),
    );
    expect(err?.status).toBe(409);
  });

  it('cancelling a task cascades to its children', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator'] });
    const { app, user, workspace } = harness;
    const actor = { type: 'user' as const, id: user.id, name: user.displayName };

    const parent = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Parent',
      description: '',
      createdBy: actor,
    });
    const child = app.workspaces.createTask({
      workspaceId: workspace.id,
      title: 'Child',
      description: '',
      createdBy: actor,
      parentTaskId: parent.id,
      objectiveId: parent.objectiveId,
    });

    const cancelled = app.workspaces.cancelTask({
      taskId: parent.id,
      by: actor,
      reason: 'changed my mind',
      cascade: true,
    });

    expect(cancelled.map((t) => t.id).sort()).toEqual([parent.id, child.id].sort());
    expect(app.repos.tasks.byId(child.id)!.status).toBe('cancelled');
  });

  it('a human @mention starts the agent that was mentioned', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher'] });
    const { app, user, workspace } = harness;
    const researcher = harness.agentWithRole('Researcher');

    app.workspaces.postMessage({
      workspaceId: workspace.id,
      author: { type: 'user', id: user.id, name: user.displayName },
      body: `@${researcher.name} can you look into the pricing page of our nearest competitor?`,
    });

    const started = await harness.waitForEvent(
      (e) =>
        e.type === 'AGENT_STARTED' &&
        (e.payload as { agentId: string }).agentId === researcher.id,
      20_000,
    );
    expect(started).toBeTruthy();
  });

  it('an agent @mentioning another agent in chat does not start it', async () => {
    harness = await createTestWorkspace({ roster: ['orchestrator', 'researcher'] });
    const { app, workspace } = harness;
    const orchestrator = harness.agentWithRole('Orchestrator');
    const researcher = harness.agentWithRole('Researcher');

    app.workspaces.postMessage({
      workspaceId: workspace.id,
      author: { type: 'agent', id: orchestrator.id, name: orchestrator.name },
      body: `@${researcher.name} nice work on that last one`,
      kind: 'agent_to_agent',
    });

    // Work moves between agents through delegation, which is budgeted and
    // cycle-checked — not through chat, which would be unbounded.
    await new Promise((r) => setTimeout(r, 150));
    const startedResearcher = harness
      .eventsOfType('AGENT_STARTED')
      .filter((e) => (e.payload as { agentId: string }).agentId === researcher.id);
    expect(startedResearcher).toHaveLength(0);
  });
});

function captureError(fn: () => unknown): AppError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err : null;
  }
}
