import { useCallback, useMemo, useRef, useState } from 'react';
import type { Agent, Task } from '@sup/shared';
import { api } from '../api/client.js';
import { useAction, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import {
  AgentFace,
  Button,
  ErrorNote,
  Icon,
  Meter,
  Spinner,
  durationText,
  isLive,
} from './primitives.js';

const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * Mission control.
 *
 * The objective is the product's core verb, so it gets the top of the room
 * rather than a text field buried in a toolbar. It has two faces:
 *
 *  - Idle: an invitation, with starter objectives that teach a first-time user
 *    what this thing is actually for in one read.
 *  - Running: a live mission card whose centrepiece is the delegation pipeline
 *    — one node per delegated task, in the real order the orchestrator created
 *    them, lighting up as each agent picks the work up. That single strip is
 *    the clearest statement the UI makes that a *team* is working, not a bot.
 *
 * Every value here is derived from server state. Nothing is simulated.
 */
export function MissionControl() {
  const workspace = useWorkspaceOrThrow();

  const live = useMemo(
    () =>
      workspace.tasks
        .filter((t) => t.id === t.objectiveId && !TERMINAL.includes(t.status))
        .sort((a, b) => b.createdAt - a.createdAt),
    [workspace.tasks],
  );

  const canStart = workspace.viewer.role !== 'viewer';

  return (
    <div className="mission">
      {live.map((objective) => (
        <Mission key={objective.id} objective={objective} />
      ))}
      {canStart ? <Launcher hasLive={live.length > 0} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ launcher */

const STARTERS = [
  'Build a competitor analysis for my startup',
  'Research the market for AI developer tools',
  'Draft a launch plan for our next release',
];

function Launcher({ hasLive }: { hasLive: boolean }) {
  const workspace = useWorkspaceOrThrow();
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const orchestrator = workspace.agents.find((a) => a.isOrchestrator && a.enabled && !a.paused);

  const start = useAction(async () => {
    await api.startObjective(workspace.workspace.id, {
      title: title.trim(),
      description: context.trim(),
    });
    setTitle('');
    setContext('');
    setOpen(false);
  });

  const submit = useCallback(() => {
    if (!title.trim() || start.pending || !orchestrator) return;
    void start.run();
  }, [title, start, orchestrator]);

  const useStarter = (text: string) => {
    setTitle(text);
    setOpen(true);
    inputRef.current?.focus();
  };

  // Once work is running, the launcher steps back so the mission card leads.
  const compact = hasLive && !open && !title;

  return (
    <div style={{ marginBottom: compact ? 4 : 10 }}>
      <div className="launch">
        <div className="launch__row">
          <Icon.Target size={15} className="faint" />
          <input
            ref={inputRef}
            className="launch__input"
            value={title}
            placeholder={
              orchestrator
                ? `Give ${orchestrator.name} an objective for the team…`
                : 'Add an orchestrator agent to run objectives'
            }
            disabled={!orchestrator || start.pending}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              if (e.key === 'Escape') {
                setOpen(false);
                e.currentTarget.blur();
              }
            }}
            aria-label="Objective"
          />
          <Button
            variant="primary"
            onClick={submit}
            disabled={!title.trim() || !orchestrator || start.pending}
          >
            {start.pending ? <Spinner /> : <Icon.Play size={12} />}
            Start
          </Button>
        </div>

        {open && !compact ? (
          <div className="launch__extra">
            <textarea
              className="textarea"
              style={{ minHeight: 58, fontSize: 12.5 }}
              value={context}
              placeholder="Optional: constraints, audience, what done looks like."
              onChange={(e) => setContext(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      {!hasLive && !title ? (
        <div className="launch__hints">
          <span className="faint" style={{ fontSize: 11, alignSelf: 'center', paddingRight: 2 }}>
            Try
          </span>
          {STARTERS.map((text) => (
            <button key={text} type="button" className="hint" onClick={() => useStarter(text)}>
              {text}
            </button>
          ))}
        </div>
      ) : null}

      <ErrorNote>{start.error}</ErrorNote>
    </div>
  );
}

/* ------------------------------------------------------------------- mission */

function Mission({ objective }: { objective: Task }) {
  const workspace = useWorkspaceOrThrow();
  const now = useTicker(1000);

  const steps = useMemo(
    () =>
      workspace.tasks
        .filter((t) => t.objectiveId === objective.id && t.id !== objective.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [workspace.tasks, objective.id],
  );

  const agentsById = useMemo(
    () => new Map(workspace.agents.map((a) => [a.id, a])),
    [workspace.agents],
  );

  const lead = objective.assignee ? agentsById.get(objective.assignee.id) : undefined;
  const done = steps.filter((s) => s.status === 'completed').length;
  const progress = steps.length === 0 ? 0 : done / steps.length;

  const cancel = useAction(async () => {
    await api.cancelObjective(workspace.workspace.id, objective.id);
  });

  const canStop = workspace.viewer.role !== 'viewer';

  // What the orchestrator itself is doing, when it has not yet delegated.
  const leadBusy = lead && isLive(lead);

  return (
    <div className="run">
      <div className="run__top">
        <div className="grow">
          <div className="run__label">Objective in progress</div>
          <div className="run__title">{objective.title}</div>
        </div>
        {canStop ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void cancel.run()}
            disabled={cancel.pending}
            title="Stop this objective and everything under it"
          >
            <Icon.Stop size={11} /> Stop
          </Button>
        ) : null}
      </div>

      <div className="pipe" role="list" aria-label="Delegation pipeline">
        {lead ? (
          <div className="stage-node" role="listitem">
            <div
              className="stage-node__chip"
              data-state={leadBusy ? 'active' : steps.length > 0 ? 'done' : 'pending'}
              title={`${lead.name} — ${lead.role}`}
            >
              <AgentFace agent={lead} size="xs" ring={false} />
              <span className="stage-node__name">{lead.name}</span>
            </div>
            {steps.length > 0 ? (
              <span className="stage-link" data-state="done" aria-hidden="true" />
            ) : null}
          </div>
        ) : null}

        {steps.length === 0 ? (
          <div className="stage-node" role="listitem">
            <div className="stage-node__chip" data-state="active">
              <span className="spin" />
              <span className="stage-node__name">Planning the work…</span>
            </div>
          </div>
        ) : null}

        {steps.map((step, i) => {
          const agent = step.assignee ? agentsById.get(step.assignee.id) : undefined;
          const state = stageState(step);
          const next = steps[i + 1];

          return (
            <div className="stage-node" key={step.id} role="listitem">
              <div
                className="stage-node__chip"
                data-state={state}
                title={`${step.assignee?.name ?? 'Unassigned'} — ${step.title}`}
              >
                {agent ? (
                  <AgentFace agent={agent} size="xs" ring={false} />
                ) : (
                  <span className="dot" style={{ ['--dot' as string]: 'var(--ink-faint)' }} />
                )}
                <span className="stage-node__name">{step.assignee?.name ?? 'Unassigned'}</span>
                {state === 'done' ? (
                  <Icon.Check size={10} className="stage-node__tick" />
                ) : state === 'failed' ? (
                  <Icon.X size={10} className="stage-node__tick" />
                ) : null}
              </div>

              {next ? (
                <span
                  className="stage-link"
                  data-state={
                    state === 'done' && stageState(next) !== 'pending'
                      ? 'done'
                      : state === 'active'
                        ? 'active'
                        : 'idle'
                  }
                  aria-hidden="true"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="run__foot">
        <Icon.Clock size={11} />
        <span>{durationText(now - objective.createdAt)}</span>
        <Meter value={progress} />
        <span style={{ minWidth: 34, textAlign: 'right' }}>
          {steps.length > 0 ? `${done}/${steps.length}` : '—'}
        </span>
      </div>

      <ErrorNote>{cancel.error}</ErrorNote>
    </div>
  );
}

function stageState(task: Task): 'done' | 'active' | 'failed' | 'pending' {
  if (task.status === 'completed') return 'done';
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
  if (task.status === 'in_progress') return 'active';
  return 'pending';
}

export type { Agent };
