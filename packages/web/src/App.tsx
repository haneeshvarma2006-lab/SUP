import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@sup/shared';
import { api, getToken, setToken } from './api/client.js';
import { RealtimeClient } from './api/realtime.js';
import { store } from './state/store.js';
import { useAppState } from './state/hooks.js';
import { AuthScreen, WorkspacePicker } from './components/Auth.js';
import { Workspace } from './components/Workspace.js';
import { Spinner } from './components/primitives.js';

const WORKSPACE_KEY = 'sup.workspace';

/**
 * Top-level routing and the single realtime connection.
 *
 * One WebSocket serves the whole tab. Snapshots and events go straight into the
 * store, which every view reads from — nothing fetches workspace state
 * independently, so there is no second source of truth to fall out of sync.
 */
export function App() {
  const app = useAppState();
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => readStoredWorkspace());

  const realtime = useRef<RealtimeClient | null>(null);

  // -- the realtime client, created once ------------------------------------

  const client = useMemo(
    () =>
      new RealtimeClient({
        onSnapshot: (_workspaceId, snapshot) => store.applySnapshot(snapshot),
        onEvent: (_workspaceId, event) => store.applyEvent(event),
        onReplay: (_workspaceId, events) => store.applyEvents(events),
        onState: (state) => {
          store.setConnection(state);
          if (state === 'open') store.setBanner(null);
        },
        onError: (message) => store.setBanner({ kind: 'error', message }),
        onResyncRequired: () =>
          store.setBanner({
            kind: 'info',
            message: 'Reloading workspace state — this client had fallen too far behind.',
          }),
      }),
    [],
  );

  useEffect(() => {
    realtime.current = client;
    return () => client.disconnect();
  }, [client]);

  // -- session restore -------------------------------------------------------

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setBooting(false);
      return;
    }
    api
      .me()
      .then((response) => setUser(response.user))
      .catch(() => {
        setToken(null);
        setUser(null);
      })
      .finally(() => setBooting(false));
  }, []);

  // -- connect once authenticated -------------------------------------------

  useEffect(() => {
    const token = getToken();
    if (!user || !token) return;
    client.connect(token);
    return () => client.disconnect();
  }, [user, client]);

  // -- subscribe to the open workspace --------------------------------------

  useEffect(() => {
    if (!user || !workspaceId) return;
    client.subscribe(workspaceId);
    storeWorkspace(workspaceId);
    return () => {
      client.unsubscribe(workspaceId);
      store.clearWorkspace();
    };
  }, [user, workspaceId, client]);

  const signOut = useCallback(() => {
    void api.logout().catch(() => undefined);
    setToken(null);
    storeWorkspace(null);
    client.disconnect();
    store.clearWorkspace();
    setWorkspaceId(null);
    setUser(null);
  }, [client]);

  const leaveWorkspace = useCallback(() => {
    storeWorkspace(null);
    setWorkspaceId(null);
    store.clearWorkspace();
  }, []);

  // -- render ---------------------------------------------------------------

  if (booting) {
    return (
      <div className="auth-page">
        <Spinner />
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onAuthenticated={setUser} />;
  }

  if (!workspaceId) {
    return (
      <WorkspacePicker
        userName={user.displayName}
        onOpen={setWorkspaceId}
        onSignOut={signOut}
      />
    );
  }

  if (!app.workspace) {
    return (
      <div className="auth-page">
        <div style={{ textAlign: 'center' }}>
          <Spinner />
          <div className="dim" style={{ marginTop: 12, fontSize: 12.5 }}>
            {app.connection === 'reconnecting' ? 'Reconnecting…' : 'Joining the workspace…'}
          </div>
          {app.banner ? (
            <div style={{ marginTop: 14 }}>
              <div className={`banner ${app.banner.kind}`}>{app.banner.message}</div>
              <button type="button" className="btn ghost sm" style={{ marginTop: 10 }} onClick={leaveWorkspace}>
                Back to your workspaces
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return <Workspace onLeave={leaveWorkspace} onSignOut={signOut} />;
}

function readStoredWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function storeWorkspace(workspaceId: string | null): void {
  try {
    if (workspaceId) localStorage.setItem(WORKSPACE_KEY, workspaceId);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // Reopening the last workspace is a convenience, not a requirement.
  }
}
