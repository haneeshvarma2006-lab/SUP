import type { PresenceEntry, User } from '@sup/shared';

interface PresenceState {
  user: User;
  connections: Set<string>;
  lastSeenAt: number;
  focus: string | null;
}

/**
 * Who is currently in each workspace.
 *
 * Tracked per connection, not per user: one person with three tabs open is one
 * participant with three connections, and closing one tab must not make them
 * appear to leave. Presence is process-local and intentionally not persisted —
 * it describes live sockets, and a restart means nobody is connected.
 */
export class PresenceTracker {
  private readonly byWorkspace = new Map<string, Map<string, PresenceState>>();

  /** Returns true when this is the user's first connection to the workspace. */
  join(workspaceId: string, user: User, connectionId: string): boolean {
    let workspace = this.byWorkspace.get(workspaceId);
    if (!workspace) {
      workspace = new Map();
      this.byWorkspace.set(workspaceId, workspace);
    }

    const existing = workspace.get(user.id);
    if (existing) {
      existing.connections.add(connectionId);
      existing.lastSeenAt = Date.now();
      return false;
    }

    workspace.set(user.id, {
      user,
      connections: new Set([connectionId]),
      lastSeenAt: Date.now(),
      focus: null,
    });
    return true;
  }

  /** Returns true when the user's last connection to the workspace closed. */
  leave(workspaceId: string, userId: string, connectionId: string): boolean {
    const workspace = this.byWorkspace.get(workspaceId);
    const state = workspace?.get(userId);
    if (!workspace || !state) return false;

    state.connections.delete(connectionId);
    if (state.connections.size > 0) return false;

    workspace.delete(userId);
    if (workspace.size === 0) this.byWorkspace.delete(workspaceId);
    return true;
  }

  /** Drops a connection from every workspace it was present in. */
  dropConnection(connectionId: string): Array<{ workspaceId: string; userId: string }> {
    const departures: Array<{ workspaceId: string; userId: string }> = [];
    for (const [workspaceId, workspace] of this.byWorkspace) {
      for (const [userId, state] of workspace) {
        if (!state.connections.has(connectionId)) continue;
        if (this.leave(workspaceId, userId, connectionId)) {
          departures.push({ workspaceId, userId });
        }
      }
    }
    return departures;
  }

  setFocus(workspaceId: string, userId: string, focus: string | null): PresenceEntry | null {
    const state = this.byWorkspace.get(workspaceId)?.get(userId);
    if (!state) return null;
    state.focus = focus;
    state.lastSeenAt = Date.now();
    return toEntry(state);
  }

  entry(workspaceId: string, userId: string): PresenceEntry | null {
    const state = this.byWorkspace.get(workspaceId)?.get(userId);
    return state ? toEntry(state) : null;
  }

  list(workspaceId: string): PresenceEntry[] {
    const workspace = this.byWorkspace.get(workspaceId);
    if (!workspace) return [];
    return [...workspace.values()].map(toEntry);
  }

  totalConnections(): number {
    let n = 0;
    for (const workspace of this.byWorkspace.values()) {
      for (const state of workspace.values()) n += state.connections.size;
    }
    return n;
  }
}

function toEntry(state: PresenceState): PresenceEntry {
  return {
    userId: state.user.id,
    displayName: state.user.displayName,
    avatarColor: state.user.avatarColor,
    connections: state.connections.size,
    lastSeenAt: state.lastSeenAt,
    focus: state.focus,
  };
}
