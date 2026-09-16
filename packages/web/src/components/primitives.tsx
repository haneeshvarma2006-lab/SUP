import type { CSSProperties, ReactNode } from 'react';
import { initialsFor, type Agent, type AgentStatus, type TaskStatus } from '@sup/shared';
import { Icon } from './icons.js';

/* ------------------------------------------------------------------ status */

/**
 * The status vocabulary, defined once.
 *
 * `--pulse` is reserved for states where the backend is genuinely executing.
 * `--amber` is reserved for states where a human is the blocker. Keeping those
 * two meanings exclusive is what lets someone read the room in one glance
 * instead of decoding a legend.
 */
export const AGENT_TONE: Record<AgentStatus, string> = {
  idle: 'var(--ink-low)',
  thinking: 'var(--pulse)',
  working: 'var(--pulse)',
  delegating: 'var(--lilac)',
  reviewing: 'var(--lilac)',
  waiting: 'var(--amber)',
  asking: 'var(--amber)',
  completed: 'var(--mint)',
  error: 'var(--rose)',
  paused: 'var(--ink-faint)',
  cancelled: 'var(--ink-faint)',
};

export const AGENT_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  delegating: 'Delegating',
  reviewing: 'Reviewing',
  waiting: 'Waiting',
  asking: 'Asking',
  completed: 'Done',
  error: 'Error',
  paused: 'Paused',
  cancelled: 'Stopped',
};

/** Statuses where a run is genuinely in flight on the server. */
export const LIVE_STATUSES: AgentStatus[] = [
  'thinking',
  'working',
  'waiting',
  'asking',
  'delegating',
  'reviewing',
];

export function isLive(agent: Agent): boolean {
  return !agent.paused && LIVE_STATUSES.includes(agent.status);
}

export const TASK_TONE: Record<TaskStatus, string> = {
  backlog: 'var(--ink-faint)',
  assigned: 'var(--sky)',
  in_progress: 'var(--pulse)',
  blocked: 'var(--amber)',
  awaiting_review: 'var(--lilac)',
  awaiting_approval: 'var(--amber)',
  completed: 'var(--mint)',
  failed: 'var(--rose)',
  cancelled: 'var(--ink-faint)',
};

export const TASK_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  assigned: 'Queued',
  in_progress: 'Running',
  blocked: 'Blocked',
  awaiting_review: 'In review',
  awaiting_approval: 'Needs you',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

export type Tone = 'neutral' | 'iris' | 'pulse' | 'amber' | 'mint' | 'rose' | 'lilac' | 'sky';

export function taskTone(status: TaskStatus): Tone {
  switch (status) {
    case 'completed':
      return 'mint';
    case 'failed':
      return 'rose';
    case 'in_progress':
      return 'pulse';
    case 'blocked':
    case 'awaiting_approval':
      return 'amber';
    case 'awaiting_review':
      return 'lilac';
    case 'assigned':
      return 'sky';
    default:
      return 'neutral';
  }
}

/* ----------------------------------------------------------------- avatars */

type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function Avatar({
  name,
  tint,
  emoji,
  kind,
  size = 'md',
  title,
}: {
  name: string;
  tint: string;
  emoji?: string;
  kind: 'user' | 'agent' | 'system';
  size?: Size;
  title?: string;
}) {
  const showEmoji = kind === 'agent' && Boolean(emoji);
  return (
    <div
      className={`av av--${size}${showEmoji ? ' av--emoji' : ''}`}
      style={{ ['--tint' as string]: tint }}
      title={title ?? name}
      aria-hidden="true"
    >
      {showEmoji ? emoji : initialsFor(name)}
    </div>
  );
}

/**
 * An agent avatar wrapped in a status ring.
 *
 * The ring is drawn only while the agent is genuinely executing, so a glance at
 * the rail separates the working team from the resting one with no reading.
 */
export function AgentFace({
  agent,
  size = 'md',
  ring = true,
}: {
  agent: Agent;
  size?: Size;
  ring?: boolean;
}) {
  const live = isLive(agent);
  return (
    <div
      className="avring"
      data-live={ring && live}
      style={{ ['--ring' as string]: AGENT_TONE[agent.status] }}
    >
      <Avatar
        name={agent.name}
        tint={agent.avatarColor}
        emoji={agent.avatarEmoji}
        kind="agent"
        size={size}
        title={`${agent.name} — ${agent.role}${live ? ` · ${AGENT_LABEL[agent.status]}` : ''}`}
      />
    </div>
  );
}

export function Dot({ tone, live = false }: { tone: string; live?: boolean }) {
  return (
    <span
      className={`dot${live ? ' dot--live' : ''}`}
      style={{ ['--dot' as string]: tone }}
      aria-hidden="true"
    />
  );
}

/* -------------------------------------------------------------------- bits */

export function Tag({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span className={`tag${tone === 'neutral' ? '' : ` tag--${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size,
  disabled,
  title,
  type = 'button',
  style,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'quiet' | 'danger' | 'ok';
  size?: 'sm';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  style?: CSSProperties;
  className?: string;
  ariaLabel?: string;
}) {
  const classes = [
    'btn',
    variant === 'default' ? '' : `btn--${variant}`,
    size === 'sm' ? 'btn--sm' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      style={style}
    >
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  label,
  variant = 'quiet',
  disabled,
}: {
  icon: ReactNode;
  onClick?: () => void;
  label: string;
  variant?: 'default' | 'ghost' | 'quiet' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn--icon${variant === 'default' ? '' : ` btn--${variant}`}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}

export function SectionHead({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="shead">
      <span>{children}</span>
      <span className="shead__line" />
      {action}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? <div className="empty__icon">{icon}</div> : null}
      {title ? (
        <div style={{ color: 'var(--ink-mid)', fontWeight: 560, marginBottom: 3 }}>{title}</div>
      ) : null}
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spin" role="status" aria-label="Loading" />;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="err" role="alert">
      {children}
    </div>
  );
}

export function Meter({ value, tone }: { value: number; tone?: string }) {
  return (
    <div className="meter" role="progressbar" aria-valuenow={Math.round(value * 100)}>
      <i
        style={{
          width: `${Math.max(0, Math.min(1, value)) * 100}%`,
          ...(tone ? { background: tone } : {}),
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- time */

export function relTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 8) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export { Icon };
