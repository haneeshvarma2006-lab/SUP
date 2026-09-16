import { createApp } from './app.js';
import { buildHttpServer } from './http/server.js';
import { errorMessage } from './util/errors.js';

async function main(): Promise<void> {
  const app = createApp();
  const server = await buildHttpServer(app);

  app.start();

  await server.listen({ host: app.config.host, port: app.config.port });

  // The websocket hub shares the HTTP listener, so both live on one port.
  app.ws.attach(server.server, '/ws');

  const provider = app.providers.default();
  app.logger.info('sup is listening', {
    url: `http://${app.config.host}:${app.config.port}`,
    websocket: `ws://${app.config.host}:${app.config.port}/ws`,
    database: app.config.databasePath,
    aiProvider: provider.name,
    languageModel: provider.isLanguageModel,
  });

  if (!provider.isLanguageModel) {
    app.logger.warn(
      'running without model credentials: agents will use the offline heuristic policy, not an LLM',
      { fix: 'set ANTHROPIC_API_KEY (or OPENAI_API_KEY + OPENAI_BASE_URL) and restart' },
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info('shutting down', { signal });

    // Stop accepting new work first, then let in-flight runs settle, then
    // close the database. Reversing this order would strand runs mid-write.
    try {
      await server.close();
      await app.shutdown();
      process.exit(0);
    } catch (err) {
      app.logger.error('shutdown failed', { error: errorMessage(err) });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    app.logger.error('unhandled rejection', { error: errorMessage(reason) });
  });
  process.on('uncaughtException', (err) => {
    app.logger.error('uncaught exception', { error: errorMessage(err) });
    void shutdown('uncaughtException');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Failed to start: ${errorMessage(err)}\n`);
  process.exit(1);
});
