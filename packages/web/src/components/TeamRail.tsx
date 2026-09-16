import { useMemo } from 'react';
import type { Agent, PresenceEntry, Task } from '@sup/shared';
import { useWorkspaceOrThrow } from '../state/hooks.js';
import {
  AGENT_LABEL,
  AGENT_TONE,
  AgentFace,
  Avatar,
  Dot,
  Empty,
  Icon,
  isLive,
} from './primitives.js';

/**
 * The team rail — who is in the room and what they are doing this second.
 *
 * This is the surface that has to answer "who is doing what" without being
 * read. Three devices do that work:
 *
 *  - Working agents sort to the top, so the busy part of the team is always
 *    where the eye lands first.
 *  - A working agent gets a status ring, a live activity line and a sweeping
 *    track. An idle one gets none of those — the contrast is the signal.
 *  - The activity line is the agent's real `statusDetail` from the backend
 *    ("Delegating to Vela", "Searching: pricing pages"), not a generic label.
 */
export function TeamRail({
  selectedAgentId,
  onSelectAgent,
  onAddAgent,
  shown,
}: {
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onAddAgent: () => void;
  shown?: boolean;
}) {
  const workspace = useWorkspaceOrThrow();

  const agents = useMemo(
    () => rankAgents(workspace.agents, workspace.liveSteps),
    [workspace.agents, workspace.liveSteps],
  );

  const tasksByAgent = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of workspace.tasks) {
      if (task.status === 'in_progress' && task.assignee?.type === 'agent') {
        map.set(task.assignee.id, task);
      }
    }
    return map;
  }, [workspace.tasks]);

  const online = workspace.presence;
  const offline = useMemo(
    () => workspace.members.filter((m) => !online.some((p) => p.userId === m.user.id)),
    [workspace.members, online],
  );

  const working = agents.filter(isLive).length;
  const canEdit = workspace.viewer.role !== 'viewer';

  return (
    <aside className="col col--rail" data-shown={shown} aria-label="Team">
      <div className="scroll">
        <div className="rail__head">
          <span className="rail__title">Agents</span>
          <span className="rail__meta">
            {working > 0 ? (
              <span style={{ color: 'var(--pulse)' }}>{working} working</span>
            ) : (
              `${agents.length} idle`
            )}
          </span>
        </div>

        <div className="rail__group">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              task={tasksByAgent.get(agent.id) ?? null}
              step={workspace.liveSteps[agent.id]?.summary}
              selected={agent.id === selectedAgentId}
              onSelect={() => onSelectAgent(agent.id === selectedAgentId ? null : agent.id)}
            />
          ))}
        </div>

        {agents.length === 0 ? (
          <Empty icon={<Icon.Users size={17} />} title="No agents yet">
            Add one to start building a team.
          </Empty>
        ) : null}

        {canEdit ? (
          <button type="button" className="rail__add" onClick={onAddAgent}>
            <Icon.Plus size={12} /> Add an agent
          </button>
        ) : null}

        <div className="rail__head" style={{ paddingTop: 2 }}>
          <span className="rail__title">People</span>
          <span className="rail__meta">{online.length} online</span>
        </div>

        <div className="rail__group" style={{ gap: 0, paddingBottom: 20 }}>
          {online.map((entry) => (
            <HumanRow
              key={entry.userId}
              entry={entry}
              isViewer={entry.userId === workspace.viewer.user.id}
            />
          ))}

          {offline.map((member) => (
            <div className="human" key={member.user.id} style={{ opacity: 0.45 }}>
              <Avatar
                name={member.user.displayName}
                tint={member.user.avatarColor}
                kind="user"
                size="sm"
              />
              <div className="grow">
                <div className="human__name trunc">{member.user.displayName}</div>
                <div className="human__meta">Away</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function AgentCard({
  agent,
  task,
  step,
  selected,
  onSelect,
}: {
  agent: Agent;
  task: Task | null;
  step: string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const live = isLive(agent);
  const muted = agent.paused || !agent.enabled;

  // Prefer the most specific thing we know: the backend's own status detail,
  // then the last step it reported, then the task title, then the bare status.
  const doing = agent.statusDetail || step || task?.title || AGENT_LABEL[agent.status];

  return (
    <button
      type="button"
      className="agent"
      data-live={live}
      data-selected={selected}
      data-muted={muted}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <AgentFace agent={agent} size="md" />

      <div className="agent__body">
        <div className="agent__top">
          <span className="agent__name grow trunc">{agent.name}</span>
          {agent.isOrchestrator ? <span className="agent__lead">lead</span> : null}
          {!live && !muted ? <Dot tone={AGENT_TONE[agent.status]} /> : null}
        </div>

        {muted ? (
          <div className="agent__role">{agent.paused ? 'Paused' : 'Disabled'}</div>
        ) : live ? (
          <div className="agent__doing" title={doing}>
            {doing}
          </div>
        ) : (
          <div className="agent__role">{agent.role}</div>
        )}

        {live ? (
          <div className="agent__track" aria-hidden="true">
            <i />
          </div>
        ) : null}
      </div>
    </button>
  );
}

function HumanRow({ entry, isViewer }: { entry: PresenceEntry; isViewer: boolean }) {
  return (
    <div className="human">
      <Avatar name={entry.displayName} tint={entry.avatarColor} kind="user" size="sm" />
      <div className="grow">
        <div className="human__name">
          <span className="trunc">{entry.displayName}</span>
          <Dot tone="var(--mint)" />
          {isViewer ? <span className="faint" style={{ fontSize: 10.5 }}>you</span> : null}
        </div>
        <div className="human__meta">
          {entry.connections > 1 ? `${entry.connections} tabs open` : 'Online'}
        </div>
      </div>
    </div>
  );
}

/**
 * Working first, then recently active, then idle, then paused. Within a tier
 * the orchestrator leads and the rest hold their creation order, so cards do
 * not shuffle unpredictably while someone is looking at them.
 */
function rankAgents(agents: Agent[], liveSteps: Record<string, unknown>): Agent[] {
  const tier = (agent: Agent): number => {
    if (agent.paused || !agent.enabled) return 3;
    if (isLive(agent)) return 0;
    if (liveSteps[agent.id]) return 1;
    return 2;
  };

  return [...agents].sort((a, b) => {
    const diff = tier(a) - tier(b);
    if (diff !== 0) return diff;
    if (a.isOrchestrator !== b.isOrchestrator) return a.isOrchestrator ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}
