import type { User, WorkspaceRole, WorkspaceSnapshot } from '@sup/shared';
import type { Repositories } from '../db/repos/index.js';
import { publicUser } from '../db/repos/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PresenceTracker } from '../realtime/presence.js';
import { notFound } from '../util/errors.js';
import type { DbHandle } from '../db/index.js';

/**
 * Builds the complete client-side view of a workspace.
 *
 * The snapshot is taken inside a single transaction and stamped with the
 * workspace's current event seq. That pairing is what makes incremental
 * updates safe: the client knows exactly which events are already reflected in
 * the state it holds, and can discard or replay accordingly.
 */
export class SnapshotBuilder {
  constructor(
    private readonly handle: DbHandle,
    private readonly repos: Repositories,
    private readonly tools: ToolRegistry,
    private readonly presence: PresenceTracker,
  ) {}

  build(workspaceId: string, viewer: User, role: WorkspaceRole): WorkspaceSnapshot {
    return this.handle.tx((): WorkspaceSnapshot => {
      const workspace = this.repos.workspaces.byId(workspaceId);
      if (!workspace) throw notFound('Workspace');

      const memberships = this.repos.memberships.listForWorkspace(workspaceId);
      const users = this.repos.users.byIds(memberships.map((m) => m.userId));
      const usersById = new Map(users.map((u) => [u.id, u]));

      const members = memberships
        .map((m) => {
          const user = usersById.get(m.userId);
          return user ? { user: publicUser(user), role: m.role } : null;
        })
        .filter((m): m is { user: User; role: WorkspaceRole } => m !== null);

      return {
        workspace,
        // Read last, so the seq is at least as new as everything above it. A
        // slightly stale seq would risk skipping an event; a slightly fresh one
        // only risks a redundant no-op on the client.
        seq: this.repos.events.currentSeq(workspaceId),
        viewer: { user: viewer, role },
        members,
        presence: this.presence.list(workspaceId),
        agents: this.repos.agents.listForWorkspace(workspaceId),
        tasks: this.repos.tasks.listForWorkspace(workspaceId, 300),
        messages: this.repos.messages.listRecent(workspaceId, 200),
        events: this.repos.events.recent(workspaceId, 250),
        memories: this.repos.memories.listForWorkspace(workspaceId, 200),
        // File bodies are excluded: a snapshot with every document inline would
        // be megabytes. The client fetches content on demand.
        files: this.repos.files.listForWorkspace(workspaceId, false),
        approvals: this.repos.approvals.listPending(workspaceId),
        delegations: this.repos.delegations.listForWorkspace(workspaceId, 200),
        activeRuns: this.repos.runs.listActive(workspaceId),
        tools: this.tools.descriptors(),
        serverTime: Date.now(),
      };
    });
  }
}
