import { createApp, type App } from '../app.js';
import type { Agent, User, Workspace, WorkspaceEvent } from '@sup/shared';

export interface TestWorkspace {
  app: App;
  user: User;
  token: string;
  workspace: Workspace;
  agents: Agent[];
  agentNamed(name: string): Agent;
  agentWithRole(role: string): Agent;
  /** Every event published since the harness was created, in seq order. */
  events: WorkspaceEvent[];
  eventsOfType(type: WorkspaceEvent['type']): WorkspaceEvent[];
  waitForEvent(
    predicate: (event: WorkspaceEvent) => boolean,
    timeoutMs?: number,
  ): Promise<WorkspaceEvent>;
  dispose(): Promise<void>;
}

/**
 * Spins up a complete application against an in-memory database.
 *
 * Nothing is stubbed except the network: the same event bus, scheduler,
 * runtime, tool executor and memory service the server uses in production run
 * here. The model provider defaults to the offline heuristic policy so runs are
 * deterministic and need no credentials.
 */
export async function createTestWorkspace(
  options: {
    roster?: string[];
    settings?: Partial<Workspace['settings']>;
    email?: string;
  } = {},
): Promise<TestWorkspace> {
  // Force the offline provider even if the developer running the tests has
  // ANTHROPIC_API_KEY exported — tests must be deterministic and must not spend
  // anyone's credits.
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = 'heuristic';
  const app = createApp({
    env: 'test',
    databasePath: ':memory:',
    logLevel: 'error',
    authSecret: 'test-secret-not-used-outside-tests',
  });
  if (previousProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = previousProvider;

  app.start();

  const registration = app.auth.register({
    email: options.email ?? `tester-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'correct-horse-battery',
    displayName: 'Test Human',
  });

  const created = app.workspaces.createWorkspace({
    name: 'Test Workspace',
    owner: registration.user,
    roster: options.roster,
    settings: options.settings,
  });

  const events: WorkspaceEvent[] = [];
  const waiters: Array<{ predicate: (e: WorkspaceEvent) => boolean; resolve: (e: WorkspaceEvent) => void }> = [];

  app.events.subscribe(created.workspace.id, (event) => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i]!;
      if (waiter.predicate(event)) {
        waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  });

  return {
    app,
    user: registration.user,
    token: registration.token,
    workspace: created.workspace,
    agents: created.agents,

    agentNamed(name) {
      const agent = created.agents.find((a) => a.name === name);
      if (!agent) throw new Error(`No agent named ${name}. Have: ${created.agents.map((a) => a.name).join(', ')}`);
      return agent;
    },

    agentWithRole(role) {
      const agent = created.agents.find((a) => a.role.toLowerCase() === role.toLowerCase());
      if (!agent) throw new Error(`No agent with role ${role}`);
      return agent;
    },

    events,

    eventsOfType(type) {
      return events.filter((e) => e.type === type);
    },

    waitForEvent(predicate, timeoutMs = 20_000) {
      const already = events.find(predicate);
      if (already) return Promise.resolve(already);

      return new Promise<WorkspaceEvent>((resolve, reject) => {
        const entry = {
          predicate,
          resolve: (e: WorkspaceEvent) => {
            clearTimeout(timer);
            resolve(e);
          },
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for an event`));
        }, timeoutMs);
        waiters.push(entry);
      });
    },

    async dispose() {
      await app.shutdown();
    },
  };
}
