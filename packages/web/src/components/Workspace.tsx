import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAppState, useWorkspaceOrThrow } from '../state/hooks.js';
import { ActivityFeed } from './ActivityFeed.js';
import { AddAgentDialog } from './AddAgentDialog.js';
import { AgentPanel } from './AgentPanel.js';
import { ChatPanel } from './ChatPanel.js';
import { CommsGraph } from './CommsGraph.js';
import { FilesPanel } from './FilesPanel.js';
import { MemoryPanel } from './MemoryPanel.js';
import { ApprovalBar, ObjectiveBar } from './ObjectiveBar.js';
import { ParticipantsRail } from './ParticipantsRail.js';
import { TaskBoard, TaskDetail } from './TaskBoard.js';
import { Avatar, Badge, LIVE_STATUSES } from './primitives.js';

type SidePanel = 'activity' | 'tasks' | 'comms' | 'memory' | 'files';

/**
 * The workspace shell.
 *
 * Three columns by default — who is here, the conversation, and whichever
 * instrument panel you are watching — plus an inspector that slides in when you
 * click an agent or a task. Everything in every column is driven by the same
 * event stream, so the columns cannot disagree with each other.
 */
export function Workspace({
  onLeave,
  onSignOut,
}: {
  onLeave: () => void;
  onSignOut: () => void;
}) {
  const app = useAppState();
  const workspace = useWorkspaceOrThrow();

  const [panel, setPanel] = useState<SidePanel>('activity');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [addingAgent, setAddingAgent] = useState(false);
  const [mobileColumn, setMobileColumn] = useState<'rail' | 'chat' | 'panel'>('chat');

  const activeAgents = workspace.agents.filter((a) => LIVE_STATUSES.includes(a.status)).length;
  const openTasks = workspace.tasks.filter(
    (t) => !['completed', 'failed', 'cancelled'].includes(t.status),
  ).length;

  // Opening an agent closes the task inspector and vice versa — two inspectors
  // at once would not fit and would make the selection ambiguous.
  const selectAgent = (agentId: string | null) => {
    setSelectedAgentId(agentId);
    if (agentId) setSelectedTaskId(null);
  };
  const selectTask = (taskId: string | null) => {
    setSelectedTaskId(taskId);
    if (taskId) setSelectedAgentId(null);
  };

  const inspectorOpen = selectedAgentId !== null || selectedTaskId !== null;

  return (
    <div className="app-shell">
      <TopBar
        onLeave={onLeave}
        onSignOut={onSignOut}
        activeAgents={activeAgents}
        openTasks={openTasks}
      />

      {app.banner ? (
        <div className={`banner ${app.banner.kind}`} role="status">
          {app.banner.message}
        </div>
      ) : null}

      <ApprovalBar />

      <div className={`workspace-grid${inspectorOpen ? ' with-inspector' : ''}`}>
        <ParticipantsRail
          selectedAgentId={selectedAgentId}
          onSelectAgent={selectAgent}
          onAddAgent={() => setAddingAgent(true)}
          mobileActive={mobileColumn === 'rail'}
        />

        <div className={`column${mobileColumn === 'chat' ? ' mobile-active' : ''}`} style={{ padding: 0 }}>
          <ObjectiveBar />
          <ChatPanel onOpenTask={selectTask} />
        </div>

        <div className={`column side-panel${mobileColumn === 'panel' ? ' mobile-active' : ''}`}>
          <div className="tabs">
            {(
              [
                ['activity', 'Activity'],
                ['tasks', 'Tasks'],
                ['comms', 'Agent comms'],
                ['memory', 'Memory'],
                ['files', 'Files'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`tab${panel === key ? ' active' : ''}`}
                onClick={() => setPanel(key)}
              >
                {label}
                {key === 'tasks' && openTasks > 0 ? (
                  <span className="tab-count">{openTasks}</span>
                ) : null}
                {key === 'memory' ? (
                  <span className="tab-count">{workspace.memories.length}</span>
                ) : null}
              </button>
            ))}
          </div>

          {panel === 'activity' ? <ActivityFeed /> : null}
          {panel === 'tasks' ? <TaskBoard onOpenTask={selectTask} /> : null}
          {panel === 'comms' ? <CommsGraph /> : null}
          {panel === 'memory' ? <MemoryPanel /> : null}
          {panel === 'files' ? <FilesPanel /> : null}
        </div>

        {selectedAgentId ? (
          <AgentPanel agentId={selectedAgentId} onClose={() => selectAgent(null)} />
        ) : null}
        {selectedTaskId ? (
          <TaskDetail taskId={selectedTaskId} onClose={() => selectTask(null)} />
        ) : null}
      </div>

      <MobileNav current={mobileColumn} onChange={setMobileColumn} />

      {addingAgent ? <AddAgentDialog onClose={() => setAddingAgent(false)} /> : null}
    </div>
  );
}

function TopBar({
  onLeave,
  onSignOut,
  activeAgents,
  openTasks,
}: {
  onLeave: () => void;
  onSignOut: () => void;
  activeAgents: number;
  openTasks: number;
}) {
  const app = useAppState();
  const workspace = useWorkspaceOrThrow();
  const [health, setHealth] = useState<{ provider: string; isLanguageModel: boolean } | null>(null);

  useEffect(() => {
    api
      .health()
      .then((report) =>
        setHealth({ provider: report.ai.displayName, isLanguageModel: report.ai.isLanguageModel }),
      )
      .catch(() => setHealth(null));
  }, []);

  const connectionTone =
    app.connection === 'open'
      ? 'var(--ok)'
      : app.connection === 'reconnecting'
        ? 'var(--warn)'
        : 'var(--text-dim)';

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={onLeave} title="Back to your workspaces">
        <span className="brand-mark">◆</span>
        <span>{workspace.workspace.name}</span>
      </button>

      <div className="row" style={{ gap: 6 }}>
        {activeAgents > 0 ? (
          <Badge tone="accent">
            {activeAgents} agent{activeAgents === 1 ? '' : 's'} working
          </Badge>
        ) : null}
        {openTasks > 0 ? <Badge>{openTasks} open</Badge> : null}
      </div>

      <div className="topbar-spacer" />

      {/*
        The engine is always visible. When no model credentials are configured
        the agents run on the offline heuristic policy, and a person reading
        their output needs to know that.
      */}
      {health ? (
        <span
          className="connection-pill"
          title={
            health.isLanguageModel
              ? 'Agents are running on a language model'
              : 'No model credentials configured — agents run a deterministic offline policy, not an LLM'
          }
        >
          <span
            className="status-dot"
            style={{
              ['--status-color' as string]: health.isLanguageModel ? 'var(--ok)' : 'var(--warn)',
            }}
          />
          {health.provider}
        </span>
      ) : null}

      <span className="connection-pill" title={`Realtime connection: ${app.connection}`}>
        <span
          className={`status-dot${app.connection === 'reconnecting' ? ' active' : ''}`}
          style={{ ['--status-color' as string]: connectionTone }}
        />
        {app.connection === 'open' ? 'Live' : app.connection}
      </span>

      <div className="row" style={{ gap: 6 }}>
        <Avatar
          name={workspace.viewer.user.displayName}
          color={workspace.viewer.user.avatarColor}
          kind="user"
          size="sm"
        />
        <button type="button" className="btn ghost sm" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

/** Column switcher, only visible at narrow widths (see the CSS media query). */
function MobileNav({
  current,
  onChange,
}: {
  current: 'rail' | 'chat' | 'panel';
  onChange: (next: 'rail' | 'chat' | 'panel') => void;
}) {
  return (
    // Visibility is controlled by the .mobile-nav media query in global.css,
    // so this is hidden on desktop without JavaScript measuring anything.
    <nav className="mobile-nav">
      {(
        [
          ['rail', 'Team'],
          ['chat', 'Room'],
          ['panel', 'Panels'],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={`tab${current === key ? ' active' : ''}`}
          style={{ flex: 1, textAlign: 'center' }}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
