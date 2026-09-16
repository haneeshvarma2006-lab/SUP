import { type ReactNode } from 'react';
import type { EventType, WorkspaceEvent } from '@sup/shared';
import { useActivityFeed, useActorLookup, useTicker } from '../state/hooks.js';
import { Empty, PanelHeader, relativeTime } from './primitives.js';

const ICONS: Partial<Record<EventType, string>> = {
  USER_JOINED: '→',
  USER_LEFT: '←',
  AGENT_CREATED: '✦',
  AGENT_STARTED: '▶',
  AGENT_FINISHED: '■',
  AGENT_ERROR: '!',
  AGENT_CANCELLED: '✕',
  AGENT_PAUSED: '⏸',
  AGENT_RESUMED: '▶',
  AGENT_MESSAGE: '↔',
  AGENT_QUESTION: '?',
  TASK_CREATED: '+',
  TASK_ASSIGNED: '◈',
  TASK_DELEGATED: '→',
  TASK_STARTED: '▶',
  TASK_BLOCKED: '⊘',
  TASK_COMPLETED: '✓',
  TASK_FAILED: '✕',
  TASK_CANCELLED: '✕',
  TASK_REVIEW_REQUESTED: '👁',
  PLAN_CREATED: '⬡',
  USER_FEEDBACK: '★',
  MEMORY_CREATED: '⌾',
  FILE_CREATED: '▣',
  FILE_UPDATED: '▣',
  TOOL_CALLED: '⚙',
  TOOL_DENIED: '⛔',
  APPROVAL_REQUESTED: '🔐',
  APPROVAL_RESOLVED: '🔓',
  OBJECTIVE_STARTED: '◆',
  OBJECTIVE_COMPLETED: '✦',
  SYSTEM_NOTICE: 'ⓘ',
};

const COLORS: Partial<Record<EventType, string>> = {
  TASK_COMPLETED: 'var(--ok)',
  OBJECTIVE_COMPLETED: 'var(--ok)',
  AGENT_ERROR: 'var(--danger)',
  TASK_FAILED: 'var(--danger)',
  TOOL_DENIED: 'var(--danger)',
  TASK_BLOCKED: 'var(--warn)',
  AGENT_QUESTION: 'var(--warn)',
  APPROVAL_REQUESTED: 'var(--warn)',
  TASK_DELEGATED: 'var(--violet)',
  AGENT_MESSAGE: 'var(--violet)',
  MEMORY_CREATED: 'var(--info)',
  OBJECTIVE_STARTED: 'var(--accent)',
};

/**
 * The real-time event stream.
 *
 * This is the raw truth of the system: every row corresponds to a persisted,
 * sequenced event on the server, not to a UI-side inference. If it is not here,
 * it did not happen.
 */
export function ActivityFeed() {
  const events = useActivityFeed(150);
  const lookup = useActorLookup();
  const now = useTicker(15_000);

  return (
    <>
      <PanelHeader title="Activity" count={events.length} />
      <div className="column-scroll">
        {events.length === 0 ? (
          <Empty icon="📡">Nothing has happened yet.</Empty>
        ) : (
          events.map((event) => (
            <div className="activity-row" key={event.id}>
              <span className="activity-icon" style={{ color: COLORS[event.type] ?? 'var(--text-dim)' }}>
                {ICONS[event.type] ?? '•'}
              </span>
              <div className="activity-body">
                <div className="activity-text">{describe(event, lookup)}</div>
              </div>
              <span className="activity-time">{relativeTime(event.createdAt, now)}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/** Turns an event into one readable line. */
function describe(event: WorkspaceEvent, lookup: ReturnType<typeof useActorLookup>): ReactNode {
  const p = event.payload as Record<string, unknown>;
  const actor = event.actor.name ?? lookup(event.actor.id).name;
  const who = <strong>{actor}</strong>;

  const taskTitle = (p.task as { title?: string } | undefined)?.title;
  const agentName = (id: unknown) => (typeof id === 'string' ? lookup(id).name : 'an agent');

  switch (event.type) {
    case 'USER_JOINED':
      return <>{who} joined the workspace</>;
    case 'USER_LEFT':
      return <>{who} left</>;

    case 'AGENT_CREATED':
      return (
        <>
          {who} added <strong>{(p.agent as { name?: string }).name}</strong> to the team
        </>
      );
    case 'AGENT_STARTED':
      return <>{who} started working</>;
    case 'AGENT_FINISHED': {
      const run = p.run as { status?: string; usage?: { toolCalls?: number } };
      return (
        <>
          {who} finished ({run.status}
          {run.usage?.toolCalls ? `, ${run.usage.toolCalls} tool calls` : ''})
        </>
      );
    }
    case 'AGENT_ERROR':
      return (
        <>
          {who} hit an error: {String(p.message)}
        </>
      );
    case 'AGENT_CANCELLED':
      return (
        <>
          {who} was stopped — {String(p.reason)}
        </>
      );
    case 'AGENT_PAUSED':
      return <>{who} paused {agentName(p.agentId)}</>;
    case 'AGENT_RESUMED':
      return <>{who} resumed {agentName(p.agentId)}</>;

    case 'AGENT_MESSAGE': {
      const message = p.message as { recipient?: { id: string } | null; body: string };
      return (
        <>
          {who}
          {message.recipient ? <> → <strong>{agentName(message.recipient.id)}</strong></> : null}:{' '}
          {clip(message.body, 130)}
        </>
      );
    }
    case 'AGENT_QUESTION':
      return (
        <>
          {who} asked the humans: {clip((p.message as { body: string }).body, 130)}
        </>
      );

    case 'TASK_CREATED':
      return <>{who} created “{clip(taskTitle, 70)}”</>;
    case 'TASK_ASSIGNED':
      return (
        <>
          {who} assigned “{clip(taskTitle, 55)}” to{' '}
          <strong>{(p.assignee as { name?: string })?.name ?? 'someone'}</strong>
        </>
      );
    case 'TASK_DELEGATED': {
      const assignee = (p.task as { assignee?: { name?: string } }).assignee;
      return (
        <>
          {who} delegated “{clip(taskTitle, 55)}” to <strong>{assignee?.name ?? 'a teammate'}</strong>
        </>
      );
    }
    case 'TASK_STARTED':
      return <>Work started on “{clip(taskTitle, 70)}”</>;
    case 'TASK_BLOCKED':
      return (
        <>
          “{clip(taskTitle, 55)}” is blocked — {String(p.reason)}
        </>
      );
    case 'TASK_COMPLETED':
      return <>{who} completed “{clip(taskTitle, 70)}”</>;
    case 'TASK_FAILED':
      return (
        <>
          “{clip(taskTitle, 55)}” failed — {clip(String(p.error), 100)}
        </>
      );
    case 'TASK_CANCELLED':
      return <>{who} cancelled “{clip(taskTitle, 70)}”</>;
    case 'TASK_REVIEW_REQUESTED':
      return <>“{clip(taskTitle, 70)}” is waiting on a human decision</>;

    case 'PLAN_CREATED':
      return (
        <>
          {who} planned {(p.tasks as unknown[])?.length ?? 0} steps
        </>
      );

    case 'USER_FEEDBACK':
      return (
        <>
          {who} gave <strong>{String(p.verdict)}</strong> feedback
          {p.memoryId ? ' — stored in project memory' : ''}
        </>
      );

    case 'MEMORY_CREATED': {
      const record = p.record as { scope: string; title: string };
      return (
        <>
          {who} remembered [{record.scope}] {clip(record.title, 70)}
        </>
      );
    }

    case 'FILE_CREATED':
    case 'FILE_UPDATED':
      return (
        <>
          {who} {event.type === 'FILE_CREATED' ? 'created' : 'updated'}{' '}
          <span className="mono">{(p.file as { path: string }).path}</span>
        </>
      );

    case 'TOOL_CALLED':
      return (
        <>
          {who} called <span className="mono">{String(p.toolName)}()</span>
        </>
      );
    case 'TOOL_DENIED':
      return (
        <>
          {who} was denied <span className="mono">{String(p.toolName)}()</span> — {String(p.reason)}
        </>
      );

    case 'APPROVAL_REQUESTED':
      return (
        <>
          {who} needs approval for{' '}
          <span className="mono">{(p.approval as { action: string }).action}</span>
        </>
      );
    case 'APPROVAL_RESOLVED': {
      const approval = p.approval as { status: string; action: string };
      return (
        <>
          {who} {approval.status} <span className="mono">{approval.action}</span>
        </>
      );
    }

    case 'OBJECTIVE_STARTED':
      return <>{who} started the objective “{clip(String(p.title), 70)}”</>;
    case 'OBJECTIVE_COMPLETED':
      return <>Objective complete: “{clip(String(p.title), 70)}”</>;

    case 'SYSTEM_NOTICE':
      return <>{String(p.message)}</>;

    default:
      return <>{event.type}</>;
  }
}

function clip(text: string | undefined, max: number): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
