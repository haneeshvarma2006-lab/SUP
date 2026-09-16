import type { ReactNode } from 'react';
import type { EventType, WorkspaceEvent } from '@sup/shared';
import { useActivityFeed, useActorLookup, useTicker } from '../state/hooks.js';
import { Empty, Icon, relTime } from './primitives.js';

/**
 * The real-time event stream.
 *
 * Every row here is a persisted, sequenced event from the server. Nothing is
 * inferred client-side, which is what makes this the authoritative answer to
 * "what just happened" rather than a nicely-worded guess.
 *
 * Glyph and colour carry the category so the feed can be skimmed vertically:
 * green for progress, cyan for live work, amber for anything blocked on a
 * human, rose for failure.
 */
export function ActivityFeed() {
  const events = useActivityFeed(160);
  const lookup = useActorLookup();
  const now = useTicker(10_000);

  if (events.length === 0) {
    return (
      <div className="scroll">
        <Empty icon={<Icon.Pulse size={17} />} title="Nothing yet">
          Every action the team takes will appear here the moment it happens.
        </Empty>
      </div>
    );
  }

  return (
    <div className="scroll">
      {events.map((event) => {
        const look = GLYPHS[event.type] ?? { icon: <Icon.Dots size={12} />, tone: 'var(--ink-faint)' };
        return (
          <div className="evt" key={event.id}>
            <span className="evt__glyph" style={{ ['--glyph' as string]: look.tone }}>
              {look.icon}
            </span>
            <span className="evt__text">{describe(event, lookup)}</span>
            <span className="evt__when">{relTime(event.createdAt, now)}</span>
          </div>
        );
      })}
    </div>
  );
}

const GLYPHS: Partial<Record<EventType, { icon: ReactNode; tone: string }>> = {
  USER_JOINED: { icon: <Icon.Enter size={12} />, tone: 'var(--mint)' },
  USER_LEFT: { icon: <Icon.Exit size={12} />, tone: 'var(--ink-faint)' },
  AGENT_CREATED: { icon: <Icon.Spark size={12} />, tone: 'var(--iris-bright)' },
  AGENT_STARTED: { icon: <Icon.Play size={12} />, tone: 'var(--pulse)' },
  AGENT_FINISHED: { icon: <Icon.Stop size={12} />, tone: 'var(--ink-low)' },
  AGENT_ERROR: { icon: <Icon.Warn size={12} />, tone: 'var(--rose)' },
  AGENT_CANCELLED: { icon: <Icon.X size={12} />, tone: 'var(--ink-faint)' },
  AGENT_PAUSED: { icon: <Icon.Pause size={12} />, tone: 'var(--ink-faint)' },
  AGENT_RESUMED: { icon: <Icon.Play size={12} />, tone: 'var(--mint)' },
  AGENT_MESSAGE: { icon: <Icon.Share size={12} />, tone: 'var(--lilac)' },
  AGENT_QUESTION: { icon: <Icon.Info size={12} />, tone: 'var(--amber)' },
  TASK_CREATED: { icon: <Icon.Plus size={12} />, tone: 'var(--ink-low)' },
  TASK_ASSIGNED: { icon: <Icon.Target size={12} />, tone: 'var(--sky)' },
  TASK_DELEGATED: { icon: <Icon.Arrow size={12} />, tone: 'var(--lilac)' },
  TASK_STARTED: { icon: <Icon.Play size={12} />, tone: 'var(--pulse)' },
  TASK_BLOCKED: { icon: <Icon.Warn size={12} />, tone: 'var(--amber)' },
  TASK_COMPLETED: { icon: <Icon.Check size={12} />, tone: 'var(--mint)' },
  TASK_FAILED: { icon: <Icon.X size={12} />, tone: 'var(--rose)' },
  TASK_CANCELLED: { icon: <Icon.X size={12} />, tone: 'var(--ink-faint)' },
  TASK_REVIEW_REQUESTED: { icon: <Icon.Flag size={12} />, tone: 'var(--amber)' },
  PLAN_CREATED: { icon: <Icon.Board size={12} />, tone: 'var(--iris-bright)' },
  USER_FEEDBACK: { icon: <Icon.Spark size={12} />, tone: 'var(--lilac)' },
  MEMORY_CREATED: { icon: <Icon.Memory size={12} />, tone: 'var(--sky)' },
  FILE_CREATED: { icon: <Icon.File size={12} />, tone: 'var(--mint)' },
  FILE_UPDATED: { icon: <Icon.File size={12} />, tone: 'var(--ink-low)' },
  TOOL_CALLED: { icon: <Icon.Tool size={12} />, tone: 'var(--ink-faint)' },
  TOOL_DENIED: { icon: <Icon.Lock size={12} />, tone: 'var(--rose)' },
  APPROVAL_REQUESTED: { icon: <Icon.Lock size={12} />, tone: 'var(--amber)' },
  APPROVAL_RESOLVED: { icon: <Icon.Check size={12} />, tone: 'var(--mint)' },
  OBJECTIVE_STARTED: { icon: <Icon.Target size={12} />, tone: 'var(--iris-bright)' },
  OBJECTIVE_COMPLETED: { icon: <Icon.Spark size={12} />, tone: 'var(--mint)' },
  SYSTEM_NOTICE: { icon: <Icon.Info size={12} />, tone: 'var(--ink-low)' },
};

/** One readable line per event. */
function describe(event: WorkspaceEvent, lookup: ReturnType<typeof useActorLookup>): ReactNode {
  const p = event.payload as Record<string, unknown>;
  const actor = event.actor.name ?? lookup(event.actor.id).name;
  const who = <b>{actor}</b>;
  const title = (p.task as { title?: string } | undefined)?.title;
  const nameOf = (id: unknown) => (typeof id === 'string' ? lookup(id).name : 'an agent');

  switch (event.type) {
    case 'USER_JOINED':
      return <>{who} joined</>;
    case 'USER_LEFT':
      return <>{who} left</>;

    case 'AGENT_CREATED':
      return (
        <>
          {who} added <b>{(p.agent as { name?: string }).name}</b> to the team
        </>
      );
    case 'AGENT_STARTED':
      return <>{who} started working</>;
    case 'AGENT_FINISHED': {
      const run = p.run as { status?: string; usage?: { toolCalls?: number } };
      return (
        <>
          {who} finished
          {run.usage?.toolCalls ? <span className="faint"> · {run.usage.toolCalls} tools</span> : null}
        </>
      );
    }
    case 'AGENT_ERROR':
      return (
        <>
          {who} hit an error — {clip(String(p.message), 90)}
        </>
      );
    case 'AGENT_CANCELLED':
      return <>{who} was stopped</>;
    case 'AGENT_PAUSED':
      return (
        <>
          {who} paused <b>{nameOf(p.agentId)}</b>
        </>
      );
    case 'AGENT_RESUMED':
      return (
        <>
          {who} resumed <b>{nameOf(p.agentId)}</b>
        </>
      );

    case 'AGENT_MESSAGE': {
      const m = p.message as { recipient?: { id: string } | null; body: string };
      return (
        <>
          {who}
          {m.recipient ? (
            <>
              {' → '}
              <b>{nameOf(m.recipient.id)}</b>
            </>
          ) : null}
          {': '}
          {clip(m.body, 100)}
        </>
      );
    }
    case 'AGENT_QUESTION':
      return <>{who} asked you: {clip((p.message as { body: string }).body, 100)}</>;

    case 'TASK_CREATED':
      return <>{who} created “{clip(title, 62)}”</>;
    case 'TASK_ASSIGNED':
      return (
        <>
          {who} assigned “{clip(title, 44)}” to <b>{(p.assignee as { name?: string })?.name}</b>
        </>
      );
    case 'TASK_DELEGATED': {
      const to = (p.task as { assignee?: { name?: string } }).assignee;
      return (
        <>
          {who} → <b>{to?.name ?? 'a teammate'}</b>: {clip(title, 58)}
        </>
      );
    }
    case 'TASK_STARTED':
      return <>Work started on “{clip(title, 62)}”</>;
    case 'TASK_BLOCKED':
      return <>“{clip(title, 44)}” blocked — {clip(String(p.reason), 60)}</>;
    case 'TASK_COMPLETED':
      return <>{who} completed “{clip(title, 62)}”</>;
    case 'TASK_FAILED':
      return <>“{clip(title, 40)}” failed — {clip(String(p.error), 60)}</>;
    case 'TASK_CANCELLED':
      return <>{who} cancelled “{clip(title, 62)}”</>;
    case 'TASK_REVIEW_REQUESTED':
      return <>“{clip(title, 58)}” needs your sign-off</>;

    case 'PLAN_CREATED':
      return <>{who} planned {(p.tasks as unknown[])?.length ?? 0} steps</>;

    case 'USER_FEEDBACK':
      return (
        <>
          {who} gave <b>{String(p.verdict)}</b> feedback
          {p.memoryId ? <span className="faint"> · stored in memory</span> : null}
        </>
      );

    case 'MEMORY_CREATED': {
      const r = p.record as { scope: string; title: string };
      return (
        <>
          {who} remembered <span className="faint">[{r.scope}]</span> {clip(r.title, 58)}
        </>
      );
    }

    case 'FILE_CREATED':
    case 'FILE_UPDATED':
      return (
        <>
          {who} {event.type === 'FILE_CREATED' ? 'wrote' : 'updated'}{' '}
          <span className="mono">{(p.file as { path: string }).path}</span>
        </>
      );

    case 'TOOL_CALLED':
      return (
        <>
          {who} <span className="mono faint">{String(p.toolName)}()</span>
        </>
      );
    case 'TOOL_DENIED':
      return (
        <>
          {who} denied <span className="mono">{String(p.toolName)}()</span> — {clip(String(p.reason), 60)}
        </>
      );

    case 'APPROVAL_REQUESTED':
      return (
        <>
          {who} needs permission for{' '}
          <span className="mono">{(p.approval as { action: string }).action}</span>
        </>
      );
    case 'APPROVAL_RESOLVED': {
      const a = p.approval as { status: string; action: string };
      return (
        <>
          {who} {a.status} <span className="mono">{a.action}</span>
        </>
      );
    }

    case 'OBJECTIVE_STARTED':
      return <>{who} started “{clip(String(p.title), 58)}”</>;
    case 'OBJECTIVE_COMPLETED':
      return <>Objective complete — “{clip(String(p.title), 56)}”</>;

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
