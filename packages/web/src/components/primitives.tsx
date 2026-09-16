import type { ReactNode } from 'react';
import { initialsFor, type Agent, type AgentStatus, type TaskStatus } from '@sup/shared';

// ---------------------------------------------------------------------------
// Status vocabulary — one place that decides what each state looks like.
// ---------------------------------------------------------------------------

export const AGENT_STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'var(--text-dim)',
  thinking: 'var(--info)',
  working: 'var(--accent)',
  waiting: 'var(--warn)',
  asking: 'var(--warn)',
  delegating: 'var(--violet)',
  reviewing: 'var(--violet)',
  completed: 'var(--ok)',
  error: 'var(--danger)',
  paused: 'var(--text-dim)',
  cancelled: 'var(--text-dim)',
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  waiting: 'Waiting',
  asking: 'Asking',
  delegating: 'Delegating',
  reviewing: 'Reviewing',
  completed: 'Completed',
  error: 'Error',
  paused: 'Paused',
  cancelled: 'Cancelled',
};

/** Statuses where the backend genuinely has the agent executing right now. */
export const LIVE_STATUSES: AgentStatus[] = [
  'thinking',
  'working',
  'waiting',
  'asking',
  'delegating',
  'reviewing',
];

export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: 'var(--text-dim)',
  assigned: 'var(--info)',
  in_progress: 'var(--accent)',
  blocked: 'var(--warn)',
  awaiting_review: 'var(--violet)',
  awaiting_approval: 'var(--warn)',
  completed: 'var(--ok)',
  failed: 'var(--danger)',
  cancelled: 'var(--text-dim)',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  assigned: 'Assigned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  awaiting_review: 'In review',
  awaiting_approval: 'Needs sign-off',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// ---------------------------------------------------------------------------

export function Avatar({
  name,
  color,
  emoji,
  kind,
  size = 'md',
}: {
  name: string;
  color: string;
  emoji?: string;
  kind: 'user' | 'agent' | 'system';
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <div
      className={`avatar ${size} ${kind === 'agent' ? 'agent' : 'user'}`}
      style={{ ['--avatar-color' as string]: color }}
      title={name}
      aria-label={name}
    >
      {kind === 'agent' && emoji ? emoji : initialsFor(name)}
    </div>
  );
}

export function AgentAvatar({ agent, size = 'md' }: { agent: Agent; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Avatar
      name={agent.name}
      color={agent.avatarColor}
      emoji={agent.avatarEmoji}
      kind="agent"
      size={size}
    />
  );
}

export function StatusDot({ status }: { status: AgentStatus }) {
  const live = LIVE_STATUSES.includes(status);
  return (
    <span
      className={`status-dot${live ? ' active' : ''}`}
      style={{ ['--status-color' as string]: AGENT_STATUS_COLOR[status] }}
      title={AGENT_STATUS_LABEL[status]}
      aria-label={AGENT_STATUS_LABEL[status]}
    />
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'violet';
  title?: string;
}) {
  return (
    <span className={`badge${tone === 'neutral' ? '' : ` tone-${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const tone =
    status === 'completed'
      ? 'ok'
      : status === 'failed'
        ? 'danger'
        : status === 'in_progress'
          ? 'accent'
          : status === 'blocked' || status === 'awaiting_approval'
            ? 'warn'
            : status === 'awaiting_review'
              ? 'violet'
              : 'neutral';
  return <Badge tone={tone}>{TASK_STATUS_LABEL[status]}</Badge>;
}

export function Empty({ icon, children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="empty">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <div>{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function PanelHeader({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="panel-header">
      <span>{title}</span>
      {count !== undefined ? <span className="count">{count}</span> : null}
      {children ? <span style={{ marginLeft: 'auto' }}>{children}</span> : null}
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }} role="alert">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
