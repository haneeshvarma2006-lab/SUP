import { useMemo, useState } from 'react';
import { TASK_STATUSES, type Task, type TaskStatus } from '@sup/shared';
import { api } from '../api/client.js';
import { useAction, useActorLookup, useTicker, useWorkspaceOrThrow } from '../state/hooks.js';
import { Markdown } from './Markdown.js';
import {
  Avatar,
  Button,
  Dot,
  Empty,
  ErrorNote,
  Icon,
  TASK_LABEL,
  TASK_TONE,
  Tag,
  relTime,
  taskTone,
} from './primitives.js';

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];

/** Lanes in flow order. Failed and cancelled collapse into one trailing lane. */
const LANES: TaskStatus[] = [
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
 * Ownership and progress are the two things it has to make obvious without
 * being read, so every card carries its assignee's face and a left edge
 * coloured by state. A running card gets the reserved live treatment; nothing
 * else does.
 */
export function TaskBoard({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(15_000);
  const [scope, setScope] = useState('all');

  const objectives = useMemo(
    () =>
      workspace.tasks
        .filter((t) => t.id === t.objectiveId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 14),
    [workspace.tasks],
  );

  const tasks = useMemo(
    () => (scope === 'all' ? workspace.tasks : workspace.tasks.filter((t) => t.objectiveId === scope)),
    [workspace.tasks, scope],
  );

  const lanes = useMemo(() => {
    const groups = new Map<TaskStatus, Task[]>();
    for (const status of TASK_STATUSES) groups.set(status, []);
    for (const task of tasks) groups.get(task.status)?.push(task);
    for (const list of groups.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return groups;
  }, [tasks]);

  const stopped = [...(lanes.get('failed') ?? []), ...(lanes.get('cancelled') ?? [])];

  // Only render a lane that holds something, plus the three that frame the flow
  // — a board of empty columns communicates nothing.
  const visible = LANES.filter(
    (s) =>
      (lanes.get(s)?.length ?? 0) > 0 || s === 'assigned' || s === 'in_progress' || s === 'completed',
  );

  if (tasks.length === 0) {
    return (
      <div className="scroll">
        <Empty icon={<Icon.Board size={17} />} title="No tasks yet">
          Start an objective and the orchestrator will break it into tasks here.
        </Empty>
      </div>
    );
  }

  return (
    <>
      {objectives.length > 1 ? (
        <div className="row" style={{ padding: '9px 12px 0' }}>
          <select
            className="select"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Filter by objective"
            style={{ fontSize: 12 }}
          >
            <option value="all">All objectives</option>
            {objectives.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title.slice(0, 46)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="scroll">
        <div className="board">
          {visible.map((status) => (
            <Lane
              key={status}
              label={TASK_LABEL[status]}
              tone={TASK_TONE[status]}
              tasks={lanes.get(status) ?? []}
              lookup={lookup}
              now={now}
              onOpen={onOpenTask}
            />
          ))}
          {stopped.length > 0 ? (
            <Lane
              label="Stopped"
              tone="var(--rose)"
              tasks={stopped}
              lookup={lookup}
              now={now}
              onOpen={onOpenTask}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function Lane({
  label,
  tone,
  tasks,
  lookup,
  now,
  onOpen,
}: {
  label: string;
  tone: string;
  tasks: Task[];
  lookup: ReturnType<typeof useActorLookup>;
  now: number;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="lane">
      <div className="lane__head">
        <Dot tone={tone} />
        <span>{label}</span>
        <span className="lane__n">{tasks.length}</span>
      </div>
      <div className="lane__body">
        {tasks.length === 0 ? (
          <div className="faint" style={{ fontSize: 11, textAlign: 'center', padding: '10px 0' }}>
            Empty
          </div>
        ) : (
          tasks.map((task) => {
            const who = task.assignee ? lookup(task.assignee.id) : null;
            return (
              <button
                key={task.id}
                type="button"
                className="tcard"
                data-live={task.status === 'in_progress'}
                style={{ ['--edge' as string]: TASK_TONE[task.status] }}
                onClick={() => onOpen(task.id)}
              >
                <div className="tcard__title">{task.title}</div>
                <div className="tcard__foot">
                  {who ? (
                    <Avatar
                      name={who.name}
                      tint={who.color}
                      emoji={who.emoji}
                      kind={who.kind}
                      size="xs"
                    />
                  ) : (
                    <span className="faint">Unassigned</span>
                  )}
                  {task.dependsOn.length > 0 ? (
                    <span title={`Waiting on ${task.dependsOn.length} task(s)`}>
                      <Icon.Link size={10} />
                    </span>
                  ) : null}
                  {task.priority === 'urgent' || task.priority === 'high' ? (
                    <Tag tone={task.priority === 'urgent' ? 'rose' : 'amber'}>{task.priority}</Tag>
                  ) : null}
                  <span className="grow" style={{ textAlign: 'right' }}>
                    {relTime(task.updatedAt, now)}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ task detail */

/**
 * Task detail.
 *
 * This is where a human judges and intervenes, so the controls that matter —
 * approve, correct, reject, cancel — sit at the bottom under the result rather
 * than being hidden behind a menu.
 */
export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const workspace = useWorkspaceOrThrow();
  const lookup = useActorLookup();
  const now = useTicker(15_000);
  const task = workspace.tasks.find((t) => t.id === taskId);
  const [note, setNote] = useState('');

  const cancel = useAction(async () => {
    await api.cancelTask(taskId);
  });

  const signOff = useAction(async (approved: boolean) => {
    await api.approveTask(taskId, approved, note);
    setNote('');
  });

  const feedback = useAction(async (verdict: 'approve' | 'reject' | 'correct') => {
    await api.giveFeedback(workspace.workspace.id, {
      verdict,
      comment: note,
      taskId,
      ...(task?.assignee?.type === 'agent' ? { agentId: task.assignee.id } : {}),
    });
    setNote('');
  });

  if (!task) {
    return (
      <aside className="inspector" data-shown="true">
        <div className="inspector__head">
          <span className="grow" style={{ fontWeight: 620 }}>
            Task
          </span>
          <Button variant="quiet" size="sm" onClick={onClose}>
            <Icon.X size={12} />
          </Button>
        </div>
        <Empty>That task is no longer in view.</Empty>
      </aside>
    );
  }

  const who = task.assignee ? lookup(task.assignee.id) : null;
  const children = workspace.tasks.filter((t) => t.parentTaskId === task.id);
  const artifacts = workspace.files.filter((f) => task.artifactIds.includes(f.id));
  const canAct = workspace.viewer.role !== 'viewer';
  const open = !TERMINAL.includes(task.status);

  return (
    <aside className="inspector" data-shown="true" aria-label="Task detail">
      <div className="inspector__head">
        <Icon.Board size={13} className="faint" />
        <span className="grow" style={{ fontWeight: 620, fontSize: 12.5 }}>
          Task
        </span>
        <Button variant="quiet" size="sm" onClick={onClose} ariaLabel="Close">
          <Icon.X size={12} />
        </Button>
      </div>

      <div className="scroll">
        <div className="pad">
          <div style={{ fontSize: 15, fontWeight: 640, lineHeight: 1.4, letterSpacing: '-0.016em' }}>
            {task.title}
          </div>

          <div className="row" style={{ flexWrap: 'wrap', margin: '10px 0 14px' }}>
            <Tag tone={taskTone(task.status)}>{TASK_LABEL[task.status]}</Tag>
            {task.priority !== 'normal' ? <Tag>{task.priority}</Tag> : null}
            {who ? (
              <span className="row" style={{ gap: 5 }}>
                <Avatar name={who.name} tint={who.color} emoji={who.emoji} kind={who.kind} size="xs" />
                <span style={{ fontSize: 12 }}>{who.name}</span>
              </span>
            ) : null}
            <span className="faint grow" style={{ textAlign: 'right', fontSize: 11 }}>
              {relTime(task.updatedAt, now)}
            </span>
          </div>

          {task.description ? (
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
                Brief
              </div>
              <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', color: 'var(--ink-mid)' }}>
                {task.description}
              </div>
            </div>
          ) : null}

          {task.dependsOn.length > 0 ? (
            <div style={{ marginBottom: 11 }}>
              <div className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
                Depends on
              </div>
              {task.dependsOn.map((id) => {
                const dep = workspace.tasks.find((t) => t.id === id);
                return (
                  <div key={id} className="row" style={{ fontSize: 12, padding: '3px 0' }}>
                    <Dot tone={dep ? TASK_TONE[dep.status] : 'var(--ink-faint)'} />
                    <span className="trunc">{dep?.title ?? id}</span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {task.result ? (
            <div className="card" style={{ marginBottom: 11 }}>
              <div className="row" style={{ marginBottom: 7 }}>
                <Icon.Check size={11} style={{ color: 'var(--mint)' }} />
                <span className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Result
                </span>
              </div>
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                <Markdown text={task.result} />
              </div>
            </div>
          ) : null}

          {task.error ? (
            <div
              className="card"
              style={{ marginBottom: 11, borderColor: 'var(--rose-line)', background: 'var(--rose-soft)' }}
            >
              <div className="row" style={{ marginBottom: 4, color: 'var(--rose)' }}>
                <Icon.Warn size={11} />
                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 620 }}>
                  {task.status === 'cancelled' ? 'Stopped' : 'Failed'}
                </span>
              </div>
              <div style={{ fontSize: 12.5 }}>{task.error}</div>
            </div>
          ) : null}

          {artifacts.length > 0 ? (
            <div style={{ marginBottom: 11 }}>
              <div className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
                Artifacts
              </div>
              {artifacts.map((f) => (
                <div key={f.id} className="row mono" style={{ padding: '2px 0' }}>
                  <Icon.File size={11} className="faint" />
                  {f.path}
                  <span className="faint">v{f.version}</span>
                </div>
              ))}
            </div>
          ) : null}

          {children.length > 0 ? (
            <div>
              <div className="faint" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>
                Sub-tasks ({children.length})
              </div>
              {children.map((child) => (
                <div key={child.id} className="row" style={{ fontSize: 12, padding: '3px 0' }}>
                  <Dot tone={TASK_TONE[child.status]} />
                  <span className="trunc">{child.title}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {canAct ? (
          <div className="pad" style={{ borderTop: '1px solid var(--hairline)' }}>
            <div className="field">
              <label htmlFor="task-note">Feedback</label>
              <textarea
                id="task-note"
                className="textarea"
                style={{ minHeight: 62 }}
                value={note}
                placeholder="What was right or wrong? Corrections are stored in project memory and reach this agent on its next task."
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            <div className="row" style={{ flexWrap: 'wrap' }}>
              {task.status === 'awaiting_approval' ? (
                <>
                  <Button variant="ok" size="sm" onClick={() => void signOff.run(true)} disabled={signOff.pending}>
                    <Icon.Check size={11} /> Approve
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => void signOff.run(false)} disabled={signOff.pending}>
                    Send back
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" onClick={() => void feedback.run('approve')} disabled={feedback.pending}>
                    <Icon.Check size={11} /> Good
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void feedback.run('correct')}
                    disabled={feedback.pending || !note.trim()}
                    title={!note.trim() ? 'Describe the correction first' : 'Store this correction in memory'}
                  >
                    <Icon.Edit size={11} /> Correct
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => void feedback.run('reject')} disabled={feedback.pending}>
                    Reject
                  </Button>
                </>
              )}

              {open ? (
                <Button
                  variant="quiet"
                  size="sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void cancel.run()}
                  disabled={cancel.pending}
                >
                  Cancel task
                </Button>
              ) : null}
            </div>

            <ErrorNote>{signOff.error ?? feedback.error ?? cancel.error}</ErrorNote>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
