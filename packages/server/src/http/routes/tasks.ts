import type { FastifyInstance } from 'fastify';
import { MAIN_CHANNEL, type ActorRef, type FeedbackVerdict, type TaskPriority } from '@sup/shared';
import type { App } from '../../app.js';
import { body, params, query, requireWorkspace, route } from '../context.js';
import { badRequest, conflict, notFound } from '../../util/errors.js';

export function registerTaskRoutes(server: FastifyInstance, app: App): void {
  server.get(
    '/api/workspaces/:workspaceId/tasks',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'task:read');
      const { objectiveId } = query<{ objectiveId?: string }>(request);

      return {
        tasks: objectiveId
          ? app.repos.tasks.listForObjective(objectiveId)
          : app.repos.tasks.listForWorkspace(workspaceId, 300),
      };
    }),
  );

  server.post(
    '/api/workspaces/:workspaceId/tasks',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'task:create');
      const actor = toActor(ctx.user);

      const input = body<{
        title?: string;
        description?: string;
        assigneeAgentId?: string;
        priority?: TaskPriority;
        dependsOn?: string[];
        requiresHumanApproval?: boolean;
      }>(request);

      let assignee: ActorRef | null = null;
      if (input.assigneeAgentId) {
        const agent = app.repos.agents.byId(input.assigneeAgentId);
        if (!agent || agent.workspaceId !== workspaceId) throw notFound('Agent');
        assignee = { type: 'agent', id: agent.id, name: agent.name };
      }

      const task = app.workspaces.createTask({
        workspaceId,
        title: String(input.title ?? ''),
        description: String(input.description ?? ''),
        createdBy: actor,
        assignee,
        priority: input.priority,
        dependsOn: input.dependsOn,
        requiresHumanApproval: input.requiresHumanApproval,
      });

      // Assigning is what makes work runnable; the reactor picks it up from the
      // TASK_ASSIGNED event, so nothing needs to be started explicitly here.
      return reply.status(201).send({ task });
    }),
  );

  server.get(
    '/api/tasks/:taskId',
    route(app, async (request) => {
      const { taskId } = params<{ taskId: string }>(request);
      const task = app.repos.tasks.byId(taskId);
      if (!task) throw notFound('Task');
      requireWorkspace(app, request, task.workspaceId, 'task:read');

      return {
        task,
        children: app.repos.tasks.listChildren(taskId),
        runs: app.repos.runs.listForTask(taskId),
        messages: app.repos.messages.listForTask(taskId, 100),
        artifacts: task.artifactIds
          .map((id) => app.repos.files.byId(id))
          .filter((f) => f !== null),
      };
    }),
  );

  server.patch(
    '/api/tasks/:taskId',
    route(app, async (request) => {
      const { taskId } = params<{ taskId: string }>(request);
      const task = app.repos.tasks.byId(taskId);
      if (!task) throw notFound('Task');
      const ctx = requireWorkspace(app, request, task.workspaceId, 'task:update');
      app.permissions.requireTaskControl(ctx, task);

      const input = body<{
        title?: string;
        description?: string;
        priority?: TaskPriority;
      }>(request);

      return {
        task: app.workspaces.updateTask({
          taskId,
          by: toActor(ctx.user),
          patch: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          },
        }),
      };
    }),
  );

  server.post(
    '/api/tasks/:taskId/assign',
    route(app, async (request) => {
      const { taskId } = params<{ taskId: string }>(request);
      const task = app.repos.tasks.byId(taskId);
      if (!task) throw notFound('Task');
      const ctx = requireWorkspace(app, request, task.workspaceId, 'task:assign');
      app.permissions.requireTaskControl(ctx, task);

      const input = body<{ agentId?: string; userId?: string }>(request);

      let assignee: ActorRef;
      if (input.agentId) {
        const agent = app.repos.agents.byId(input.agentId);
        if (!agent || agent.workspaceId !== task.workspaceId) throw notFound('Agent');
        assignee = { type: 'agent', id: agent.id, name: agent.name };
      } else if (input.userId) {
        const member = app.repos.memberships.find(task.workspaceId, input.userId);
        if (!member) throw notFound('Workspace member');
        const user = app.repos.users.byId(input.userId);
        assignee = { type: 'user', id: input.userId, name: user?.displayName };
      } else {
        throw badRequest('Provide an agentId or a userId');
      }

      // Reassigning live work: stop the current holder first, or two agents
      // would be working the same task.
      if (task.status === 'in_progress' && task.assignee?.type === 'agent') {
        app.scheduler.cancelAgent(
          task.assignee.id,
          toActor(ctx.user),
          `Task reassigned by ${ctx.user.displayName}`,
        );
      }

      return { task: app.workspaces.assignTask({ taskId, assignee, by: toActor(ctx.user) }) };
    }),
  );

  server.post(
    '/api/tasks/:taskId/cancel',
    route(app, async (request) => {
      const { taskId } = params<{ taskId: string }>(request);
      const task = app.repos.tasks.byId(taskId);
      if (!task) throw notFound('Task');
      const ctx = requireWorkspace(app, request, task.workspaceId, 'task:cancel');
      app.permissions.requireTaskControl(ctx, task);

      const input = body<{ reason?: string }>(request);
      const reason = input.reason?.trim() || `Cancelled by ${ctx.user.displayName}`;
      const actor = toActor(ctx.user);

      if (task.assignee?.type === 'agent') {
        app.scheduler.cancelAgent(task.assignee.id, actor, reason);
      }

      const cancelled = app.workspaces.cancelTask({ taskId, by: actor, reason, cascade: true });
      return { cancelled: cancelled.map((t) => t.id) };
    }),
  );

  /** Human approval of an agent's result on a task that required sign-off. */
  server.post(
    '/api/tasks/:taskId/approve',
    route(app, async (request) => {
      const { taskId } = params<{ taskId: string }>(request);
      const task = app.repos.tasks.byId(taskId);
      if (!task) throw notFound('Task');
      const ctx = requireWorkspace(app, request, task.workspaceId, 'approval:resolve');

      if (task.status !== 'awaiting_approval') {
        throw conflict(`Task is ${task.status}, not awaiting approval`);
      }

      const input = body<{ approved?: boolean; note?: string }>(request);
      const actor = toActor(ctx.user);
      const approved = input.approved !== false;

      const updated = approved
        ? app.workspaces.completeTask({
            taskId,
            by: actor,
            result: task.result ?? '',
          })
        : app.workspaces.updateTask({
            taskId,
            by: actor,
            patch: { status: 'assigned', error: input.note ?? 'Rejected by a human' },
          });

      // The verdict is captured as memory so the agent sees it next time.
      await app.memory.recordFeedback({
        workspaceId: task.workspaceId,
        verdict: approved ? 'approve' : 'reject',
        comment: input.note ?? '',
        author: actor,
        agentId: task.assignee?.type === 'agent' ? task.assignee.id : null,
        taskId,
        taskTitle: task.title,
      });

      return { task: updated };
    }),
  );

  // -- objectives ------------------------------------------------------------

  server.post(
    '/api/workspaces/:workspaceId/objectives',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'objective:start');
      const input = body<{ title?: string; description?: string; requiresHumanApproval?: boolean }>(request);

      const title = String(input.title ?? '').trim();
      if (!title) throw badRequest('An objective needs a title');

      const started = app.orchestration.startObjective({
        workspaceId,
        title,
        description: String(input.description ?? ''),
        requestedBy: ctx.user,
        requiresHumanApproval: input.requiresHumanApproval,
      });

      return reply.status(202).send({
        objectiveId: started.task.id,
        task: started.task,
        orchestratorId: started.orchestratorId,
      });
    }),
  );

  server.get(
    '/api/workspaces/:workspaceId/objectives/:objectiveId',
    route(app, async (request) => {
      const { workspaceId, objectiveId } = params<{ workspaceId: string; objectiveId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'task:read');

      const root = app.repos.tasks.byId(objectiveId);
      if (!root || root.workspaceId !== workspaceId) throw notFound('Objective');

      return {
        root,
        tasks: app.repos.tasks.listForObjective(objectiveId),
        delegations: app.repos.delegations.listForObjective(objectiveId),
        runs: app.repos.runs.listForObjective(objectiveId),
        events: app.repos.events.forObjective(objectiveId, 500),
      };
    }),
  );

  server.post(
    '/api/workspaces/:workspaceId/objectives/:objectiveId/cancel',
    route(app, async (request) => {
      const { workspaceId, objectiveId } = params<{ workspaceId: string; objectiveId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'task:cancel');

      const root = app.repos.tasks.byId(objectiveId);
      if (!root || root.workspaceId !== workspaceId) throw notFound('Objective');

      const actor = toActor(ctx.user);
      const reason = `Objective cancelled by ${ctx.user.displayName}`;

      const runs = app.scheduler.cancelObjective(objectiveId, actor, reason);
      const cancelled = app.workspaces.cancelTask({
        taskId: objectiveId,
        by: actor,
        reason,
        cascade: true,
      });

      // Cascade only reaches descendants; sibling tasks under the same
      // objective need cancelling explicitly.
      for (const task of app.repos.tasks.listForObjective(objectiveId)) {
        if (['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        app.workspaces.cancelTask({ taskId: task.id, by: actor, reason, cascade: false });
      }

      return { cancelledRuns: runs, cancelledTasks: cancelled.length };
    }),
  );

  // -- feedback --------------------------------------------------------------

  server.post(
    '/api/workspaces/:workspaceId/feedback',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'feedback:give');
      const actor = toActor(ctx.user);

      const input = body<{
        verdict?: FeedbackVerdict;
        comment?: string;
        agentId?: string;
        taskId?: string;
      }>(request);

      const verdict = input.verdict ?? 'comment';
      if (!['approve', 'reject', 'correct', 'comment'].includes(verdict)) {
        throw badRequest('verdict must be approve, reject, correct or comment');
      }

      const task = input.taskId ? app.repos.tasks.byId(input.taskId) : null;
      if (input.taskId && (!task || task.workspaceId !== workspaceId)) throw notFound('Task');

      const agentId =
        input.agentId ?? (task?.assignee?.type === 'agent' ? task.assignee.id : null);
      if (agentId) {
        const agent = app.repos.agents.byId(agentId);
        if (!agent || agent.workspaceId !== workspaceId) throw notFound('Agent');
      }

      const comment = String(input.comment ?? '').trim();

      const message = app.workspaces.postMessage({
        workspaceId,
        channel: task ? `task:${task.id}` : MAIN_CHANNEL,
        author: actor,
        kind: 'feedback',
        body: comment || `(${verdict})`,
        taskId: task?.id ?? null,
        recipient: agentId ? { type: 'agent', id: agentId } : null,
        metadata: { verdict },
      });

      const record = await app.memory.recordFeedback({
        workspaceId,
        verdict,
        comment,
        author: actor,
        agentId,
        taskId: task?.id ?? null,
        taskTitle: task?.title,
      });

      app.events.publish(workspaceId, {
        type: 'USER_FEEDBACK',
        actor,
        payload: {
          message,
          verdict,
          targetAgentId: agentId,
          taskId: task?.id ?? null,
          memoryId: record?.id ?? null,
        } as never,
        taskId: task?.id ?? null,
      });

      return reply.status(201).send({ message, memory: record });
    }),
  );
}

function toActor(user: { id: string; displayName: string }): ActorRef {
  return { type: 'user', id: user.id, name: user.displayName };
}
