import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Agent, Task, WorkspaceEvent } from '@sup/shared';
import { ACTIVITY_FEED_EVENTS } from '@sup/shared';
import { store, type AppState, type WorkspaceState } from './store.js';

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useWorkspace(): WorkspaceState | null {
  return useAppState().workspace;
}

/** Throws if used outside a loaded workspace, so callers need no null checks. */
export function useWorkspaceOrThrow(): WorkspaceState {
  const workspace = useWorkspace();
  if (!workspace) throw new Error('useWorkspaceOrThrow used outside a loaded workspace');
  return workspace;
}

export function useAgent(agentId: string | null): Agent | null {
  const workspace = useWorkspace();
  return useMemo(
    () => (agentId ? (workspace?.agents.find((a) => a.id === agentId) ?? null) : null),
    [workspace?.agents, agentId],
  );
}

export function useTask(taskId: string | null): Task | null {
  const workspace = useWorkspace();
  return useMemo(
    () => (taskId ? (workspace?.tasks.find((t) => t.id === taskId) ?? null) : null),
    [workspace?.tasks, taskId],
  );
}

/** Events worth showing a human, newest first. */
export function useActivityFeed(limit = 120): WorkspaceEvent[] {
  const workspace = useWorkspace();
  return useMemo(() => {
    if (!workspace) return [];
    return workspace.events
      .filter((e) => ACTIVITY_FEED_EVENTS.includes(e.type))
      .slice(-limit)
      .reverse();
  }, [workspace?.events, limit]);
}

/** Resolves an actor id to a display name and colour from the roster. */
export function useActorLookup() {
  const workspace = useWorkspace();
  return useMemo(() => {
    const map = new Map<string, { name: string; color: string; emoji?: string; kind: 'user' | 'agent' | 'system' }>();
    for (const agent of workspace?.agents ?? []) {
      map.set(agent.id, {
        name: agent.name,
        color: agent.avatarColor,
        emoji: agent.avatarEmoji,
        kind: 'agent',
      });
    }
    for (const member of workspace?.members ?? []) {
      map.set(member.user.id, {
        name: member.user.displayName,
        color: member.user.avatarColor,
        kind: 'user',
      });
    }
    return (id: string | undefined) =>
      (id ? map.get(id) : undefined) ?? { name: id ?? 'System', color: '#64748b', kind: 'system' as const };
  }, [workspace?.agents, workspace?.members]);
}

/** Runs an async action, exposing pending state and the last error. */
export function useAction<Args extends unknown[]>(
  fn: (...args: Args) => Promise<unknown>,
): { run: (...args: Args) => Promise<void>; pending: boolean; error: string | null } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: Args) => {
      setPending(true);
      setError(null);
      try {
        await fn(...args);
      } catch (err) {
        // Guard against setting state after unmount, which React warns about
        // and which would leak a stale error into a remounted component.
        if (alive.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive.current) setPending(false);
      }
    },
    [fn],
  );

  return { run, pending, error };
}

/** Re-renders on an interval so relative timestamps stay honest. */
export function useTicker(intervalMs = 15_000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError(null);

    loader(controller.signal)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}
