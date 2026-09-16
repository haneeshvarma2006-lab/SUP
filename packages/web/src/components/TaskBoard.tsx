import { useMemo, useState } from 'react';
import { TASK_STATUSES, type Task, type TaskStatus } from '@sup/shared';
import { api } from '../api/client.js';
import { useAction, useActorLookup, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import {
  Avatar,
  Badge,
  Empty,
  ErrorText,
  PanelHeader,
  TASK_STATUS_COLOR,
  TASK_STATUS_LABEL,
  relativeTime,
} from './primitives.js';

/** Columns shown on the board, in flow order. Terminal states collapse right. */
const COLUMNS: TaskStatus[] = [
  'backlog',
  'assigned',
  'in_progress',
  'blocked',
  'awaiting_approval',
  'completed',
];

/**
 * The task board.
 *
 * Ownership and progress are the two things it has to make obvious, so every
 * card shows its assignee's avatar and colour-codes its left edge by state.
 * Cards move between columns purely from server events — there is no local
 * optimistic shuffling that could disagree with the backend.
 */
export function TaskBoard({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(20_000);
  const [objectiveFilter, setObjectiveFilter] = useState<string>('all');

  const objectives = useMemo(() => {
    const roots = workspace.tasks.filter((t) => t.id === t.objectiveId);
    return roots.sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  }, [workspace.tasks]);

  const tasks = useMemo(
    () =>
      objectiveFilter === 'all'
        ? workspace.tasks
        : workspace.tasks.filter((t) => t.objectiveId === objectiveFilter),
    [workspace.tasks, objectiveFilter],
  );

  const byStatus = useMemo(() => {
    const groups = new Map<TaskStatus, Task[]>();
    for (const status of TASK_STATUSES) groups.set(status, []);
    for (const task of tasks) groups.get(task.status)?.push(task);
    for (const list of groups.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return groups;
  }, [tasks]);

  // Only show columns that hold something, plus the always-useful ones, so a
  // quiet board is not mostly empty columns.
  const visibleColumns = COLUMNS.filter(
    (status) =>
      (byStatus.get(status)?.length ?? 0) > 0 ||
      status === 'in_progress' ||
      status === 'assigned' ||
      status === 'completed',
  );

  const failedOrCancelled = [
    ...(byStatus.get('failed') ?? []),
    ...(byStatus.get('cancelled') ?? []),
  ];

  return (
    <>
      <PanelHeader title="Tasks" count={tasks.length}>
        <select
          className="select"
          style={{ width: 'auto', padding: '2px 8px', fontSize: 11.5 }}
          value={objectiveFilter}
          onChange={(e) => setObjectiveFilter(e.target.value)}
          aria-label="Filter by objective"
        >
          <option value="all">All objectives</option>
          {objectives.map((objective) => (
            <option key={objective.id} value={objective.id}>
              {objective.title.slice(0, 40)}
            </option>
          ))}
        </select>
      </PanelHeader>

      <div className="column-scroll">
        {tasks.length === 0 ? (
          <Empty icon="🗂">No tasks yet. Start an objective and the orchestrator will create some.</Empty>
        ) : (
          <div className="board">
            {visibleColumns.map((status) => (
              <BoardColumn
                key={status}
                status={status}
                tasks={byStatus.get(status) ?? []}
                lookup={lookup}
                now={now}
                onOpenTask={onOpenTask}
              />
            ))}

            {failedOrCancelled.length > 0 ? (
              <BoardColumn
                status="failed"
                label={`Failed / cancelled`}
                tasks={failedOrCancelled}
                lookup={lookup}
                now={now}
                onOpenTask={onOpenTask}
              />
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

function BoardColumn({
  status,
  label,
  tasks,
  lookup,
  now,
  onOpenTask,
}: {
  status: TaskStatus;
  label?: string;
  tasks: Task[];
  lookup: ReturnType<typeof useActorLookup>;
  now: number;
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <div className="board-column">
      <div className="board-column-head">
        <span
          className="status-dot"
          style={{ ['--status-color' as string]: TASK_STATUS_COLOR[status] }}
        />
        <span>{label ?? TASK_STATUS_LABEL[status]}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{tasks.length}</span>
      </div>
      <div className="board-column-body">
        {tasks.length === 0 ? (
          <div className="dim" style={{ fontSize: 11.5, padding: '8px 4px', textAlign: 'center' }}>
            Empty
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              lookup={lookup}
              now={now}
              onOpen={() => onOpenTask(task.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  lookup,
  now,
  onOpen,
}: {
  task: Task;
  lookup: ReturnType<typeof useActorLookup>;
  now: number;
  onOpen: () => void;
}) {
  const assignee = task.assignee ? lookup(task.assignee.id) : null;
  const running = task.status === 'in_progress';

  return (
    <button
      type="button"
      className={`task-card${running ? ' running' : ''}`}
      style={{ ['--task-accent' as string]: TASK_STATUS_COLOR[task.status] }}
      onClick={onOpen}
    >
      <div className="task-title">{task.title}</div>
      <div className="task-foot">
        {assignee ? (
          <Avatar
            name={assignee.name}
            color={assignee.color}
            emoji={assignee.emoji}
            kind={assignee.kind}
            size="sm"
          />
        ) : (
          <span className="dim">Unassigned</span>
        )}
        {task.dependsOn.length > 0 ? (
          <Badge title={`Waiting on ${task.dependsOn.length} task(s)`}>
            ⛓ {task.dependsOn.length}
          </Badge>
        ) : null}
        {task.priority === 'urgent' || task.priority === 'high' ? (
          <Badge tone={task.priority === 'urgent' ? 'danger' : 'warn'}>{task.priority}</Badge>
        ) : null}
        <span style={{ marginLeft: 'auto' }} className="dim">
          {relativeTime(task.updatedAt, now)}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------

/**
 * Task detail, shown when a card is opened. Everything a human needs to judge
 * and intervene: who did it, what came out, and the approve/reject controls.
 */
export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const task = workspace.tasks.find((t) => t.id === taskId);

  const [note, setNote] = useState('');

  const cancel = useAction(async () => {
    await api.cancelTask(taskId);
  });
  const decide = useAction(async (approved: boolean) => {
    await api.approveTask(taskId, approved, note);
    setNote('');
  });
  const feedback = useAction(async (verdict: 'approve' | 'reject' | 'correct') => {
    await api.giveFeedback(workspace.workspace.id, {
      verdict,
      comment: note,
      taskId,
      agentId: task?.assignee?.type === 'agent' ? task.assignee.id : undefined,
    });
    setNote('');
  });

  if (!task) {
    return (
      <div className="inspector">
        <PanelHeader title="Task">
          <button type="button" className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </PanelHeader>
        <Empty>That task is no longer in view.</Empty>
      </div>
    );
  }

  const assignee = task.assignee ? lookup(task.assignee.id) : null;
  const children = workspace.tasks.filter((t) => t.parentTaskId === task.id);
  const artifacts = workspace.files.filter((f) => task.artifactIds.includes(f.id));
  const canAct = workspace.viewer.role !== 'viewer';

  return (
    <div className="inspector">
      <PanelHeader title="Task">
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </PanelHeader>

      <div className="column-scroll">
        <div className="pad">
          <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.35, marginBottom: 8 }}>
            {task.title}
          </div>

          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
            <Badge tone={task.status === 'completed' ? 'ok' : task.status === 'failed' ? 'danger' : 'accent'}>
              {TASK_STATUS_LABEL[task.status]}
            </Badge>
            <Badge>{task.priority}</Badge>
            {assignee ? (
              <span className="row" style={{ gap: 5 }}>
                <Avatar
                  name={assignee.name}
                  color={assignee.color}
                  emoji={assignee.emoji}
                  kind={assignee.kind}
                  size="sm"
                />
                <span style={{ fontSize: 12.5 }}>{assignee.name}</span>
              </span>
            ) : null}
          </div>

          {task.description ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="dim" style={{ fontSize: 10.5, textTransform: 'uppercase', marginBottom: 4 }}>
                Brief
              </div>
              <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{task.description}</div>
            </div>
          ) : null}

          {task.dependsOn.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <div className="dim" style={{ fontSize: 10.5, textTransform: 'uppercase', marginBottom: 4 }}>
                Depends on
              </div>
              {task.dependsOn.map((depId) => {
                const dep = workspace.tasks.find((t) => t.id === depId);
                return (
                  <div key={depId} className="row" style={{ fontSize: 12, padding: '2px 0' }}>
                    <span
                      className="status-dot"
                      style={{
                        ['--status-color' as string]: dep
                          ? TASK_STATUS_COLOR[dep.status]
                          : 'var(--text-dim)',
                      }}
                    />
                    <span className="truncate">{dep?.title ?? depId}</span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {task.result ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="dim" style={{ fontSize: 10.5, textTransform: 'uppercase', marginBottom: 4 }}>
                Result
              </div>
              <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', maxHeight: 340, overflowY: 'auto' }}>
                {task.result}
              </div>
            </div>
          ) : null}

          {task.error ? (
            <div className="card" style={{ marginBottom: 12, borderColor: 'var(--danger)' }}>
              <div style={{ fontSize: 10.5, textTransform: 'uppercase', color: 'var(--danger)' }}>
                Error
              </div>
              <div style={{ fontSize: 12.5 }}>{task.error}</div>
            </div>
          ) : null}

          {artifacts.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <div className="dim" style={{ fontSize: 10.5, textTransform: 'uppercase', marginBottom: 4 }}>
                Artifacts
              </div>
              {artifacts.map((file) => (
                <div key={file.id} className="mono" style={{ padding: '2px 0' }}>
                  ▣ {file.path} · {file.size}B · v{file.version}
                </div>
              ))}
            </div>
          ) : null}

          {children.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              <div className="dim" style={{ fontSize: 10.5, textTransform: 'uppercase', marginBottom: 4 }}>
                Sub-tasks ({children.length})
              </div>
              {children.map((child) => (
                <div key={child.id} className="row" style={{ fontSize: 12, padding: '3px 0' }}>
                  <span
                    className="status-dot"
                    style={{ ['--status-color' as string]: TASK_STATUS_COLOR[child.status] }}
                  />
                  <span className="truncate">{child.title}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {canAct ? (
          <div className="pad" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="field">
              <label htmlFor="task-note">Feedback for the agent</label>
              <textarea
                id="task-note"
                className="textarea"
                value={note}
                placeholder="What was right or wrong about this? Corrections are stored in project memory and reach this agent on its next task."
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              {task.status === 'awaiting_approval' ? (
                <>
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={() => void decide.run(true)}
                    disabled={decide.pending}
                  >
                    Approve result
                  </button>
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() => void decide.run(false)}
                    disabled={decide.pending}
                  >
                    Send back
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void feedback.run('approve')}
                    disabled={feedback.pending}
                  >
                    👍 Good
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void feedback.run('correct')}
                    disabled={feedback.pending || !note.trim()}
                    title={!note.trim() ? 'Describe the correction first' : undefined}
                  >
                    ✎ Correct
                  </button>
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() => void feedback.run('reject')}
                    disabled={feedback.pending}
                  >
                    👎 Reject
                  </button>
                </>
              )}

              {!['completed', 'failed', 'cancelled'].includes(task.status) ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void cancel.run()}
                  disabled={cancel.pending}
                >
                  Cancel task
                </button>
              ) : null}
            </div>

            <ErrorText>{decide.error ?? feedback.error ?? cancel.error}</ErrorText>
          </div>
        ) : null}
      </div>
    </div>
  );
}
