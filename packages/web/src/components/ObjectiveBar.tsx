import { useMemo, useState } from 'react';
import type { ApprovalRequest, Task } from '@sup/shared';
import { api } from '../api/client.js';
import { useAction, useActorLookup, useWorkspaceOrThrow } from '../state/hooks.js';
import { Badge, ErrorText, Spinner } from './primitives.js';

/**
 * The objective launcher.
 *
 * This is the primary call to action: a human states what they want, and the
 * orchestrator plans it and puts the team on it. Live objectives show inline
 * with their progress so the human can see the team working and stop it.
 */
export function ObjectiveBar() {
  const workspace = useWorkspaceOrThrow();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [expanded, setExpanded] = useState(false);

  const start = useAction(async () => {
    await api.startObjective(workspace.workspace.id, { title: title.trim(), description });
    setTitle('');
    setDescription('');
    setExpanded(false);
  });

  const live = useMemo(() => {
    return workspace.tasks
      .filter((t) => t.id === t.objectiveId && !['completed', 'failed', 'cancelled'].includes(t.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [workspace.tasks]);

  const orchestrator = workspace.agents.find((a) => a.isOrchestrator);
  const canStart = workspace.viewer.role !== 'viewer';

  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
      {live.map((objective) => (
        <LiveObjective key={objective.id} objective={objective} />
      ))}

      {canStart ? (
        <div className="pad" style={{ paddingTop: live.length > 0 ? 10 : 14 }}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <input
              className="input"
              value={title}
              placeholder={
                orchestrator
                  ? `Tell ${orchestrator.name} what the team should build…`
                  : 'Add an orchestrator agent to start objectives'
              }
              disabled={!orchestrator || start.pending}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={() => setExpanded(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && title.trim()) {
                  e.preventDefault();
                  void start.run();
                }
              }}
            />
            <button
              type="button"
              className="btn primary"
              onClick={() => void start.run()}
              disabled={!title.trim() || !orchestrator || start.pending}
            >
              {start.pending ? <Spinner /> : 'Start'}
            </button>
          </div>

          {expanded ? (
            <textarea
              className="textarea"
              style={{ marginTop: 8, minHeight: 60 }}
              value={description}
              placeholder="Any context that matters: constraints, audience, what done looks like."
              onChange={(e) => setDescription(e.target.value)}
            />
          ) : null}

          <ErrorText>{start.error}</ErrorText>
        </div>
      ) : null}
    </div>
  );
}

function LiveObjective({ objective }: { objective: Task }) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();

  const children = useMemo(
    () => workspace.tasks.filter((t) => t.objectiveId === objective.id && t.id !== objective.id),
    [workspace.tasks, objective.id],
  );

  const done = children.filter((t) => t.status === 'completed').length;
  const progress = children.length === 0 ? 0 : Math.round((done / children.length) * 100);

  const cancel = useAction(async () => {
    await api.cancelObjective(workspace.workspace.id, objective.id);
  });

  const workingNow = workspace.agents.filter(
    (a) => a.currentTaskId && children.some((t) => t.id === a.currentTaskId),
  );

  return (
    <div
      className="pad"
      style={{
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(90deg, var(--accent-soft), transparent)',
      }}
    >
      <div className="row">
        <Badge tone="accent">objective</Badge>
        <span style={{ fontWeight: 650, fontSize: 13 }} className="truncate">
          {objective.title}
        </span>
        <span style={{ marginLeft: 'auto' }} className="row">
          {workingNow.map((agent) => (
            <span key={agent.id} title={`${agent.name}: ${agent.statusDetail || agent.status}`}>
              {agent.avatarEmoji}
            </span>
          ))}
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void cancel.run()}
            disabled={cancel.pending}
          >
            Stop
          </button>
        </span>
      </div>

      <div className="row" style={{ marginTop: 6, gap: 10 }}>
        <div className="relevance-bar" style={{ flex: 1, height: 4 }}>
          <div className="relevance-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="dim mono" style={{ fontSize: 11 }}>
          {done}/{children.length || '—'}
        </span>
      </div>

      <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>
        {workingNow.length > 0
          ? workingNow
              .map((a) => `${a.name} is ${a.statusDetail || a.status}`)
              .join(' · ')
          : children.length === 0
            ? `${lookup(objective.assignee?.id ?? '').name} is planning the work…`
            : 'Waiting on the next step'}
      </div>

      <ErrorText>{cancel.error}</ErrorText>
    </div>
  );
}

/**
 * Pending approval requests.
 *
 * Sensitive tools block on a human decision, and the requesting agent is
 * genuinely suspended until this is answered — so it sits above everything as a
 * bar, not buried in a notification list.
 */
export function ApprovalBar() {
  const workspace = useWorkspaceOrThrow();
  const pending = workspace.approvals;

  if (pending.length === 0) return null;
  if (workspace.viewer.role === 'viewer') return null;

  return (
    <>
      {pending.map((approval) => (
        <ApprovalRow key={approval.id} approval={approval} />
      ))}
    </>
  );
}

function ApprovalRow({ approval }: { approval: ApprovalRequest }) {
  const lookup = useActorLookup();
  const requester = lookup(approval.requestedBy.id);
  const [showPayload, setShowPayload] = useState(false);

  const decide = useAction(async (approved: boolean) => {
    await api.resolveApproval(approval.id, approved);
  });

  return (
    <div className="approval-bar">
      <span style={{ fontSize: 16 }}>🔐</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          <span style={{ color: requester.color }}>{requester.name}</span> is waiting on you:{' '}
          <span className="mono">{approval.action}</span>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {approval.reason}
        </div>
        {showPayload ? (
          <pre
            className="mono"
            style={{
              marginTop: 6,
              maxHeight: 160,
              overflow: 'auto',
              background: 'var(--surface-2)',
              padding: 8,
              borderRadius: 6,
            }}
          >
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        ) : null}
      </div>
      <button type="button" className="btn ghost sm" onClick={() => setShowPayload((v) => !v)}>
        {showPayload ? 'Hide' : 'Inspect'}
      </button>
      <button
        type="button"
        className="btn danger sm"
        onClick={() => void decide.run(false)}
        disabled={decide.pending}
      >
        Deny
      </button>
      <button
        type="button"
        className="btn primary sm"
        onClick={() => void decide.run(true)}
        disabled={decide.pending}
      >
        Allow
      </button>
    </div>
  );
}
