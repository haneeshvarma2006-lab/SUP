import { TOOL_NAMES, truncate, type TaskPriority } from '@sup/shared';
import {
  fail,
  ok,
  readString,
  readStringArray,
  schema,
  type Tool,
  type ToolContext,
  type ToolResult,
} from '../types.js';

/**
 * Task management and delegation.
 *
 * `delegate_task` is the centre of the multi-agent design: it creates the task,
 * records the delegation edge, starts the other agent, and blocks the caller
 * until a result comes back. Loop prevention (depth, budget, cycles) lives in
 * the orchestration layer and is enforced before any of this runs.
 */

function resolveAgent(ctx: ToolContext, nameOrId: string) {
  const byId = ctx.repos.agents.byId(nameOrId);
  if (byId && byId.workspaceId === ctx.workspace.id) return byId;
  return ctx.repos.agents.byNameInWorkspace(ctx.workspace.id, nameOrId.replace(/^@/, ''));
}

function readPriority(input: Record<string, unknown>): TaskPriority {
  const raw = readString(input, 'priority', 'normal');
  return raw === 'low' || raw === 'high' || raw === 'urgent' ? raw : 'normal';
}

export const createTaskTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.createTask,
    category: 'tasks',
    title: 'Create task',
    description:
      'Create a task in the shared board without starting it. Use when work needs to be tracked but is not ready to run.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        title: { type: 'string', description: 'Short, concrete deliverable.' },
        description: { type: 'string', description: 'What done looks like.' },
        assignee: { type: 'string', description: 'Optional agent name to assign it to.' },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids that must complete before this one can start.',
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      },
      ['title'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const title = readString(input, 'title').trim();
    if (!title) return fail('create_task needs a title');

    const assigneeName = readString(input, 'assignee').trim();
    const assignee = assigneeName ? resolveAgent(ctx, assigneeName) : null;
    if (assigneeName && !assignee) return fail(`No agent named "${assigneeName}"`);

    const task = ctx.services.createTask({
      workspaceId: ctx.workspace.id,
      title,
      description: readString(input, 'description'),
      createdBy: ctx.actor,
      assignee: assignee ? { type: 'agent', id: assignee.id, name: assignee.name } : null,
      parentTaskId: ctx.task?.id ?? null,
      objectiveId: ctx.objectiveId,
      dependsOn: readStringArray(input, 'depends_on'),
      depth: ctx.depth + 1,
      priority: readPriority(input),
    });

    return ok(`Created task "${truncate(title, 60)}"`, {
      task_id: task.id,
      title: task.title,
      status: task.status,
    });
  },
};

export const assignTaskTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.assignTask,
    category: 'tasks',
    title: 'Assign task',
    description:
      'Assign an existing task to an agent. The scheduler picks it up once its dependencies are met.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        task_id: { type: 'string', description: 'Id of the task to assign.' },
        agent: { type: 'string', description: 'Name of the agent to assign it to.' },
      },
      ['task_id', 'agent'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const taskId = readString(input, 'task_id').trim();
    const agentName = readString(input, 'agent').trim();
    const target = resolveAgent(ctx, agentName);
    if (!target) return fail(`No agent named "${agentName}"`);

    const task = ctx.repos.tasks.byId(taskId);
    if (!task || task.workspaceId !== ctx.workspace.id) return fail(`No task with id ${taskId}`);

    const updated = ctx.services.assignTask({
      taskId,
      assignee: { type: 'agent', id: target.id, name: target.name },
      by: ctx.actor,
    });

    return ok(`Assigned "${truncate(updated.title, 50)}" to ${target.name}`, {
      task_id: updated.id,
      assignee: target.name,
      status: updated.status,
    });
  },
};

export const delegateTaskTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.delegateTask,
    category: 'tasks',
    title: 'Delegate task',
    description:
      'Hand a piece of work to a teammate and wait for their result. ' +
      'Delegate each piece exactly once — if you already delegated it, wait rather than delegating again.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        agent: { type: 'string', description: 'Name of the agent to delegate to.' },
        title: { type: 'string', description: 'Short, concrete deliverable for them to produce.' },
        description: {
          type: 'string',
          description: 'Full brief: context, what done looks like, and any constraint they must honour.',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids that must complete first.',
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      },
      ['agent', 'title'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const agentName = readString(input, 'agent').trim();
    const title = readString(input, 'title').trim();
    if (!agentName || !title) return fail('delegate_task needs an agent and a title');

    const target = resolveAgent(ctx, agentName);
    if (!target) {
      const roster = ctx.repos.agents
        .listForWorkspace(ctx.workspace.id)
        .filter((a) => a.id !== ctx.agent.id)
        .map((a) => `${a.name} (${a.role})`);
      return fail(`No agent named "${agentName}"`, `Available agents: ${roster.join(', ')}`);
    }
    if (target.id === ctx.agent.id) return fail('An agent cannot delegate to itself');

    const outcome = await ctx.services.delegateAndWait({
      ctx,
      toAgentId: target.id,
      title,
      description: readString(input, 'description') || title,
      dependsOn: readStringArray(input, 'depends_on'),
      relation: 'delegate',
      priority: readPriority(input),
    });

    if (!outcome.ok) {
      return fail(`${target.name} did not complete "${truncate(title, 50)}"`, outcome.error ?? undefined);
    }

    return ok(`${target.name} completed "${truncate(title, 50)}"`, {
      task_id: outcome.taskId,
      agent: target.name,
      result: outcome.result,
    });
  },
};

export const requestReviewTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.requestReview,
    category: 'tasks',
    title: 'Request review',
    description:
      'Send your work to a reviewer and wait for their verdict. Use before returning anything non-trivial.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        agent: { type: 'string', description: 'Name of the reviewing agent.' },
        work: { type: 'string', description: 'The work to be reviewed, in full.' },
        context: { type: 'string', description: 'What the work was supposed to achieve.' },
      },
      ['agent', 'work'],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const agentName = readString(input, 'agent').trim();
    const work = readString(input, 'work').trim();
    if (!work) return fail('request_review needs the work to review');

    const target = resolveAgent(ctx, agentName);
    if (!target) return fail(`No agent named "${agentName}"`);
    if (target.id === ctx.agent.id) return fail('An agent cannot review its own work');

    const brief = readString(input, 'context') || ctx.task?.description || ctx.task?.title || '';

    const outcome = await ctx.services.delegateAndWait({
      ctx,
      toAgentId: target.id,
      title: `Review: ${truncate(ctx.task?.title ?? 'work from ' + ctx.agent.name, 60)}`,
      description: [
        `${ctx.agent.name} has asked you to review the following work.`,
        brief ? `\nOriginal brief:\n${brief}` : '',
        `\nWork to review:\n${work}`,
      ].join('\n'),
      dependsOn: [],
      relation: 'review',
      priority: 'high',
    });

    if (!outcome.ok) return fail(`${target.name} could not review the work`, outcome.error ?? undefined);

    const approved = /^\s*APPROVED\b/im.test(outcome.result);
    return ok(`${target.name}: ${approved ? 'APPROVED' : 'changes requested'}`, {
      task_id: outcome.taskId,
      reviewer: target.name,
      approved,
      review: outcome.result,
    });
  },
};

export const updateTaskTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.updateTask,
    category: 'tasks',
    title: 'Update task',
    description:
      'Update the task you are working on — its description, priority, or a progress note. ' +
      'Does not close the task; use return_result for that.',
    risk: 'guarded',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        task_id: { type: 'string', description: 'Task to update. Defaults to your current task.' },
        description: { type: 'string', description: 'Replacement description.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        note: { type: 'string', description: 'Progress note posted to the task thread.' },
      },
      [],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const taskId = readString(input, 'task_id').trim() || ctx.task?.id;
    if (!taskId) return fail('No task to update');

    const task = ctx.repos.tasks.byId(taskId);
    if (!task || task.workspaceId !== ctx.workspace.id) return fail(`No task with id ${taskId}`);

    // An agent may only edit its own task or a task it created — otherwise one
    // agent could quietly rewrite another's brief mid-flight.
    const owns =
      task.assignee?.id === ctx.agent.id ||
      task.createdBy.id === ctx.agent.id ||
      ctx.agent.isOrchestrator;
    if (!owns) return fail('You can only update tasks you own or created');

    const patch: Record<string, unknown> = {};
    const description = readString(input, 'description');
    if (description) patch.description = description;
    const priority = readString(input, 'priority');
    if (priority) patch.priority = readPriority(input);

    const updated =
      Object.keys(patch).length > 0
        ? ctx.services.updateTask({ taskId, by: ctx.actor, patch })
        : task;

    const note = readString(input, 'note').trim();
    if (note) {
      ctx.services.postAgentMessage({
        ctx,
        channel: `task:${taskId}`,
        body: note,
        kind: 'system',
      });
    }

    return ok(`Updated "${truncate(updated.title, 50)}"`, {
      task_id: updated.id,
      status: updated.status,
    });
  },
};

export const listTasksTool: Tool = {
  descriptor: {
    name: TOOL_NAMES.listTasks,
    category: 'tasks',
    title: 'List tasks',
    description: 'See the current state of the task board so you know what is already in flight.',
    risk: 'safe',
    requiresApproval: false,
    orchestratorOnly: false,
    parameters: schema(
      {
        scope: {
          type: 'string',
          enum: ['objective', 'workspace', 'mine'],
          description: 'Which tasks to list. Defaults to the current objective.',
        },
      },
      [],
    ),
  },
  async execute(input, ctx): Promise<ToolResult> {
    const scope = readString(input, 'scope', 'objective');
    const tasks =
      scope === 'workspace'
        ? ctx.repos.tasks.listForWorkspace(ctx.workspace.id, 100)
        : scope === 'mine'
          ? ctx.repos.tasks
              .listForWorkspace(ctx.workspace.id, 200)
              .filter((t) => t.assignee?.id === ctx.agent.id)
          : ctx.repos.tasks.listForObjective(ctx.objectiveId);

    return ok(`${tasks.length} task(s)`, {
      tasks: tasks.map((t) => ({
        task_id: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee?.name ?? null,
        depends_on: t.dependsOn,
      })),
    });
  },
};

export const taskTools: Tool[] = [
  createTaskTool,
  assignTaskTool,
  delegateTaskTool,
  requestReviewTool,
  updateTaskTool,
  listTasksTool,
];
