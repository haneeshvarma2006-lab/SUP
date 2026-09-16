import { useMemo } from 'react';
import type { DelegationEdge } from '@sup/shared';
import { useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import { Avatar, Empty, Icon, Tag, relTime } from './primitives.js';

const TONE: Record<DelegationEdge['relation'], string> = {
  delegate: 'var(--iris)',
  review: 'var(--lilac)',
  ask: 'var(--amber)',
  result: 'var(--mint)',
};

/** Edges newer than this animate, so "just happened" reads without a timestamp. */
const RECENT_MS = 25_000;

/**
 * Agent-to-agent communication.
 *
 * Two readings of the same persisted edges: the ring shows the *shape* of the
 * collaboration — who works with whom, and who is central — and the log below
 * shows the *sequence*. Neither is a simulation; both are built from the
 * delegation records the server writes when work actually changes hands.
 */
export function CommsGraph() {
  const workspace = useWorkspaceOrThrow();
  const now = useTicker(4000);

  const agents = useMemo(() => workspace.agents.filter((a) => a.enabled), [workspace.agents]);
  const edges = workspace.delegations;

  const layout = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    const n = agents.length;
    if (n === 0) return map;

    const cx = 168;
    const cy = 150;
    const r = n <= 2 ? 66 : n <= 5 ? 96 : 114;

    agents.forEach((agent, i) => {
      // Start at twelve o'clock so the orchestrator (sorted first) sits at the top.
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      map.set(agent.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    });
    return map;
  }, [agents]);

  /** Collapse repeats between the same pair so weight shows volume. */
  const bundled = useMemo(() => {
    const map = new Map<string, { edge: DelegationEdge; n: number; last: number }>();
    for (const edge of edges) {
      const key = `${edge.fromAgentId}:${edge.toAgentId}:${edge.relation}`;
      const found = map.get(key);
      if (found) {
        found.n += 1;
        found.last = Math.max(found.last, edge.createdAt);
      } else {
        map.set(key, { edge, n: 1, last: edge.createdAt });
      }
    }
    return [...map.values()];
  }, [edges]);

  const recent = useMemo(() => [...edges].reverse().slice(0, 60), [edges]);

  if (agents.length === 0) {
    return (
      <div className="scroll">
        <Empty icon={<Icon.Share size={17} />}>No agents to draw.</Empty>
      </div>
    );
  }

  return (
    <div className="scroll">
      <div className="graph">
        <svg viewBox="0 0 336 300" role="img" aria-label="Agent communication graph">
          <defs>
            {(['delegate', 'review', 'ask', 'result'] as const).map((rel) => (
              <marker
                key={rel}
                id={`tip-${rel}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill={TONE[rel]} />
              </marker>
            ))}
          </defs>

          {bundled.map(({ edge, n, last }) => {
            const from = layout.get(edge.fromAgentId);
            const to = layout.get(edge.toAgentId);
            if (!from || !to) return null;

            // Bow the path so an outbound edge and its return do not collapse
            // into one ambiguous stroke.
            const bow = edge.relation === 'result' ? -20 : 20;
            const mx = (from.x + to.x) / 2 + (to.y - from.y) / bow;
            const my = (from.y + to.y) / 2 - (to.x - from.x) / bow;

            return (
              <path
                key={`${edge.fromAgentId}-${edge.toAgentId}-${edge.relation}`}
                className="edge"
                data-recent={now - last < RECENT_MS}
                d={`M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`}
                stroke={TONE[edge.relation]}
                strokeWidth={Math.min(3.2, 1.1 + n * 0.35)}
                markerEnd={`url(#tip-${edge.relation})`}
              />
            );
          })}

          {agents.map((agent) => {
            const at = layout.get(agent.id);
            if (!at) return null;
            const busy = agent.status !== 'idle' && agent.status !== 'paused' && !agent.paused;
            return (
              <g key={agent.id}>
                {busy ? (
                  <circle cx={at.x} cy={at.y} r={19} fill={agent.avatarColor} opacity={0.12} />
                ) : null}
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={busy ? 14.5 : 13}
                  fill="var(--raised-2)"
                  stroke={agent.avatarColor}
                  strokeWidth={busy ? 2 : 1.2}
                  opacity={agent.paused ? 0.4 : 1}
                />
                <text
                  x={at.x}
                  y={at.y + 4.5}
                  textAnchor="middle"
                  fontSize="12.5"
                  style={{ userSelect: 'none' }}
                >
                  {agent.avatarEmoji}
                </text>
                <text className="node-label" x={at.x} y={at.y + 27}>
                  {agent.name}
                </text>
              </g>
            );
          })}
        </svg>

        <div className="legend">
          {(['delegate', 'review', 'ask', 'result'] as const).map((rel) => (
            <span key={rel}>
              <i style={{ background: TONE[rel] }} />
              {rel}
            </span>
          ))}
        </div>
      </div>

      <div className="shead">
        <span>Exchange log</span>
        <span className="shead__line" />
      </div>

      {recent.length === 0 ? (
        <Empty>Agents have not handed work to each other yet.</Empty>
      ) : (
        recent.map((edge) => {
          const from = workspace.agents.find((a) => a.id === edge.fromAgentId);
          const to = workspace.agents.find((a) => a.id === edge.toAgentId);
          return (
            <div className="xchg" key={edge.id}>
              {from ? (
                <Avatar
                  name={from.name}
                  tint={from.avatarColor}
                  emoji={from.avatarEmoji}
                  kind="agent"
                  size="xs"
                />
              ) : null}
              <Icon.Arrow size={11} style={{ color: TONE[edge.relation], flexShrink: 0 }} />
              {to ? (
                <Avatar
                  name={to.name}
                  tint={to.avatarColor}
                  emoji={to.avatarEmoji}
                  kind="agent"
                  size="xs"
                />
              ) : null}
              <span className="grow trunc mid">{edge.note || to?.name}</span>
              <Tag
                tone={
                  edge.relation === 'result'
                    ? 'mint'
                    : edge.relation === 'review'
                      ? 'lilac'
                      : edge.relation === 'ask'
                        ? 'amber'
                        : 'iris'
                }
              >
                {edge.relation}
              </Tag>
              <span className="faint" style={{ fontSize: 10.5 }}>
                {relTime(edge.createdAt, now)}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
