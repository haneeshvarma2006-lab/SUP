import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import type { App } from '../app.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerCollabRoutes } from './routes/collab.js';
import { sendError } from './context.js';

export async function buildHttpServer(app: App): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
    bodyLimit: app.config.limits.maxRequestBodyBytes,
    trustProxy: true,
  });

  await server.register(cors, {
    origin: app.config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // -- health and readiness --------------------------------------------------

  server.get('/api/health', async () => {
    const provider = app.providers.default();
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: 1,
      ai: {
        provider: provider.name,
        displayName: provider.displayName,
        isLanguageModel: provider.isLanguageModel,
        // Surfaced so nobody mistakes heuristic output for model output.
        note: provider.isLanguageModel
          ? undefined
          : 'No model credentials are configured. Agents run on the offline heuristic policy.',
      },
      embeddings: {
        provider: app.embeddings.name,
        semantic: app.embeddings.isSemantic,
        dimensions: app.embeddings.dimensions,
      },
      search: { provider: app.search.providerName, enabled: app.search.enabled },
      realtime: { connections: app.ws.connectionCount },
      scheduler: app.scheduler.stats(),
    };
  });

  server.get('/api/health/ai', async () => {
    const results = await Promise.all(
      app.providers.list().map(async (provider) => ({
        name: provider.name,
        displayName: provider.displayName,
        isLanguageModel: provider.isLanguageModel,
        ...(await provider.health()),
      })),
    );
    return { providers: results };
  });

  // -- feature routes --------------------------------------------------------

  registerAuthRoutes(server, app);
  registerWorkspaceRoutes(server, app);
  registerAgentRoutes(server, app);
  registerTaskRoutes(server, app);
  registerCollabRoutes(server, app);

  // -- static client ---------------------------------------------------------

  if (app.config.serveStaticDir) {
    const root = path.resolve(app.config.serveStaticDir);
    await server.register(fastifyStatic, { root, prefix: '/' });

    // SPA fallback: anything that is not an API or websocket path renders the
    // client and lets its router decide.
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        return reply.status(404).send({
          error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
        });
      }
      return reply.sendFile('index.html');
    });
  } else {
    server.setNotFoundHandler((request, reply) =>
      reply.status(404).send({
        error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
      }),
    );
  }

  server.setErrorHandler((err, _request, reply) => sendError(reply, err, app.logger));

  return server;
}
