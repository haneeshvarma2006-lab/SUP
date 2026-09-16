import {
  roleHasPermission,
  type Agent,
  type Permission,
  type Task,
  type User,
  type WorkspaceRole,
} from '@sup/shared';
import { forbidden, notFound } from '../util/errors.js';
import type { Repositories } from '../db/repos/index.js';

export interface WorkspaceContext {
  workspaceId: string;
  user: User;
  role: WorkspaceRole;
}

/**
 * Central authorization. Every mutating path in the HTTP layer and every tool
 * call goes through this service — there is no second place that decides.
 */
export class PermissionService {
  constructor(private readonly repos: Repositories) {}

  /** Resolves the caller's context in a workspace, or throws. */
  contextFor(workspaceId: string, user: User): WorkspaceContext {
    const workspace = this.repos.workspaces.byId(workspaceId);
    if (!workspace) throw notFound('Workspace');
    const membership = this.repos.memberships.find(workspaceId, user.id);
    if (!membership) {
      // Deliberately a 404, not a 403: a non-member should not learn the
      // workspace exists.
      throw notFound('Workspace');
    }
    return { workspaceId, user, role: membership.role };
  }

  can(ctx: WorkspaceContext, permission: Permission): boolean {
    return roleHasPermission(ctx.role, permission);
  }

  require(ctx: WorkspaceContext, permission: Permission): void {
    if (!this.can(ctx, permission)) {
      throw forbidden(`Your role (${ctx.role}) cannot perform "${permission}"`, {
        permission,
        role: ctx.role,
      });
    }
  }

  /**
   * Task ownership: the creator, the assignee, and anyone with admin rights may
   * change a task. Plain members cannot reassign work they do not own.
   */
  requireTaskControl(ctx: WorkspaceContext, task: Task): void {
    if (task.workspaceId !== ctx.workspaceId) throw notFound('Task');
    if (roleHasPermission(ctx.role, 'member:manage')) return; // admin and above
    const isCreator = task.createdBy.type === 'user' && task.createdBy.id === ctx.user.id;
    const isAssignee = task.assignee?.type === 'user' && task.assignee.id === ctx.user.id;
    // Members may control work they created, are assigned, or that an agent
    // is doing on their behalf within their own workspace.
    if (isCreator || isAssignee) return;
    this.require(ctx, 'task:update');
  }

  requireAgentControl(ctx: WorkspaceContext, agent: Agent): void {
    if (agent.workspaceId !== ctx.workspaceId) throw notFound('Agent');
    this.require(ctx, 'agent:control');
  }

  /**
   * Agent tool authorization. An agent may call a tool only when the tool is in
   * its capability list. This is checked at execution time, not at prompt
   * construction time, so a model that hallucinates a tool name it was never
   * given is refused rather than served.
   */
  agentCanUseTool(agent: Agent, toolName: string): boolean {
    return agent.capabilities.includes(toolName);
  }
}
