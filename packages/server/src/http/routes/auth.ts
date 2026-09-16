import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import { bearerToken, body, currentUser, route } from '../context.js';

export function registerAuthRoutes(server: FastifyInstance, app: App): void {
  server.post(
    '/api/auth/register',
    route(app, async (request, reply) => {
      const input = body<{ email?: string; password?: string; displayName?: string }>(request);
      const result = app.auth.register({
        email: String(input.email ?? ''),
        password: String(input.password ?? ''),
        displayName: String(input.displayName ?? ''),
        userAgent: request.headers['user-agent'],
      });
      return reply.status(201).send(result);
    }),
  );

  server.post(
    '/api/auth/login',
    route(app, async (request) => {
      const input = body<{ email?: string; password?: string }>(request);
      return app.auth.login({
        email: String(input.email ?? ''),
        password: String(input.password ?? ''),
        userAgent: request.headers['user-agent'],
      });
    }),
  );

  server.post(
    '/api/auth/logout',
    route(app, async (request, reply) => {
      const session = app.auth.authenticate(bearerToken(request));
      if (session) app.auth.logout(session.sessionId);
      return reply.status(204).send();
    }),
  );

  server.get(
    '/api/auth/me',
    route(app, async (request) => {
      const user = currentUser(app, request);
      return {
        user,
        workspaces: app.repos.workspaces.listForUser(user.id).map((w) => ({
          id: w.id,
          slug: w.slug,
          name: w.name,
          description: w.description,
          role: w.role,
          createdAt: w.createdAt,
        })),
      };
    }),
  );
}
