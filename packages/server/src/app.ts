import { loadConfig, type AppConfig } from './config/index.js';
import { createLogger, type Logger } from './util/logger.js';
import { openDatabase, type DbHandle } from './db/index.js';
import { createRepositories, type Repositories } from './db/repos/index.js';
import { AuthService } from './auth/authService.js';
import { PermissionService } from './permissions/permissionService.js';
import { EventBus } from './events/eventBus.js';
import { CancellationRegistry } from './concurrency/cancellation.js';
import { ProviderRegistry } from './ai/registry.js';
import { createEmbeddingProvider, type EmbeddingProvider } from './ai/embeddings.js';
import { MemoryService } from './memory/memoryService.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolExecutor } from './tools/executor.js';
import { CodeSandbox } from './tools/sandbox.js';
import { WebSearchService } from './tools/webSearch.js';
import { WorkspaceService } from './workspace/workspaceService.js';
import { SnapshotBuilder } from './workspace/snapshot.js';
import { AgentStatusManager } from './agents/statusManager.js';
import { AgentRuntime } from './agents/runtime.js';
import { AgentScheduler } from './agents/scheduler.js';
import { OrchestrationService } from './orchestrator/orchestrationService.js';
import { EventReactor } from './orchestrator/reactor.js';
import { PresenceTracker } from './realtime/presence.js';
import { WebSocketHub } from './realtime/wsHub.js';

/**
 * The composition root.
 *
 * Every service is constructed exactly once here and handed its dependencies
 * explicitly. Nothing reaches for a singleton or a module-level global, which
 * is what lets a test spin up a complete, isolated application against an
 * in-memory database — see `createTestApp` in the test helpers.
 *
 * Two edges in the graph are genuinely cyclic and are resolved by late
 * injection rather than by merging the modules:
 *   runtime -> ToolServices (orchestration), and orchestration -> scheduler.
 */
export interface App {
  config: AppConfig;
  logger: Logger;
  db: DbHandle;
  repos: Repositories;

  auth: AuthService;
  permissions: PermissionService;
  events: EventBus;

  providers: ProviderRegistry;
  embeddings: EmbeddingProvider;
  memory: MemoryService;

  tools: ToolRegistry;
  toolExecutor: ToolExecutor;
  sandbox: CodeSandbox;
  search: WebSearchService;

  workspaces: WorkspaceService;
  snapshots: SnapshotBuilder;

  status: AgentStatusManager;
  cancellations: CancellationRegistry;
  runtime: AgentRuntime;
  scheduler: AgentScheduler;
  orchestration: OrchestrationService;
  reactor: EventReactor;

  presence: PresenceTracker;
  ws: WebSocketHub;

  start(): void;
  shutdown(): Promise<void>;
}

export function createApp(overrides: Partial<AppConfig> = {}): App {
  const config = loadConfig(overrides);
  const logger = createLogger(config.logLevel, { service: 'sup' });

  const db = openDatabase(config.databasePath, logger);
  const repos = createRepositories(db);

  const auth = new AuthService(repos, config);
  const permissions = new PermissionService(repos);
  const events = new EventBus(db, repos, logger.child({ component: 'events' }), config.limits.eventLogRetention);

  const providers = new ProviderRegistry(config, logger.child({ component: 'ai' }));
  const embeddings = createEmbeddingProvider(config.ai.embeddings);
  const memory = new MemoryService(repos, embeddings, events, logger.child({ component: 'memory' }));

  const tools = new ToolRegistry();
  const sandbox = new CodeSandbox(logger.child({ component: 'sandbox' }));
  const search = new WebSearchService(config.ai.search, logger.child({ component: 'search' }));
  const toolExecutor = new ToolExecutor(tools, repos, events, config, logger.child({ component: 'tools' }));

  const workspaces = new WorkspaceService(repos, events, tools, config, logger.child({ component: 'workspace' }));
  const presence = new PresenceTracker();
  const snapshots = new SnapshotBuilder(db, repos, tools, presence);

  const status = new AgentStatusManager(repos, events);
  const cancellations = new CancellationRegistry();

  const runtime = new AgentRuntime(
    repos,
    events,
    workspaces,
    memory,
    providers,
    tools,
    toolExecutor,
    status,
    cancellations,
    config,
    logger.child({ component: 'runtime' }),
  );

  const orchestration = new OrchestrationService(
    repos,
    workspaces,
    events,
    memory,
    status,
    sandbox,
    search,
    config,
    logger.child({ component: 'orchestration' }),
  );

  const scheduler = new AgentScheduler(
    runtime,
    repos,
    workspaces,
    events,
    status,
    cancellations,
    config,
    logger.child({ component: 'scheduler' }),
  );

  // Resolve the two cyclic edges.
  runtime.attachServices(orchestration);
  orchestration.attachScheduler(scheduler);

  const reactor = new EventReactor(events, repos, scheduler, orchestration, logger.child({ component: 'reactor' }));
  const ws = new WebSocketHub(auth, events, repos, presence, snapshots, logger.child({ component: 'ws' }));

  let started = false;

  return {
    config,
    logger,
    db,
    repos,
    auth,
    permissions,
    events,
    providers,
    embeddings,
    memory,
    tools,
    toolExecutor,
    sandbox,
    search,
    workspaces,
    snapshots,
    status,
    cancellations,
    runtime,
    scheduler,
    orchestration,
    reactor,
    presence,
    ws,

    start(): void {
      if (started) return;
      started = true;
      // Clean up anything a previous process left mid-flight before accepting
      // new work, so recovered tasks are not raced by fresh dispatches.
      scheduler.recoverAfterRestart();
      reactor.start();
      scheduler.start();
      auth.purgeExpiredSessions();
    },

    async shutdown(): Promise<void> {
      reactor.stop();
      cancellations.cancelMatching(() => true, 'Server shutting down');
      await scheduler.stop();
      await ws.close();
      db.close();
    },
  };
}
