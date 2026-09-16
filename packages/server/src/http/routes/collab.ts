import type { FastifyInstance } from 'fastify';
import {
  MAIN_CHANNEL,
  type ActorRef,
  type MemoryKind,
  type MemoryScope,
} from '@sup/shared';
import type { App } from '../../app.js';
import { body, params, query, requireWorkspace, route } from '../context.js';
import { badRequest, notFound } from '../../util/errors.js';
import { normaliseWorkspacePath } from '../../tools/builtin/files.js';

/** Messages, memory, files and approvals — the shared-workspace surfaces. */
export function registerCollabRoutes(server: FastifyInstance, app: App): void {
  // -- messages --------------------------------------------------------------

  server.get(
    '/api/workspaces/:workspaceId/messages',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'workspace:read');
      const { channel, limit, before } = query<{ channel?: string; limit?: string; before?: string }>(request);

      const max = Math.min(500, Number.parseInt(limit ?? '100', 10) || 100);
      const beforeTs = before ? Number.parseInt(before, 10) : undefined;

      return {
        messages: channel
          ? app.repos.messages.listChannel(workspaceId, channel, max, beforeTs)
          : app.repos.messages.listRecent(workspaceId, max),
      };
    }),
  );

  server.post(
    '/api/workspaces/:workspaceId/messages',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'message:send');
      const input = body<{ body?: string; channel?: string; taskId?: string; parentId?: string }>(request);

      const message = app.workspaces.postMessage({
        workspaceId,
        channel: input.channel ?? MAIN_CHANNEL,
        author: toActor(ctx.user),
        body: String(input.body ?? ''),
        kind: 'chat',
        taskId: input.taskId ?? null,
        parentId: input.parentId ?? null,
      });

      // Mentions are acted on by the reactor, which sees MESSAGE_CREATED.
      return reply.status(201).send({ message, mentioned: message.mentions });
    }),
  );

  // -- memory ----------------------------------------------------------------

  server.get(
    '/api/workspaces/:workspaceId/memory',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'memory:read');
      const { q, scope, kind, agentId, limit } = query<{
        q?: string;
        scope?: MemoryScope;
        kind?: MemoryKind;
        agentId?: string;
        limit?: string;
      }>(request);

      const max = Math.min(100, Number.parseInt(limit ?? '50', 10) || 50);

      if (q) {
        const hits = await app.memory.search({
          workspaceId,
          query: q,
          scopes: scope ? [scope] : undefined,
          kinds: kind ? [kind] : undefined,
          agentId: agentId ?? null,
          includeOtherAgents: true,
          limit: max,
        } as never);
        return { hits };
      }

      return {
        hits: app.repos.memories
          .list({
            workspaceId,
            scopes: scope ? [scope] : undefined,
            kinds: kind ? [kind] : undefined,
            agentId: agentId ?? undefined,
            includeOtherAgents: true,
            limit: max,
          })
          .map((record) => ({
            record,
            score: record.importance,
            breakdown: { semantic: 0, keyword: 0, importance: record.importance, recency: 0 },
          })),
      };
    }),
  );

  server.post(
    '/api/workspaces/:workspaceId/memory',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'memory:write');
      const input = body<{
        title?: string;
        content?: string;
        scope?: MemoryScope;
        kind?: MemoryKind;
        tags?: string[];
        importance?: number;
        pinned?: boolean;
        agentId?: string;
        taskId?: string;
      }>(request);

      const record = await app.memory.write({
        workspaceId,
        scope: input.scope ?? 'project',
        kind: input.kind ?? 'fact',
        title: String(input.title ?? ''),
        content: String(input.content ?? ''),
        createdBy: toActor(ctx.user),
        agentId: input.agentId ?? null,
        taskId: input.taskId ?? null,
        tags: input.tags,
        importance: input.importance,
        pinned: input.pinned,
        source: 'human',
      });

      return reply.status(201).send({ record });
    }),
  );

  server.patch(
    '/api/memory/:memoryId',
    route(app, async (request) => {
      const { memoryId } = params<{ memoryId: string }>(request);
      const existing = app.memory.byId(memoryId);
      if (!existing) throw notFound('Memory');
      const ctx = requireWorkspace(app, request, existing.workspaceId, 'memory:write');

      const input = body<Record<string, unknown>>(request);
      const patch: Record<string, unknown> = {};
      for (const key of ['title', 'content', 'tags', 'kind', 'scope', 'importance', 'pinned']) {
        if (input[key] !== undefined) patch[key] = input[key];
      }

      return { record: await app.memory.update(memoryId, patch, toActor(ctx.user)) };
    }),
  );

  server.delete(
    '/api/memory/:memoryId',
    route(app, async (request, reply) => {
      const { memoryId } = params<{ memoryId: string }>(request);
      const existing = app.memory.byId(memoryId);
      if (!existing) throw notFound('Memory');
      const ctx = requireWorkspace(app, request, existing.workspaceId, 'memory:delete');

      app.memory.delete(memoryId, toActor(ctx.user));
      return reply.status(204).send();
    }),
  );

  // -- files -----------------------------------------------------------------

  server.get(
    '/api/workspaces/:workspaceId/files',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'file:read');
      return { files: app.repos.files.listForWorkspace(workspaceId, false) };
    }),
  );

  server.get(
    '/api/files/:fileId',
    route(app, async (request) => {
      const { fileId } = params<{ fileId: string }>(request);
      const file = app.repos.files.byId(fileId);
      if (!file) throw notFound('File');
      requireWorkspace(app, request, file.workspaceId, 'file:read');
      return { file };
    }),
  );

  server.post(
    '/api/workspaces/:workspaceId/files',
    route(app, async (request, reply) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      const ctx = requireWorkspace(app, request, workspaceId, 'file:write');
      const input = body<{ path?: string; content?: string; mimeType?: string; taskId?: string }>(request);

      const path = normaliseWorkspacePath(String(input.path ?? ''));
      if (!path) throw badRequest('Invalid file path');

      const file = app.workspaces.writeFile({
        workspaceId,
        path,
        content: String(input.content ?? ''),
        mimeType: input.mimeType,
        author: toActor(ctx.user),
        taskId: input.taskId ?? null,
      });

      return reply.status(201).send({ file });
    }),
  );

  server.delete(
    '/api/files/:fileId',
    route(app, async (request, reply) => {
      const { fileId } = params<{ fileId: string }>(request);
      const file = app.repos.files.byId(fileId);
      if (!file) throw notFound('File');
      const ctx = requireWorkspace(app, request, file.workspaceId, 'file:delete');

      app.workspaces.deleteFile(fileId, toActor(ctx.user));
      return reply.status(204).send();
    }),
  );

  // -- approvals -------------------------------------------------------------

  server.get(
    '/api/workspaces/:workspaceId/approvals',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'workspace:read');
      const { all } = query<{ all?: string }>(request);

      return {
        approvals:
          all === 'true'
            ? app.repos.approvals.listRecent(workspaceId, 50)
            : app.repos.approvals.listPending(workspaceId),
      };
    }),
  );

  server.post(
    '/api/approvals/:approvalId',
    route(app, async (request) => {
      const { approvalId } = params<{ approvalId: string }>(request);
      const approval = app.repos.approvals.byId(approvalId);
      if (!approval) throw notFound('Approval request');
      const ctx = requireWorkspace(app, request, approval.workspaceId, 'approval:resolve');

      const input = body<{ approved?: boolean; note?: string }>(request);

      return {
        approval: app.workspaces.resolveApproval({
          approvalId,
          approved: input.approved === true,
          resolvedBy: toActor(ctx.user),
          note: input.note ?? '',
        }),
      };
    }),
  );

  // -- delegation graph ------------------------------------------------------

  server.get(
    '/api/workspaces/:workspaceId/delegations',
    route(app, async (request) => {
      const { workspaceId } = params<{ workspaceId: string }>(request);
      requireWorkspace(app, request, workspaceId, 'workspace:read');
      const { objectiveId } = query<{ objectiveId?: string }>(request);

      return {
        delegations: objectiveId
          ? app.repos.delegations.listForObjective(objectiveId)
          : app.repos.delegations.listForWorkspace(workspaceId, 300),
      };
    }),
  );
}

function toActor(user: { id: string; displayName: string }): ActorRef {
  return { type: 'user', id: user.id, name: user.displayName };
}
