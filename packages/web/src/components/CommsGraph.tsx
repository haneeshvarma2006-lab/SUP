import { useMemo } from 'react';
import type { DelegationEdge } from '@sup/shared';
import { useActorLookup, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import { AgentAvatar, Badge, Empty, PanelHeader, relativeTime } from './primitives.js';

const RELATION_COLOR: Record<DelegationEdge['relation'], string> = {
  delegate: 'var(--accent)',
  review: 'var(--violet)',
  ask: 'var(--warn)',
  result: 'var(--ok)',
};

const RELATION_ARROW: Record<DelegationEdge['relation'], string> = {
  delegate: '→',
  review: '⇢',
  ask: '?',
  result: '⇠',
};

/** Edges newer than this animate, so "just happened" is visible at a glance. */
const RECENT_MS = 20_000;

/**
 * Agent-to-agent communication, drawn two ways.
 *
 * The ring shows the shape of the collaboration — who talks to whom — and the
 * log below shows the sequence. Both are built from the same persisted
 * delegation edges the backend records, so the picture cannot drift from what
 * actually happened.
 */
export function CommsGraph() {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(5000);

  const agents = useMemo(() => workspace.agents.filter((a) => a.enabled), [workspace.agents]);
  const edges = workspace.delegations;

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const count = agents.length;
    if (count === 0) return map;

    const cx = 160;
    const cy = 150;
    const radius = count <= 2 ? 70 : count <= 5 ? 100 : 118;

    agents.forEach((agent, i) => {
      // Start at the top so the orchestrator (sorted first) sits at 12 o'clock.
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      map.set(agent.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    });
    return map;
  }, [agents]);

  /** Collapse repeated edges between the same pair into one line. */
  const aggregated = useMemo(() => {
    const map = new Map<string, { edge: DelegationEdge; count: number; latest: number }>();
    for (const edge of edges) {
      const key = `${edge.fromAgentId}:${edge.toAgentId}:${edge.relation}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        existing.latest = Math.max(existing.latest, edge.createdAt);
      } else {
        map.set(key, { edge, count: 1, latest: edge.createdAt });
      }
    }
    return [...map.values()];
  }, [edges]);

  const recentFirst = useMemo(() => [...edges].reverse().slice(0, 80), [edges]);

  return (
    <>
      <PanelHeader title="Agent communication" count={edges.length} />

      <div className="column-scroll">
        {agents.length === 0 ? (
          <Empty icon="🕸">No agents to draw.</Empty>
        ) : (
          <div className="graph-wrap">
            <svg
              className="graph-svg"
              viewBox="0 0 320 300"
              role="img"
              aria-label="Agent communication graph"
            >
              <defs>
                {(['delegate', 'review', 'ask', 'result'] as const).map((relation) => (
                  <marker
                    key={relation}
                    id={`arrow-${relation}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={RELATION_COLOR[relation]} />
                  </marker>
                ))}
              </defs>

              {aggregated.map(({ edge, count, latest }) => {
                const from = positions.get(edge.fromAgentId);
                const to = positions.get(edge.toAgentId);
                if (!from || !to) return null;

                // Bow the line so the outbound and return edges between the same
                // pair do not overlap into one ambiguous stroke.
                const curve = edge.relation === 'result' ? -22 : 22;
                const mx = (from.x + to.x) / 2 + (to.y - from.y) / (curve || 1);
                const my = (from.y + to.y) / 2 - (to.x - from.x) / (curve || 1);

                return (
                  <path
                    key={`${edge.fromAgentId}-${edge.toAgentId}-${edge.relation}`}
                    className={`graph-edge${now - latest < RECENT_MS ? ' recent' : ''}`}
                    d={`M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`}
                    stroke={RELATION_COLOR[edge.relation]}
                    strokeWidth={Math.min(3.5, 1.2 + count * 0.4)}
                    markerEnd={`url(#arrow-${edge.relation})`}
                  />
                );
              })}

              {agents.map((agent) => {
                const position = positions.get(agent.id);
                if (!position) return null;
                const live = agent.status !== 'idle' && agent.status !== 'paused';
                return (
                  <g key={agent.id}>
                    <circle
                      cx={position.x}
                      cy={position.y}
                      r={live ? 15 : 13}
                      fill="var(--surface-2)"
                      stroke={agent.avatarColor}
                      strokeWidth={live ? 2.5 : 1.5}
                      opacity={agent.paused ? 0.4 : 1}
                    />
                    <text
                      x={position.x}
                      y={position.y + 4.5}
                      textAnchor="middle"
                      fontSize="13"
                      style={{ userSelect: 'none' }}
                    >
                      {agent.avatarEmoji}
                    </text>
                    <text className="graph-node-label" x={position.x} y={position.y + 28}>
                      {agent.name}
                    </text>
                  </g>
                );
              })}
            </svg>

            <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap', marginTop: 4 }}>
              {(['delegate', 'review', 'ask', 'result'] as const).map((relation) => (
                <span key={relation} className="row" style={{ gap: 4, fontSize: 11 }}>
                  <span
                    style={{
                      width: 14,
                      height: 2,
                      background: RELATION_COLOR[relation],
                      display: 'inline-block',
                    }}
                  />
                  <span className="dim">{relation}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="section-label">Exchange log</div>

        {recentFirst.length === 0 ? (
          <Empty>Agents have not spoken to each other yet.</Empty>
        ) : (
          recentFirst.map((edge) => {
            const from = workspace.agents.find((a) => a.id === edge.fromAgentId);
            const to = workspace.agents.find((a) => a.id === edge.toAgentId);
            return (
              <div className="comms-row" key={edge.id}>
                {from ? <AgentAvatar agent={from} size="sm" /> : <span className="dim">?</span>}
                <span className="comms-arrow" style={{ color: RELATION_COLOR[edge.relation] }}>
                  {RELATION_ARROW[edge.relation]}
                </span>
                {to ? <AgentAvatar agent={to} size="sm" /> : <span className="dim">?</span>}
                <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
                  {edge.note || lookup(edge.toAgentId).name}
                </span>
                <Badge
                  tone={
                    edge.relation === 'result'
                      ? 'ok'
                      : edge.relation === 'review'
                        ? 'violet'
                        : edge.relation === 'ask'
                          ? 'warn'
                          : 'accent'
                  }
                >
                  {edge.relation}
                </Badge>
                <span className="activity-time">{relativeTime(edge.createdAt, now)}</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
