import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Permission, User } from '@sup/shared';
import type { App } from '../app.js';
import type { WorkspaceContext } from '../permissions/permissionService.js';
import { AppError, unauthorized } from '../util/errors.js';

/** Extracts the bearer token from the Authorization header or a cookie. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  const cookie = request.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === 'sup_token') return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export function currentUser(app: App, request: FastifyRequest): User {
  const session = app.auth.authenticate(bearerToken(request));
  if (!session) throw unauthorized();
  return session.user;
}

/**
 * Resolves the caller's workspace context and checks a permission in one step.
 *
 * Every workspace-scoped route starts with this, so there is exactly one place
 * where "is this person allowed" is answered.
 */
export function requireWorkspace(
  app: App,
  request: FastifyRequest,
  workspaceId: string,
  permission?: Permission,
): WorkspaceContext {
  const user = currentUser(app, request);
  const ctx = app.permissions.contextFor(workspaceId, user);
  if (permission) app.permissions.require(ctx, permission);
  return ctx;
}

/** Maps a thrown error onto an HTTP response. */
export function sendError(reply: FastifyReply, err: unknown, log: App['logger']): FastifyReply {
  if (err instanceof AppError) {
    return reply.status(err.status).send({
      error: {
        code: err.code,
        message: err.expose ? err.message : 'Something went wrong',
        details: err.expose ? err.details : null,
      },
    });
  }

  log.error('unhandled route error', { error: err });
  return reply.status(500).send({
    error: { code: 'internal_error', message: 'Something went wrong', details: null },
  });
}

/** Wraps a handler so thrown AppErrors become well-formed responses. */
export function route<T>(
  app: App,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<T> | T,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      return await handler(request, reply);
    } catch (err) {
      return sendError(reply, err, app.logger);
    }
  };
}

export function body<T>(request: FastifyRequest): T {
  return (request.body ?? {}) as T;
}

export function params<T>(request: FastifyRequest): T {
  return (request.params ?? {}) as T;
}

export function query<T>(request: FastifyRequest): T {
  return (request.query ?? {}) as T;
}
