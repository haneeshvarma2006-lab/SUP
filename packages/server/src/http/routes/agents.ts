import type { FastifyInstance } from 'fastify';
import { findAgentTemplate, type ActorRef } from '@sup/shared';
import type { App } from '../../app.js';
import { body, params, query, requireWorkspace, route } from '../context.js';
import { badRequest, notFound } from '../../util/errors.js';

export function registerAgentRoutes(server: FastifyInstance, app: App): void {
  server.get(
    '/api/workspaces/:workspaceId/agents',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'agent:read');
      return { agents: app.repos.agents.listForWorkspace(workspaceId) };
    }),
  );

  server.post(
    '/api/workspaces/:workspaceId/agents',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'agent:create');
      const actor = toActor(ctx.user);

      const input = body<{
        template?: string;
        name?: string;
        role?: string;
        tagline?: string;
        avatarEmoji?: string;
        avatarColor?: string;
        systemInstructions?: string;
        capabilities?: string[];
        model?: string;
        temperature?: number;
        maxConcurrency?: number;
      }>(request);

      // A template is a starting point, not a constraint: any field may be
      // overridden, and a fully custom agent needs no template at all.
      const template = input.template ? findAgentTemplate(input.template) : undefined;
      if (input.template && !template) throw badRequest(`Unknown template "${input.template}"`);

      const workspace = app.workspaces.requireWorkspace(workspaceId);
      const name = input.name ?? template?.name;
      const role = input.role ?? template?.role;
      const systemInstructions = input.systemInstructions ?? template?.systemInstructions;
      const capabilities = input.capabilities ?? template?.capabilities;

      if (!name || !role || !systemInstructions || !capabilities) {
        throw badRequest(
          'An agent needs a name, role, systemInstructions and capabilities (or a template that supplies them)',
        );
      }

      const agent = app.workspaces.createAgent(
        {
          workspaceId,
          name: app.workspaces.uniqueAgentName(workspaceId, name),
          role,
          tagline: input.tagline ?? template?.tagline,
          avatarEmoji: input.avatarEmoji ?? template?.avatarEmoji,
          avatarColor: input.avatarColor ?? template?.avatarColor,
          systemInstructions,
          capabilities,
          model: input.model ?? workspace.settings.defaultModel,
          temperature: input.temperature ?? template?.temperature,
          maxConcurrency: input.maxConcurrency,
          // Orchestrator status is never granted through this route; a
          // workspace has exactly one, created with the workspace.
          isOrchestrator: false,
        },
        actor,
      );

      return reply.status(201).send({ agent });
    }),
  );

  server.get(
    '/api/agents/:agentId',
    route(app, async (request) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      requireWorkspace(app, request, agent.workspaceId, 'agent:read');

      const runs = app.repos.runs.listForAgent(agentId, 20);
      const tasks = app.repos.tasks
        .listForWorkspace(agent.workspaceId, 300)
        .filter((t) => t.assignee?.id === agentId);

      return {
        agent,
        runs,
        tasks: tasks.slice(0, 50),
        // Agent-private memory plus what this agent contributed to the project.
        memories: app.repos.memories
          .list({ workspaceId: agent.workspaceId, agentId, limit: 100 })
          .filter((m) => m.agentId === agentId),
        recentTools: app.repos.toolAudit.listForAgent(agentId, 30),
        capabilities: app.tools
          .descriptors()
          .filter((d) => agent.capabilities.includes(d.name)),
      };
    }),
  );

  server.get(
    '/api/agents/:agentId/runs/:runId',
    route(app, async (request) => {
      const { agentId, runId } = params<{ agentId: string; runId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      requireWorkspace(app, request, agent.workspaceId, 'agent:read');

      const run = app.repos.runs.byId(runId, true);
      if (!run || run.agentId !== agentId) throw notFound('Run');
      return { run };
    }),
  );

  server.patch(
    '/api/agents/:agentId',
    route(app, async (request) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      const ctx = requireWorkspace(app, request, agent.workspaceId, 'agent:update');

      const input = body<Record<string, unknown>>(request);
      const allowed = [
        'name',
        'role',
        'tagline',
        'avatarEmoji',
        'avatarColor',
        'systemInstructions',
        'capabilities',
        'model',
        'temperature',
        'maxConcurrency',
        'enabled',
      ];
      const patch: Record<string, unknown> = {};
      for (const key of allowed) {
        if (input[key] !== undefined) patch[key] = input[key];
      }

      return { agent: app.workspaces.updateAgent(agentId, patch, toActor(ctx.user)) };
    }),
  );

  server.delete(
    '/api/agents/:agentId',
    route(app, async (request, reply) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      const ctx = requireWorkspace(app, request, agent.workspaceId, 'agent:delete');

      app.workspaces.deleteAgent(agentId, toActor(ctx.user));
      return reply.status(204).send();
    }),
  );

  // -- control ---------------------------------------------------------------

  server.post(
    '/api/agents/:agentId/pause',
    route(app, async (request) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      const ctx = requireWorkspace(app, request, agent.workspaceId, 'agent:control');
      const actor = toActor(ctx.user);

      const updated = app.repos.agents.update(agentId, { paused: true });
      app.status.set(agent, 'paused', `Paused by ${ctx.user.displayName}`, { actor });

      app.events.publish(agent.workspaceId, {
        type: 'AGENT_PAUSED',
        actor,
        payload: { agentId, by: actor } as never,
      });

      return { agent: updated };
    }),
  );

  server.post(
    '/api/agents/:agentId/resume',
    route(app, async (request) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      const ctx = requireWorkspace(app, request, agent.workspaceId, 'agent:control');
      const actor = toActor(ctx.user);

      const updated = app.repos.agents.update(agentId, { paused: false });
      if (updated) app.status.set(updated, 'idle', '', { taskId: null, runId: null, actor });

      app.events.publish(agent.workspaceId, {
        type: 'AGENT_RESUMED',
        actor,
        payload: { agentId, by: actor } as never,
      });

      // Work assigned while paused becomes runnable the moment it resumes.
      app.scheduler.dispatchReady(agent.workspaceId);
      return { agent: updated };
    }),
  );

  server.post(
    '/api/agents/:agentId/stop',
    route(app, async (request) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      const ctx = requireWorkspace(app, request, agent.workspaceId, 'agent:control');
      const input = body<{ reason?: string }>(request);

      const reason = input.reason?.trim() || `Stopped by ${ctx.user.displayName}`;
      const cancelled = app.scheduler.cancelAgent(agentId, toActor(ctx.user), reason);
      return { cancelledRuns: cancelled };
    }),
  );

  server.post(
    '/api/agents/:agentId/mention',
    route(app, async (request, reply) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      const ctx = requireWorkspace(app, request, agent.workspaceId, 'task:create');
      const input = body<{ instruction?: string }>(request);

      const instruction = String(input.instruction ?? '').trim();
      if (!instruction) throw badRequest('An instruction is required');

      app.orchestration.mentionAgent({
        workspaceId: agent.workspaceId,
        agentId,
        instruction,
        by: ctx.user,
      });

      return reply.status(202).send({ started: true });
    }),
  );

  server.get(
    '/api/agents/:agentId/activity',
    route(app, async (request) => {
      const { agentId } = params<{ agentId: string }>(request);
      const agent = app.repos.agents.byId(agentId);
      if (!agent) throw notFound('Agent');
      requireWorkspace(app, request, agent.workspaceId, 'agent:read');
      const { limit } = query<{ limit?: string }>(request);

      const max = Math.min(200, Number.parseInt(limit ?? '50', 10) || 50);
      const runs = app.repos.runs.listForAgent(agentId, 10);

      return {
        runs: runs.map((run) => ({ ...run, steps: app.repos.runs.stepsFor(run.id) })).slice(0, max),
      };
    }),
  );
}

function toActor(user: { id: string; displayName: string }): ActorRef {
  return { type: 'user', id: user.id, name: user.displayName };
}
