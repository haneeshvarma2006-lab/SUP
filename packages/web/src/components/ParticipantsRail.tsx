import { useMemo } from 'react';
import type { Agent, PresenceEntry } from '@sup/shared';
import { useWorkspaceOrThrow } from '../state/hooks.js';
import {
  AGENT_STATUS_COLOR,
  AGENT_STATUS_LABEL,
  Avatar,
  AgentAvatar,
  Badge,
  Empty,
  LIVE_STATUSES,
  PanelHeader,
  StatusDot,
} from './primitives.js';

/**
 * The left rail: who is in the room and what they are doing right now.
 *
 * This is the answer to "WHO is doing WHAT" at a glance — live agents sort to
 * the top with their current activity inline, so the busy part of the team is
 * always what you see first.
 */
export function ParticipantsRail({
  selectedAgentId,
  onSelectAgent,
  onAddAgent,
  mobileActive,
}: {
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onAddAgent: () => void;
  mobileActive?: boolean;
}) {
  const workspace = useWorkspaceOrThrow();

  const agents = useMemo(() => sortAgents(workspace.agents, workspace.liveSteps), [
    workspace.agents,
    workspace.liveSteps,
  ]);

  const online = workspace.presence;
  const offline = useMemo(
    () => workspace.members.filter((m) => !online.some((p) => p.userId === m.user.id)),
    [workspace.members, online],
  );

  const liveCount = agents.filter((a) => LIVE_STATUSES.includes(a.status)).length;

  return (
    <div
      className={`column${mobileActive ? ' mobile-active' : ''}`}
      role="complementary"
      aria-label="Participants"
    >
      <PanelHeader title="Participants" count={agents.length + workspace.members.length} />

      <div className="column-scroll">
        <div className="section-label">
          AI agents{liveCount > 0 ? ` · ${liveCount} active` : ''}
        </div>

        {agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            liveStep={workspace.liveSteps[agent.id]?.summary}
            selected={agent.id === selectedAgentId}
            onSelect={() => onSelectAgent(agent.id === selectedAgentId ? null : agent.id)}
          />
        ))}

        {agents.length === 0 ? <Empty icon="🤖">No agents in this workspace yet.</Empty> : null}

        <div style={{ padding: '10px 16px 4px' }}>
          <button type="button" className="btn ghost sm" onClick={onAddAgent} style={{ width: '100%' }}>
            + Add an agent
          </button>
        </div>

        <div className="section-label">Humans · {online.length} online</div>

        {online.map((entry) => (
          <HumanRow key={entry.userId} entry={entry} isViewer={entry.userId === workspace.viewer.user.id} />
        ))}

        {offline.map((member) => (
          <div className="participant" key={member.user.id}>
            <Avatar
              name={member.user.displayName}
              color={member.user.avatarColor}
              kind="user"
              size="md"
            />
            <div className="participant-body">
              <div className="participant-name" style={{ opacity: 0.6 }}>
                {member.user.displayName}
              </div>
              <div className="participant-meta">Offline · {member.role}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  liveStep,
  selected,
  onSelect,
}: {
  agent: Agent;
  liveStep: string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const live = LIVE_STATUSES.includes(agent.status);
  const detail = agent.paused
    ? 'Paused by a human'
    : live
      ? agent.statusDetail || liveStep || AGENT_STATUS_LABEL[agent.status]
      : agent.role;

  return (
    <button
      type="button"
      className={`participant${selected ? ' selected' : ''}${live ? ' working' : ''}`}
      style={{ ['--status-color' as string]: AGENT_STATUS_COLOR[agent.status] }}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <AgentAvatar agent={agent} />
      <div className="participant-body">
        <div className="participant-name">
          <span className="truncate">{agent.name}</span>
          <StatusDot status={agent.status} />
          {agent.isOrchestrator ? <Badge tone="accent">lead</Badge> : null}
        </div>
        <div className={`participant-meta${live ? ' live' : ''}`}>{detail}</div>
      </div>
    </button>
  );
}

function HumanRow({ entry, isViewer }: { entry: PresenceEntry; isViewer: boolean }) {
  return (
    <div className="participant">
      <Avatar name={entry.displayName} color={entry.avatarColor} kind="user" size="md" />
      <div className="participant-body">
        <div className="participant-name">
          <span className="truncate">{entry.displayName}</span>
          <span
            className="status-dot"
            style={{ ['--status-color' as string]: 'var(--ok)' }}
            aria-label="Online"
          />
          {isViewer ? <span className="dim" style={{ fontSize: 11 }}>you</span> : null}
        </div>
        <div className="participant-meta">
          {entry.focus ? `Viewing ${entry.focus}` : 'Online'}
          {entry.connections > 1 ? ` · ${entry.connections} tabs` : ''}
        </div>
      </div>
    </div>
  );
}

/** Live agents first, then idle, then paused or disabled. Stable within a tier. */
function sortAgents(agents: Agent[], liveSteps: Record<string, unknown>): Agent[] {
  const rank = (agent: Agent): number => {
    if (agent.paused || !agent.enabled) return 3;
    if (LIVE_STATUSES.includes(agent.status)) return 0;
    if (liveSteps[agent.id]) return 1;
    return 2;
  };
  return [...agents].sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    if (a.isOrchestrator !== b.isOrchestrator) return a.isOrchestrator ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}
