import { useEffect, useState } from 'react';
import type { User } from '@sup/shared';
import { api, setToken } from '../api/client.js';
import { useAction } from '../state/hooks.js';
import { Button, ErrorNote, Icon, Spinner } from './primitives.js';

/**
 * The entrance.
 *
 * A first-time visitor has no idea what this product is, so the card states it
 * in one line before asking for anything. Everything else is deliberately
 * minimal — the interesting surface is behind the door, not on it.
 */
export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const submit = useAction(async () => {
    const result =
      mode === 'login'
        ? await api.login({ email, password })
        : await api.register({ email, password, displayName: name });
    setToken(result.token);
    onAuthenticated(result.user);
  });

  const valid =
    email.includes('@') && password.length >= 8 && (mode === 'login' || name.trim().length > 0);

  return (
    <div className="gate">
      <form
        className="gate__card"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void submit.run();
        }}
      >
        <div className="row" style={{ gap: 11, marginBottom: 7 }}>
          <span className="mark" style={{ width: 32, height: 32, borderRadius: 9 }}>
            <Icon.Logo size={16} />
          </span>
          <h1 className="gate__title">SUP</h1>
        </div>

        <p className="gate__sub" style={{ marginBottom: 24 }}>
          A shared room where you and a team of AI agents work on the same project — in real time,
          together.
        </p>

        {mode === 'register' ? (
          <div className="field">
            <label htmlFor="auth-name">Your name</label>
            <input
              id="auth-name"
              className="input"
              value={name}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
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
            <span className="faint" style={{ fontSize: 11 }}>
              At least 8 characters.
            </span>
          ) : null}
        </div>

        <Button
          type="submit"
          variant="primary"
          disabled={!valid || submit.pending}
          style={{ width: '100%', marginTop: 4, padding: '9px 13px' }}
        >
          {submit.pending ? <Spinner /> : mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>

        <ErrorNote>{submit.error}</ErrorNote>

        <div className="faint" style={{ textAlign: 'center', marginTop: 18, fontSize: 12.5 }}>
          {mode === 'login' ? 'No account yet?' : 'Already have one?'}{' '}
          <button
            type="button"
            style={{ color: 'var(--iris-bright)', fontWeight: 580 }}
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Workspace chooser.
 *
 * The create field explains what a new workspace comes with, because the answer
 * — a full agent team, already assembled — is the product's best first
 * impression and is otherwise invisible until after the click.
 */
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
  const [list, setList] = useState<
    Array<{ id: string; name: string; description: string; role: string }> | null
  >(null);

  const load = useAction(async () => {
    const r = await api.listWorkspaces();
    setList(
      r.workspaces.map((w) => ({
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

  // Effect, not a lazy state initialiser: the initialiser runs during render,
  // and `load.run` sets state, which React refuses mid-render.
  useEffect(() => {
    void load.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="gate">
      <div className="gate__card" style={{ maxWidth: 520 }}>
        <div className="row" style={{ gap: 11, marginBottom: 20 }}>
          <span className="mark" style={{ width: 30, height: 30, borderRadius: 9 }}>
            <Icon.Logo size={15} />
          </span>
          <div className="grow">
            <h1 className="gate__title" style={{ fontSize: 18 }}>
              Your workspaces
            </h1>
            <p className="gate__sub" style={{ fontSize: 12.5 }}>
              Signed in as {userName}
            </p>
          </div>
          <Button variant="quiet" size="sm" onClick={onSignOut}>
            <Icon.Exit size={12} /> Sign out
          </Button>
        </div>

        {load.pending && !list ? (
          <div style={{ textAlign: 'center', padding: 22 }}>
            <Spinner />
          </div>
        ) : null}

        {list && list.length > 0 ? (
          <div className="col-gap" style={{ marginBottom: 20 }}>
            {list.map((w) => (
              <button key={w.id} type="button" className="card card--tap" onClick={() => onOpen(w.id)}>
                <div className="row">
                  <span style={{ fontWeight: 620, fontSize: 13.5 }}>{w.name}</span>
                  <span className="faint grow" style={{ textAlign: 'right', fontSize: 11 }}>
                    {w.role}
                  </span>
                  <Icon.Arrow size={12} className="faint" />
                </div>
                {w.description ? (
                  <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                    {w.description}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        {list && list.length === 0 ? (
          <div className="faint" style={{ fontSize: 12.5, textAlign: 'center', padding: '4px 0 18px', lineHeight: 1.6 }}>
            You are not in a workspace yet. Create your first one below.
          </div>
        ) : null}

        <div className="hr" />

        <div className="field" style={{ marginBottom: 0 }}>
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
            <Button
              variant="primary"
              onClick={() => void create.run()}
              disabled={!name.trim() || create.pending}
            >
              {create.pending ? <Spinner /> : 'Create'}
            </Button>
          </div>
          <span className="faint" style={{ fontSize: 11, marginTop: 5, lineHeight: 1.5 }}>
            Comes with a full team — an orchestrator, researcher, analyst, reviewer and writer —
            ready to take an objective.
          </span>
        </div>

        <ErrorNote>{create.error ?? load.error}</ErrorNote>
      </div>
    </div>
  );
}
