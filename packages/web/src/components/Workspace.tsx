import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAppState, useWorkspaceOrThrow } from '../state/hooks.js';
import { ActivityFeed } from './ActivityFeed.js';
import { AddAgentDialog } from './AddAgentDialog.js';
import { AgentPanel } from './AgentPanel.js';
import { AttentionDock, useAttention } from './AttentionDock.js';
import { CommsGraph } from './CommsGraph.js';
import { FilesPanel } from './FilesPanel.js';
import { MemoryPanel } from './MemoryPanel.js';
import { MissionControl } from './MissionControl.js';
import { RoomStream } from './RoomStream.js';
import { TaskBoard, TaskDetail } from './TaskBoard.js';
import { TeamRail } from './TeamRail.js';
import { Avatar, Button, Icon, isLive } from './primitives.js';

type Signal = 'activity' | 'tasks' | 'comms' | 'memory' | 'files';
type Surface = 'team' | 'room' | 'signal';

/**
 * The workspace shell.
 *
 * Three surfaces, always: who is here, what is being said, and what is
 * happening. The inspector is a fourth that arrives on demand and, on a narrow
 * desktop, takes the signal column's place rather than squeezing the room —
 * the room is the focal plane and never gets compressed.
 *
 * On mobile the same three surfaces become one at a time, switched from a tab
 * bar that badges live work and anything waiting on you, so the two things
 * worth interrupting for are visible from whichever surface you are on.
 */
export function Workspace({ onLeave, onSignOut }: { onLeave: () => void; onSignOut: () => void }) {
  const app = useAppState();
  const workspace = useWorkspaceOrThrow();
  const attention = useAttention(workspace);

  const [signal, setSignal] = useState<Signal>('activity');
  const [surface, setSurface] = useState<Surface>('room');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);

  const working = workspace.agents.filter(isLive).length;
  const openTasks = workspace.tasks.filter(
    (t) => !['completed', 'failed', 'cancelled'].includes(t.status),
  ).length;

  // One inspector at a time — two would not fit, and the selection would be
  // ambiguous.
  const openAgent = (id: string | null) => {
    setAgentId(id);
    if (id) setTaskId(null);
  };
  const openTask = (id: string | null) => {
    setTaskId(id);
    if (id) setAgentId(null);
  };

  const inspector = agentId !== null || taskId !== null;

  // On mobile, opening an inspector should show it rather than leaving the
  // person on a surface that did not change.
  useEffect(() => {
    if (inspector && window.matchMedia('(max-width: 960px)').matches) setSurface('room');
  }, [inspector]);

  return (
    <div className="shell">
      <TopBar
        onLeave={onLeave}
        onSignOut={onSignOut}
        working={working}
        attention={attention.length}
        dockOpen={dockOpen}
        onToggleDock={() => setDockOpen((v) => !v)}
      />

      {app.banner ? (
        <div className={`banner banner--${app.banner.kind}`} role="status">
          {app.banner.kind === 'error' ? <Icon.Warn size={13} /> : <Icon.Info size={13} />}
          {app.banner.message}
        </div>
      ) : null}

      <div className="stage" data-inspector={inspector}>
        <TeamRail
          selectedAgentId={agentId}
          onSelectAgent={openAgent}
          onAddAgent={() => setAdding(true)}
          shown={surface === 'team'}
        />

        <RoomStream
          onOpenTask={openTask}
          shown={surface === 'room'}
          header={<MissionControl />}
        />

        <section className="col col--signal" data-shown={surface === 'signal'} aria-label="Signal">
          <div className="seg">
            <SegButton on={signal === 'activity'} onClick={() => setSignal('activity')}>
              Activity
            </SegButton>
            <SegButton
              on={signal === 'tasks'}
              onClick={() => setSignal('tasks')}
              count={openTasks}
              live={working > 0}
            >
              Tasks
            </SegButton>
            <SegButton on={signal === 'comms'} onClick={() => setSignal('comms')}>
              Comms
            </SegButton>
            <SegButton
              on={signal === 'memory'}
              onClick={() => setSignal('memory')}
              count={workspace.memories.length}
            >
              Memory
            </SegButton>
            <SegButton
              on={signal === 'files'}
              onClick={() => setSignal('files')}
              count={workspace.files.length}
            >
              Files
            </SegButton>
          </div>

          {signal === 'activity' ? <ActivityFeed /> : null}
          {signal === 'tasks' ? <TaskBoard onOpenTask={openTask} /> : null}
          {signal === 'comms' ? <CommsGraph /> : null}
          {signal === 'memory' ? <MemoryPanel /> : null}
          {signal === 'files' ? <FilesPanel /> : null}
        </section>

        {agentId ? <AgentPanel agentId={agentId} onClose={() => openAgent(null)} /> : null}
        {taskId ? <TaskDetail taskId={taskId} onClose={() => openTask(null)} /> : null}
      </div>

      <nav className="tabbar" aria-label="Switch surface">
        <TabButton
          on={surface === 'team'}
          onClick={() => setSurface('team')}
          icon={<Icon.Users />}
          label="Team"
          live={working > 0}
        />
        <TabButton
          on={surface === 'room'}
          onClick={() => setSurface('room')}
          icon={<Icon.Room />}
          label="Room"
        />
        <TabButton
          on={surface === 'signal'}
          onClick={() => setSurface('signal')}
          icon={<Icon.Pulse />}
          label="Activity"
          alert={attention.length > 0}
        />
      </nav>

      {dockOpen ? (
        <AttentionDock
          items={attention}
          onClose={() => setDockOpen(false)}
          onOpenTask={(id) => openTask(id)}
        />
      ) : null}

      {adding ? <AddAgentDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ topbar */

function TopBar({
  onLeave,
  onSignOut,
  working,
  attention,
  dockOpen,
  onToggleDock,
}: {
  onLeave: () => void;
  onSignOut: () => void;
  working: number;
  attention: number;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  const app = useAppState();
  const workspace = useWorkspaceOrThrow();
  const [engine, setEngine] = useState<{ label: string; real: boolean } | null>(null);

  useEffect(() => {
    api
      .health()
      .then((r) => setEngine({ label: r.ai.displayName, real: r.ai.isLanguageModel }))
      .catch(() => setEngine(null));
  }, []);

  const online = workspace.presence;
  const overflow = Math.max(0, online.length - 4);

  const connTone =
    app.connection === 'open'
      ? 'var(--mint)'
      : app.connection === 'reconnecting'
        ? 'var(--amber)'
        : 'var(--ink-faint)';

  return (
    <header className="topbar">
      <button type="button" className="wordmark" onClick={onLeave} title="Back to your workspaces">
        <span className="mark">
          <Icon.Logo size={13} />
        </span>
        <span className="wordmark__name">{workspace.workspace.name}</span>
      </button>

      {/* The heartbeat: how many agents are genuinely executing right now. */}
      <div className="heartbeat" data-live={working > 0} title={`${working} agent(s) executing`}>
        <span className="bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="heartbeat__label">
          {working > 0 ? `${working} working` : 'Team idle'}
        </span>
      </div>

      <div className="spacer" />

      {/*
        The engine is always on screen. When no model credentials are set the
        agents run a deterministic offline policy, and anyone reading their
        output needs to know that without going looking.
      */}
      {engine ? (
        <span
          className={`pill${engine.real ? '' : ' pill--warn'}`}
          title={
            engine.real
              ? 'Agents are running on a language model'
              : 'No model credentials configured — agents run a deterministic offline policy, not an LLM'
          }
        >
          <Icon.Spark size={10} />
          <span className="engine-label">{engine.label}</span>
        </span>
      ) : null}

      <span className="pill" title={`Realtime connection: ${app.connection}`}>
        <span
          className={`dot${app.connection === 'reconnecting' ? ' dot--live' : ''}`}
          style={{ ['--dot' as string]: connTone }}
        />
        <span className="conn-label">{app.connection === 'open' ? 'Live' : app.connection}</span>
      </span>

      <button
        type="button"
        className="bell"
        data-active={attention > 0 || dockOpen}
        onClick={onToggleDock}
        aria-label={attention > 0 ? `${attention} items need you` : 'Nothing needs you'}
        title={attention > 0 ? `${attention} waiting on you` : 'Nothing needs you'}
      >
        <Icon.Bell size={15} />
        {attention > 0 ? <span className="bell__count">{attention}</span> : null}
      </button>

      <div className="facepile">
        {online.slice(0, 4).map((p) => (
          <Avatar
            key={p.userId}
            name={p.displayName}
            tint={p.avatarColor}
            kind="user"
            size="sm"
            title={`${p.displayName} · online`}
          />
        ))}
        {overflow > 0 ? (
          <span className="av av--sm" style={{ ['--tint' as string]: 'var(--ink-low)' }}>
            +{overflow}
          </span>
        ) : null}
      </div>

      <Button variant="quiet" size="sm" onClick={onSignOut} title="Sign out">
        <Icon.Exit size={12} />
      </Button>
    </header>
  );
}

/* ----------------------------------------------------------------- controls */

function SegButton({
  on,
  onClick,
  children,
  count,
  live,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
  live?: boolean;
}) {
  return (
    <button type="button" className="seg__btn" data-on={on} onClick={onClick}>
      {children}
      {count !== undefined && count > 0 ? (
        <span className={`seg__n${live ? ' seg__n--live' : ''}`}>{count}</span>
      ) : null}
    </button>
  );
}

function TabButton({
  on,
  onClick,
  icon,
  label,
  live,
  alert,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  live?: boolean;
  alert?: boolean;
}) {
  return (
    <button type="button" className="tabbar__btn" data-on={on} onClick={onClick}>
      {live ? <span className="tabbar__dot tabbar__dot--live" /> : null}
      {alert ? <span className="tabbar__dot" /> : null}
      {icon}
      {label}
    </button>
  );
}
