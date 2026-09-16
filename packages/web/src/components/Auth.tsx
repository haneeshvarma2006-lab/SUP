import { useEffect, useState } from 'react';
import type { User } from '@sup/shared';
import { api, setToken } from '../api/client.js';
import { useAction } from '../state/hooks.js';
import { ErrorText, Spinner } from './primitives.js';

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const submit = useAction(async () => {
    const result =
      mode === 'login'
        ? await api.login({ email, password })
        : await api.register({ email, password, displayName });
    setToken(result.token);
    onAuthenticated(result.user);
  });

  const valid =
    email.includes('@') &&
    password.length >= 8 &&
    (mode === 'login' || displayName.trim().length > 0);

  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void submit.run();
        }}
      >
        <div className="row" style={{ marginBottom: 20 }}>
          <span className="brand-mark">◆</span>
          <div>
            <h1 className="auth-title">SUP</h1>
            <p className="auth-sub" style={{ margin: 0 }}>
              A room where you and a team of AI agents work on the same project.
            </p>
          </div>
        </div>

        {mode === 'register' ? (
          <div className="field">
            <label htmlFor="auth-name">Your name</label>
            <input
              id="auth-name"
              className="input"
              value={displayName}
              autoComplete="name"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            className="input"
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            className="input"
            type="password"
            value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === 'register' ? (
            <span className="dim" style={{ fontSize: 11 }}>
              At least 8 characters.
            </span>
          ) : null}
        </div>

        <button
          type="submit"
          className="btn primary"
          style={{ width: '100%', marginTop: 4 }}
          disabled={!valid || submit.pending}
        >
          {submit.pending ? <Spinner /> : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <ErrorText>{submit.error}</ErrorText>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12.5 }} className="dim">
          {mode === 'login' ? 'No account yet?' : 'Already have an account?'}{' '}
          <button
            type="button"
            style={{ color: 'var(--accent)', fontWeight: 600 }}
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Workspace chooser, shown after sign-in when no workspace is selected. */
export function WorkspacePicker({
  onOpen,
  onSignOut,
  userName,
}: {
  onOpen: (workspaceId: string) => void;
  onSignOut: () => void;
  userName: string;
}) {
  const [name, setName] = useState('');
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; description: string; role: string }> | null>(
    null,
  );

  const load = useAction(async () => {
    const response = await api.listWorkspaces();
    setWorkspaces(
      response.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        role: w.role,
      })),
    );
  });

  const create = useAction(async () => {
    const created = await api.createWorkspace({ name: name.trim() });
    onOpen(created.workspace.id);
  });

  // Load once on mount. This must be an effect, not a lazy useState
  // initialiser — the initialiser runs during render, and `load.run` sets
  // state, which React refuses to do mid-render.
  useEffect(() => {
    void load.run();
    // `load.run` is recreated each render, so depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <div className="row" style={{ marginBottom: 18 }}>
          <span className="brand-mark">◆</span>
          <div style={{ flex: 1 }}>
            <h1 className="auth-title">Your workspaces</h1>
            <p className="auth-sub" style={{ margin: 0 }}>
              Signed in as {userName}
            </p>
          </div>
          <button type="button" className="btn ghost sm" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        {load.pending && !workspaces ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <Spinner />
          </div>
        ) : null}

        <div className="stack" style={{ marginBottom: 20 }}>
          {(workspaces ?? []).map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="card interactive"
              style={{ textAlign: 'left' }}
              onClick={() => onOpen(workspace.id)}
            >
              <div style={{ fontWeight: 650, fontSize: 14 }}>{workspace.name}</div>
              <div className="dim" style={{ fontSize: 12 }}>
                {workspace.description || 'No description'} · you are {workspace.role}
              </div>
            </button>
          ))}
          {workspaces?.length === 0 ? (
            <div className="dim" style={{ fontSize: 12.5, textAlign: 'center', padding: 10 }}>
              You are not in a workspace yet. Create your first one below — it comes with a full
              agent team.
            </div>
          ) : null}
        </div>

        <div className="divider" />

        <div className="field">
          <label htmlFor="new-workspace">Create a workspace</label>
          <div className="row">
            <input
              id="new-workspace"
              className="input"
              value={name}
              placeholder="e.g. Startup HQ"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) void create.run();
              }}
            />
            <button
              type="button"
              className="btn primary"
              onClick={() => void create.run()}
              disabled={!name.trim() || create.pending}
            >
              {create.pending ? <Spinner /> : 'Create'}
            </button>
          </div>
          <span className="dim" style={{ fontSize: 11 }}>
            Comes with an orchestrator, researcher, analyst, reviewer and writer.
          </span>
        </div>

        <ErrorText>{create.error ?? load.error}</ErrorText>
      </div>
    </div>
  );
}
