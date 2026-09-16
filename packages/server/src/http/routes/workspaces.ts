import type { FastifyInstance } from 'fastify';
import { AGENT_TEMPLATES, type WorkspaceRole, type WorkspaceSettings } from '@sup/shared';
import type { App } from '../../app.js';
import { body, currentUser, params, query, requireWorkspace, route } from '../context.js';
import { badRequest, notFound } from '../../util/errors.js';

export function registerWorkspaceRoutes(server: FastifyInstance, app: App): void {
  server.get(
    '/api/workspaces',
    route(app, async (request) => {
      const user = currentUser(app, request);
      return { workspaces: app.repos.workspaces.listForUser(user.id) };
    }),
  );

  server.post(
    '/api/workspaces',
    route(app, async (request, reply) => {
      const user = currentUser(app, request);
      const input = body<{
        name?: string;
        description?: string;
        roster?: string[];
        settings?: Partial<WorkspaceSettings>;
      }>(request);

      const created = app.workspaces.createWorkspace({
        name: String(input.name ?? ''),
        description: input.description,
        owner: user,
        settings: input.settings,
        roster: Array.isArray(input.roster) && input.roster.length > 0 ? input.roster : undefined,
      });

      return reply.status(201).send({
        workspace: created.workspace,
        agents: created.agents,
      });
    }),
  );

  server.get(
    '/api/workspaces/:workspaceId',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'workspace:read');
      return { snapshot: app.snapshots.build(workspaceId, ctx.user, ctx.role) };
    }),
  );

  server.patch(
    '/api/workspaces/:workspaceId',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'workspace:update');
      const input = body<{ name?: string; description?: string; settings?: Partial<WorkspaceSettings> }>(request);

      return {
        workspace: app.workspaces.updateWorkspace(
          workspaceId,
          {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.settings !== undefined ? { settings: input.settings as WorkspaceSettings } : {}),
          },
          { type: 'user', id: ctx.user.id, name: ctx.user.displayName },
        ),
      };
    }),
  );

  server.get(
    '/api/workspaces/:workspaceId/members',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'workspace:read');

      const memberships = app.repos.memberships.listForWorkspace(workspaceId);
      const users = app.repos.users.byIds(memberships.map((m) => m.userId));
      const byId = new Map(users.map((u) => [u.id, u]));

      return {
        members: memberships.map((m) => ({
          role: m.role,
          joinedAt: m.createdAt,
          user: byId.get(m.userId)
            ? {
                id: m.userId,
                displayName: byId.get(m.userId)!.displayName,
                email: byId.get(m.userId)!.email,
                avatarColor: byId.get(m.userId)!.avatarColor,
              }
            : null,
        })),
      };
    }),
  );

  server.post(
    '/api/workspaces/:workspaceId/members',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'workspace:invite');
      const input = body<{ email?: string; role?: WorkspaceRole }>(request);

      const invitee = app.repos.users.byEmail(String(input.email ?? '').toLowerCase());
      if (!invitee) throw notFound('No account with that email');

      const role = input.role ?? 'member';
      if (!['owner', 'admin', 'member', 'viewer'].includes(role)) throw badRequest('Invalid role');
      if (role === 'owner') throw badRequest('Ownership is transferred, not granted');

      const membership = app.workspaces.addMember(workspaceId, invitee.id, role);
      return reply.status(201).send({ membership });
    }),
  );

  server.get(
    '/api/workspaces/:workspaceId/events',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'workspace:read');
      const { since, limit } = query<{ since?: string; limit?: string }>(request);

      const fromSeq = Number.parseInt(since ?? '0', 10) || 0;
      const max = Math.min(1000, Number.parseInt(limit ?? '200', 10) || 200);

      return {
        events: app.events.replay(workspaceId, fromSeq, max),
        currentSeq: app.events.currentSeq(workspaceId),
        oldestSeq: app.events.oldestRetainedSeq(workspaceId),
      };
    }),
  );

  server.get(
    '/api/workspaces/:workspaceId/stats',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'workspace:read');

      return {
        tasks: app.repos.tasks.countByStatus(workspaceId),
        memories: app.memory.countFor(workspaceId),
        agents: app.repos.agents.listForWorkspace(workspaceId).length,
        activeRuns: app.repos.runs.listActive(workspaceId).length,
        presence: app.presence.list(workspaceId).length,
        eventSeq: app.events.currentSeq(workspaceId),
      };
    }),
  );

  /** Blueprints available when creating a new agent. */
  server.get(
    '/api/agent-templates',
    route(app, async () => ({ templates: AGENT_TEMPLATES })),
  );

  server.get(
    '/api/tools',
    route(app, async () => ({ tools: app.tools.descriptors() })),
  );
}
