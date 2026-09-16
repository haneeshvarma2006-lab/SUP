import {
  DEFAULT_WORKSPACE_ROSTER,
  DEFAULT_WORKSPACE_SETTINGS,
  EMPTY_AGENT_STATS,
  ID_PREFIXES,
  MAIN_CHANNEL,
  TERMINAL_TASK_STATUSES,
  extractMentions,
  findAgentTemplate,
  newId,
  slugify,
  truncate,
  type ActorRef,
  type Agent,
  type AgentTemplate,
  type ApprovalRequest,
  type DelegationEdge,
  type Membership,
  type Message,
  type MessageKind,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type User,
  type Workspace,
  type WorkspaceFile,
  type WorkspaceRole,
  type WorkspaceSettings,
} from '@sup/shared';
import type { Repositories } from '../db/repos/index.js';
import { VersionConflictError } from '../db/repos/tasks.js';
import type { EventBus } from '../events/eventBus.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../util/logger.js';
import { badRequest, conflict, notFound } from '../util/errors.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface CreateTaskInput {
  workspaceId: string;
  title: string;
  description: string;
  createdBy: ActorRef;
  assignee?: ActorRef | null;
  parentTaskId?: string | null;
  objectiveId?: string;
  dependsOn?: string[];
  depth?: number;
  priority?: TaskPriority;
  requiresHumanApproval?: boolean;
}

export interface PostMessageInput {
  workspaceId: string;
  channel?: string;
  author: ActorRef;
  body: string;
  kind?: MessageKind;
  recipient?: ActorRef | null;
  taskId?: string | null;
  runId?: string | null;
  parentId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Authoritative workspace state.
 *
 * Every mutation here does two things atomically from the caller's point of
 * view: it writes to the database and it publishes the event describing the
 * change. Nothing in the system mutates workspace state without going through
 * this service, which is what makes the event log a complete record rather than
 * a best-effort notification channel.
 */
export class WorkspaceService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventBus,
    private readonly tools: ToolRegistry,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  // -- workspaces -----------------------------------------------------------

  createWorkspace(input: {
    name: string;
    description?: string;
    owner: User;
    settings?: Partial<WorkspaceSettings>;
    roster?: readonly string[];
  }): { workspace: Workspace; agents: Agent[] } {
    const name = input.name.trim();
    if (!name || name.length > 80) throw badRequest('Workspace name must be 1-80 characters');

    const now = Date.now();
    const workspace: Workspace = {
      id: newId(ID_PREFIXES.workspace, now),
      slug: this.repos.workspaces.uniqueSlug(slugify(name)),
      name,
      description: (input.description ?? '').trim(),
      ownerId: input.owner.id,
      createdAt: now,
      updatedAt: now,
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...input.settings },
    };

    this.repos.workspaces.insert(workspace);
    this.repos.memberships.insert({
      id: newId(ID_PREFIXES.membership, now),
      workspaceId: workspace.id,
      userId: input.owner.id,
      role: 'owner',
      createdAt: now,
    });

    const agents: Agent[] = [];
    for (const key of input.roster ?? DEFAULT_WORKSPACE_ROSTER) {
      const template = findAgentTemplate(key);
      if (!template) {
        this.logger.warn('unknown agent template skipped', { key });
        continue;
      }
      agents.push(this.createAgentFromTemplate(workspace, template, { type: 'system', id: 'system' }));
    }

    return { workspace, agents };
  }

  addMember(workspaceId: string, userId: string, role: WorkspaceRole): Membership {
    const membership: Membership = {
      id: newId(ID_PREFIXES.membership),
      workspaceId,
      userId,
      role,
      createdAt: Date.now(),
    };
    return this.repos.memberships.insert(membership);
  }

  updateWorkspace(
    workspaceId: string,
    patch: Partial<Pick<Workspace, 'name' | 'description' | 'settings'>>,
    actor: ActorRef,
  ): Workspace {
    const updated = this.repos.workspaces.update(workspaceId, patch);
    if (!updated) throw notFound('Workspace');
    this.events.publish(workspaceId, {
      type: 'WORKSPACE_UPDATED',
      actor,
      payload: { workspace: updated } as never,
    });
    return updated;
  }

  // -- agents ---------------------------------------------------------------

  createAgentFromTemplate(workspace: Workspace, template: AgentTemplate, actor: ActorRef): Agent {
    return this.createAgent(
      {
        workspaceId: workspace.id,
        name: this.uniqueAgentName(workspace.id, template.name),
        role: template.role,
        tagline: template.tagline,
        avatarColor: template.avatarColor,
        avatarEmoji: template.avatarEmoji,
        systemInstructions: template.systemInstructions,
        capabilities: template.capabilities,
        model: workspace.settings.defaultModel,
        temperature: template.temperature ?? 0.3,
        isOrchestrator: template.isOrchestrator ?? false,
      },
      actor,
    );
  }

  createAgent(
    input: {
      workspaceId: string;
      name: string;
      role: string;
      tagline?: string;
      avatarColor?: string;
      avatarEmoji?: string;
      systemInstructions: string;
      capabilities: string[];
      model?: string;
      temperature?: number;
      maxConcurrency?: number;
      isOrchestrator?: boolean;
    },
    actor: ActorRef,
  ): Agent {
    const workspace = this.requireWorkspace(input.workspaceId);
    const name = input.name.trim();
    if (!name || name.length > 40) throw badRequest('Agent name must be 1-40 characters');
    if (!input.role.trim()) throw badRequest('Agent needs a role');

    if (this.repos.agents.byNameInWorkspace(input.workspaceId, name)) {
      throw conflict(`An agent named "${name}" already exists in this workspace`);
    }

    const unknown = this.tools.unknownCapabilities(input.capabilities);
    if (unknown.length > 0) {
      throw badRequest(`Unknown tool(s): ${unknown.join(', ')}`, {
        available: this.tools.descriptors().map((d) => d.name),
      });
    }

    if (input.isOrchestrator && this.repos.agents.orchestratorFor(input.workspaceId)) {
      throw conflict('This workspace already has an orchestrator');
    }

    const now = Date.now();
    const agent: Agent = {
      id: newId(ID_PREFIXES.agent, now),
      workspaceId: input.workspaceId,
      name,
      role: input.role.trim(),
      tagline: (input.tagline ?? '').trim(),
      avatarColor: input.avatarColor ?? '#7c8cff',
      avatarEmoji: input.avatarEmoji ?? '🤖',
      systemInstructions: input.systemInstructions,
      capabilities: [...new Set(input.capabilities)],
      model: input.model ?? workspace.settings.defaultModel,
      temperature: input.temperature ?? 0.3,
      status: 'idle',
      statusDetail: '',
      currentTaskId: null,
      currentRunId: null,
      maxConcurrency: Math.max(1, Math.min(4, input.maxConcurrency ?? 1)),
      enabled: true,
      paused: false,
      isOrchestrator: input.isOrchestrator ?? false,
      stats: { ...EMPTY_AGENT_STATS },
      createdAt: now,
      updatedAt: now,
    };

    this.repos.agents.insert(agent);
    this.events.publish(input.workspaceId, {
      type: 'AGENT_CREATED',
      actor,
      payload: { agent } as never,
    });
    return agent;
  }

  updateAgent(agentId: string, patch: Partial<Agent>, actor: ActorRef): Agent {
    const existing = this.repos.agents.byId(agentId);
    if (!existing) throw notFound('Agent');

    if (patch.capabilities) {
      const unknown = this.tools.unknownCapabilities(patch.capabilities);
      if (unknown.length > 0) throw badRequest(`Unknown tool(s): ${unknown.join(', ')}`);
    }
    if (patch.name && patch.name !== existing.name) {
      const clash = this.repos.agents.byNameInWorkspace(existing.workspaceId, patch.name);
      if (clash && clash.id !== agentId) throw conflict(`An agent named "${patch.name}" already exists`);
    }

    // Status and run pointers are owned by the runtime; a config edit must not
    // reach in and rewrite them.
    const safe: Partial<Agent> = { ...patch };
    delete safe.status;
    delete safe.currentRunId;
    delete safe.currentTaskId;
    delete safe.stats;
    delete safe.isOrchestrator;

    const updated = this.repos.agents.update(agentId, safe);
    if (!updated) throw notFound('Agent');
    this.events.publish(updated.workspaceId, {
      type: 'AGENT_UPDATED',
      actor,
      payload: { agent: updated } as never,
    });
    return updated;
  }

  deleteAgent(agentId: string, actor: ActorRef): void {
    const agent = this.repos.agents.byId(agentId);
    if (!agent) throw notFound('Agent');
    if (agent.isOrchestrator) throw badRequest('The orchestrator cannot be deleted');

    const active = this.repos.tasks
      .listForWorkspace(agent.workspaceId, 500)
      .filter((t) => t.assignee?.id === agentId && !TERMINAL_TASK_STATUSES.includes(t.status));
    if (active.length > 0) {
      throw conflict(`${agent.name} still has ${active.length} open task(s); reassign or cancel them first`);
    }

    this.repos.agents.delete(agentId);
    this.events.publish(agent.workspaceId, {
      type: 'AGENT_DELETED',
      actor,
      payload: { agentId } as never,
    });
  }

  uniqueAgentName(workspaceId: string, base: string): string {
    let candidate = base;
    let n = 1;
    while (this.repos.agents.byNameInWorkspace(workspaceId, candidate)) {
      n += 1;
      candidate = `${base} ${n}`;
    }
    return candidate;
  }

  // -- tasks ----------------------------------------------------------------

  createTask(input: CreateTaskInput): Task {
    const title = input.title.trim();
    if (!title) throw badRequest('Task needs a title');
    if (title.length > 200) throw badRequest('Task title is too long (200 char limit)');

    const now = Date.now();
    const id = newId(ID_PREFIXES.task, now);

    // Validate dependencies exist and belong to this workspace, so a bad id
    // cannot leave a task permanently unschedulable.
    const dependsOn = (input.dependsOn ?? []).filter((depId) => {
      const dep = this.repos.tasks.byId(depId);
      return dep !== null && dep.workspaceId === input.workspaceId && dep.id !== id;
    });

    const task: Task = {
      id,
      workspaceId: input.workspaceId,
      title,
      description: input.description.trim(),
      status: input.assignee ? 'assigned' : 'backlog',
      priority: input.priority ?? 'normal',
      createdBy: input.createdBy,
      assignee: input.assignee ?? null,
      parentTaskId: input.parentTaskId ?? null,
      objectiveId: input.objectiveId ?? id,
      dependsOn,
      depth: input.depth ?? 0,
      result: null,
      resultData: null,
      error: null,
      artifactIds: [],
      version: 1,
      lockedBy: null,
      lockExpiresAt: null,
      requiresHumanApproval: input.requiresHumanApproval ?? false,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };

    this.repos.tasks.insert(task);

    const drafts = [
      {
        type: 'TASK_CREATED' as const,
        actor: input.createdBy,
        payload: { task } as never,
        taskId: task.id,
        objectiveId: task.objectiveId,
      },
    ];
    if (task.assignee) {
      drafts.push({
        type: 'TASK_ASSIGNED' as never,
        actor: input.createdBy,
        payload: { task, assignee: task.assignee, by: input.createdBy } as never,
        taskId: task.id,
        objectiveId: task.objectiveId,
      });
    }
    this.events.publishBatch(input.workspaceId, drafts);

    return task;
  }

  /**
   * Applies a mutation under optimistic concurrency, retrying on conflict.
   *
   * Two agents updating the same task is normal — a reviewer annotating while
   * the owner posts progress. The loser re-reads and re-applies rather than
   * clobbering, and a task that has since gone terminal is left alone.
   */
  mutateTask(taskId: string, mutate: (task: Task) => Partial<Task> | null, attempts = 5): Task {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = this.repos.tasks.byId(taskId);
      if (!current) throw notFound('Task');

      const patch = mutate(current);
      if (!patch) return current;

      try {
        return this.repos.tasks.update(taskId, current.version, patch);
      } catch (err) {
        if (err instanceof VersionConflictError && attempt < attempts - 1) {
          this.logger.debug('task version conflict; retrying', { taskId, attempt });
          continue;
        }
        throw err;
      }
    }
    throw conflict(`Task ${taskId} is being modified too frequently; try again`);
  }

  assignTask(input: { taskId: string; assignee: ActorRef; by: ActorRef }): Task {
    const task = this.mutateTask(input.taskId, (current) => {
      if (TERMINAL_TASK_STATUSES.includes(current.status)) {
        throw conflict(`Task is already ${current.status}`);
      }
      return {
        assignee: input.assignee,
        status: current.status === 'backlog' ? 'assigned' : current.status,
      };
    });

    this.events.publish(task.workspaceId, {
      type: 'TASK_ASSIGNED',
      actor: input.by,
      payload: { task, assignee: input.assignee, by: input.by } as never,
      taskId: task.id,
      objectiveId: task.objectiveId,
    });
    return task;
  }

  updateTask(input: {
    taskId: string;
    by: ActorRef;
    patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'result' | 'error'>>;
  }): Task {
    const changed: string[] = [];
    const task = this.mutateTask(input.taskId, (current) => {
      const patch: Partial<Task> = {};
      const currentFields = current as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(input.patch)) {
        if (value !== undefined && value !== currentFields[key]) {
          (patch as Record<string, unknown>)[key] = value;
          changed.push(key);
        }
      }
      return Object.keys(patch).length > 0 ? patch : null;
    });

    if (changed.length > 0) {
      this.events.publish(task.workspaceId, {
        type: 'TASK_UPDATED',
        actor: input.by,
        payload: { task, changed } as never,
        taskId: task.id,
        objectiveId: task.objectiveId,
      });
    }
    return task;
  }

  completeTask(input: {
    taskId: string;
    by: ActorRef;
    result: string;
    resultData?: unknown;
    artifactIds?: string[];
  }): Task {
    const task = this.mutateTask(input.taskId, (current) => {
      if (current.status === 'completed') return null;
      return {
        status: 'completed' as TaskStatus,
        result: input.result,
        resultData: input.resultData ?? current.resultData,
        artifactIds: [...new Set([...current.artifactIds, ...(input.artifactIds ?? [])])],
        error: null,
        completedAt: Date.now(),
        lockedBy: null,
        lockExpiresAt: null,
      };
    });

    this.events.publish(task.workspaceId, {
      type: 'TASK_COMPLETED',
      actor: input.by,
      payload: { task } as never,
      taskId: task.id,
      objectiveId: task.objectiveId,
    });
    return task;
  }

  failTask(input: { taskId: string; by: ActorRef; error: string }): Task {
    const task = this.mutateTask(input.taskId, (current) => {
      if (TERMINAL_TASK_STATUSES.includes(current.status)) return null;
      return {
        status: 'failed' as TaskStatus,
        error: truncate(input.error, 2000),
        completedAt: Date.now(),
        lockedBy: null,
        lockExpiresAt: null,
      };
    });

    this.events.publish(task.workspaceId, {
      type: 'TASK_FAILED',
      actor: input.by,
      payload: { task, error: input.error } as never,
      taskId: task.id,
      objectiveId: task.objectiveId,
    });
    return task;
  }

  cancelTask(input: { taskId: string; by: ActorRef; reason: string; cascade?: boolean }): Task[] {
    const cancelled: Task[] = [];

    const cancelOne = (taskId: string) => {
      const task = this.mutateTask(taskId, (current) => {
        if (TERMINAL_TASK_STATUSES.includes(current.status)) return null;
        return {
          status: 'cancelled' as TaskStatus,
          error: input.reason,
          completedAt: Date.now(),
          lockedBy: null,
          lockExpiresAt: null,
        };
      });
      if (task.status !== 'cancelled') return;
      cancelled.push(task);
      this.events.publish(task.workspaceId, {
        type: 'TASK_CANCELLED',
        actor: input.by,
        payload: { task, by: input.by, reason: input.reason } as never,
        taskId: task.id,
        objectiveId: task.objectiveId,
      });

      if (input.cascade !== false) {
        // Children of a cancelled task have nothing left to serve.
        for (const child of this.repos.tasks.listChildren(task.id)) {
          if (!TERMINAL_TASK_STATUSES.includes(child.status)) cancelOne(child.id);
        }
      }
    };

    cancelOne(input.taskId);
    return cancelled;
  }

  blockTask(taskId: string, reason: string, by: ActorRef): Task {
    const task = this.mutateTask(taskId, (current) =>
      current.status === 'blocked' ? null : { status: 'blocked' as TaskStatus, error: reason },
    );
    this.events.publish(task.workspaceId, {
      type: 'TASK_BLOCKED',
      actor: by,
      payload: { task, reason } as never,
      taskId: task.id,
      objectiveId: task.objectiveId,
    });
    return task;
  }

  attachArtifact(taskId: string, fileId: string): void {
    try {
      this.mutateTask(taskId, (current) =>
        current.artifactIds.includes(fileId)
          ? null
          : { artifactIds: [...current.artifactIds, fileId] },
      );
    } catch (err) {
      this.logger.warn('could not attach artifact to task', { taskId, fileId, error: err });
    }
  }

  // -- delegation edges -----------------------------------------------------

  recordDelegation(input: {
    workspaceId: string;
    objectiveId: string;
    fromAgentId: string;
    toAgentId: string;
    taskId: string;
    relation: DelegationEdge['relation'];
    note: string;
    depth: number;
  }): DelegationEdge {
    const edge: DelegationEdge = {
      id: newId(ID_PREFIXES.delegation),
      ...input,
      note: truncate(input.note, 300),
      createdAt: Date.now(),
    };
    return this.repos.delegations.insert(edge);
  }

  // -- messages -------------------------------------------------------------

  postMessage(input: PostMessageInput): Message {
    const body = input.body.trim();
    if (!body) throw badRequest('Message body is empty');
    if (body.length > 20_000) throw badRequest('Message is too long (20k char limit)');

    const roster = this.mentionRoster(input.workspaceId);
    const now = Date.now();

    const message: Message = {
      id: newId(ID_PREFIXES.message, now),
      workspaceId: input.workspaceId,
      channel: input.channel ?? MAIN_CHANNEL,
      author: input.author,
      recipient: input.recipient ?? null,
      kind: input.kind ?? 'chat',
      body,
      mentions: extractMentions(body, roster),
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      parentId: input.parentId ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      editedAt: null,
    };

    this.repos.messages.insert(message);
    this.events.publish(input.workspaceId, {
      type: 'MESSAGE_CREATED',
      actor: input.author,
      payload: { message } as never,
      taskId: message.taskId,
      runId: message.runId,
    });
    return message;
  }

  /** Everyone who can be @mentioned: human members and agents. */
  mentionRoster(workspaceId: string): Array<{ type: 'user' | 'agent'; id: string; name: string }> {
    const agents = this.repos.agents.listForWorkspace(workspaceId);
    const members = this.repos.memberships.listForWorkspace(workspaceId);
    const users = this.repos.users.byIds(members.map((m) => m.userId));

    return [
      ...agents.map((a) => ({ type: 'agent' as const, id: a.id, name: a.name })),
      ...users.map((u) => ({ type: 'user' as const, id: u.id, name: u.displayName })),
    ];
  }

  // -- files ----------------------------------------------------------------

  writeFile(input: {
    workspaceId: string;
    path: string;
    content: string;
    mimeType?: string;
    author: ActorRef;
    taskId?: string | null;
  }): WorkspaceFile {
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > this.config.limits.maxFileBytes) {
      throw badRequest(`File exceeds the ${Math.round(this.config.limits.maxFileBytes / 1024)}KB limit`);
    }

    const now = Date.now();
    const { file, created } = this.repos.files.put({
      id: newId(ID_PREFIXES.file, now),
      workspaceId: input.workspaceId,
      path: input.path,
      mimeType: input.mimeType ?? 'text/markdown',
      size: bytes,
      content: input.content,
      version: 1,
      createdBy: input.author,
      taskId: input.taskId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    this.events.publish(input.workspaceId, {
      type: created ? 'FILE_CREATED' : 'FILE_UPDATED',
      actor: input.author,
      // Content is deliberately omitted from the event: files can be large and
      // every connected client would otherwise receive the whole body.
      payload: { file: { ...file, content: '' } } as never,
      taskId: file.taskId,
    });

    if (file.taskId) this.attachArtifact(file.taskId, file.id);
    return file;
  }

  deleteFile(fileId: string, actor: ActorRef): void {
    const file = this.repos.files.delete(fileId);
    if (!file) throw notFound('File');
    this.events.publish(file.workspaceId, {
      type: 'FILE_DELETED',
      actor,
      payload: { fileId, path: file.path } as never,
    });
  }

  // -- approvals ------------------------------------------------------------

  createApproval(input: {
    workspaceId: string;
    requestedBy: ActorRef;
    runId: string | null;
    taskId: string | null;
    action: string;
    reason: string;
    payload: unknown;
  }): ApprovalRequest {
    const now = Date.now();
    const approval: ApprovalRequest = {
      id: newId(ID_PREFIXES.approval, now),
      workspaceId: input.workspaceId,
      requestedBy: input.requestedBy,
      runId: input.runId,
      taskId: input.taskId,
      action: input.action,
      reason: input.reason,
      payload: input.payload,
      status: 'pending',
      resolvedBy: null,
      resolutionNote: '',
      createdAt: now,
      expiresAt: now + this.config.limits.approvalTtlMs,
      resolvedAt: null,
    };

    this.repos.approvals.insert(approval);
    this.events.publish(input.workspaceId, {
      type: 'APPROVAL_REQUESTED',
      actor: input.requestedBy,
      payload: { approval } as never,
      runId: approval.runId,
      taskId: approval.taskId,
    });
    return approval;
  }

  resolveApproval(input: {
    approvalId: string;
    approved: boolean;
    resolvedBy: ActorRef;
    note?: string;
  }): ApprovalRequest {
    const resolved = this.repos.approvals.resolve(
      input.approvalId,
      input.approved ? 'approved' : 'rejected',
      input.resolvedBy,
      input.note ?? '',
    );
    if (!resolved) {
      const existing = this.repos.approvals.byId(input.approvalId);
      if (!existing) throw notFound('Approval request');
      throw conflict(`This request was already ${existing.status}`);
    }

    this.events.publish(resolved.workspaceId, {
      type: 'APPROVAL_RESOLVED',
      actor: input.resolvedBy,
      payload: { approval: resolved } as never,
      runId: resolved.runId,
      taskId: resolved.taskId,
    });
    return resolved;
  }

  expireApprovals(): void {
    for (const approval of this.repos.approvals.expireOverdue(Date.now())) {
      const refreshed = this.repos.approvals.byId(approval.id);
      if (!refreshed) continue;
      this.events.publish(refreshed.workspaceId, {
        type: 'APPROVAL_RESOLVED',
        actor: { type: 'system', id: 'system', name: 'System' },
        payload: { approval: refreshed } as never,
        runId: refreshed.runId,
        taskId: refreshed.taskId,
      });
    }
  }

  // -- helpers --------------------------------------------------------------

  requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.repos.workspaces.byId(workspaceId);
    if (!workspace) throw notFound('Workspace');
    return workspace;
  }

  requireTask(taskId: string): Task {
    const task = this.repos.tasks.byId(taskId);
    if (!task) throw notFound('Task');
    return task;
  }

  requireAgent(agentId: string): Agent {
    const agent = this.repos.agents.byId(agentId);
    if (!agent) throw notFound('Agent');
    return agent;
  }
}
