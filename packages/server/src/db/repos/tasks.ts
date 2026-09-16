import type { ActorRef, Task, TaskPriority, TaskStatus } from '@sup/shared';
import { TERMINAL_TASK_STATUSES } from '@sup/shared';
import { fromBool, fromJson, toBool, toJson, type Db, type DbHandle } from '../index.js';

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  created_by: string;
  assignee: string | null;
  parent_task_id: string | null;
  objective_id: string;
  depends_on: string;
  depth: number;
  result: string | null;
  result_data: string | null;
  error: string | null;
  artifact_ids: string;
  version: number;
  locked_by: string | null;
  lock_expires_at: number | null;
  requires_human_approval: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdBy: fromJson<ActorRef>(row.created_by, { type: 'system', id: 'system' }),
    assignee: fromJson<ActorRef | null>(row.assignee, null),
    parentTaskId: row.parent_task_id,
    objectiveId: row.objective_id,
    dependsOn: fromJson<string[]>(row.depends_on, []),
    depth: row.depth,
    result: row.result,
    resultData: fromJson<unknown>(row.result_data, null),
    error: row.error,
    artifactIds: fromJson<string[]>(row.artifact_ids, []),
    version: row.version,
    lockedBy: row.locked_by,
    lockExpiresAt: row.lock_expires_at,
    requiresHumanApproval: toBool(row.requires_human_approval),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** Raised when a compare-and-swap update loses the race. */
export class VersionConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Task ${taskId} changed underneath this update (expected v${expectedVersion}, found v${actualVersion})`,
    );
    this.name = 'VersionConflictError';
  }
}

export class TaskRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(task: Task): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, workspace_id, title, description, status, priority, created_by, assignee,
           parent_task_id, objective_id, depends_on, depth, result, result_data, error,
           artifact_ids, version, locked_by, lock_expires_at, requires_human_approval,
           created_at, updated_at, started_at, completed_at
         ) VALUES (
           @id, @workspaceId, @title, @description, @status, @priority, @createdBy, @assignee,
           @parentTaskId, @objectiveId, @dependsOn, @depth, @result, @resultData, @error,
           @artifactIds, @version, @lockedBy, @lockExpiresAt, @requiresHumanApproval,
           @createdAt, @updatedAt, @startedAt, @completedAt
         )`,
      )
      .run({
        ...task,
        createdBy: toJson(task.createdBy),
        assignee: task.assignee ? toJson(task.assignee) : null,
        dependsOn: toJson(task.dependsOn),
        resultData: toJson(task.resultData),
        artifactIds: toJson(task.artifactIds),
        requiresHumanApproval: fromBool(task.requiresHumanApproval),
      });
    return task;
  }

  byId(id: string): Task | null {
    const row = this.db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? mapTask(row) : null;
  }

  byIds(ids: string[]): Task[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare<string[], TaskRow>(`SELECT * FROM tasks WHERE id IN (${placeholders})`)
      .all(...ids)
      .map(mapTask);
  }

  listForWorkspace(workspaceId: string, limit = 500): Task[] {
    return this.db
      .prepare<[string, number], TaskRow>(
        'SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(workspaceId, limit)
      .map(mapTask);
  }

  listForObjective(objectiveId: string): Task[] {
    return this.db
      .prepare<[string], TaskRow>('SELECT * FROM tasks WHERE objective_id = ? ORDER BY created_at')
      .all(objectiveId)
      .map(mapTask);
  }

  listChildren(parentTaskId: string): Task[] {
    return this.db
      .prepare<[string], TaskRow>('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at')
      .all(parentTaskId)
      .map(mapTask);
  }

  /**
   * Compare-and-swap update. The WHERE clause pins the version we read, so two
   * concurrent writers cannot both succeed — the loser gets a VersionConflict
   * and re-reads rather than silently overwriting.
   */
  update(id: string, expectedVersion: number, patch: Partial<Task>): Task {
    const current = this.byId(id);
    if (!current) throw new Error(`Task ${id} not found`);
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(id, expectedVersion, current.version);
    }

    const next: Task = {
      ...current,
      ...patch,
      id: current.id,
      workspaceId: current.workspaceId,
      version: current.version + 1,
      updatedAt: Date.now(),
    };

    const info = this.db
      .prepare(
        `UPDATE tasks SET
           title = @title, description = @description, status = @status, priority = @priority,
           assignee = @assignee, depends_on = @dependsOn, result = @result, result_data = @resultData,
           error = @error, artifact_ids = @artifactIds, version = @version, locked_by = @lockedBy,
           lock_expires_at = @lockExpiresAt, requires_human_approval = @requiresHumanApproval,
           updated_at = @updatedAt, started_at = @startedAt, completed_at = @completedAt
         WHERE id = @id AND version = @expectedVersion`,
      )
      .run({
        ...next,
        assignee: next.assignee ? toJson(next.assignee) : null,
        dependsOn: toJson(next.dependsOn),
        resultData: toJson(next.resultData),
        artifactIds: toJson(next.artifactIds),
        requiresHumanApproval: fromBool(next.requiresHumanApproval),
        expectedVersion,
      });

    if (info.changes === 0) {
      const reread = this.byId(id);
      throw new VersionConflictError(id, expectedVersion, reread?.version ?? -1);
    }
    return next;
  }

  /**
   * Atomically claims a task for execution. Succeeds only if the task is
   * unlocked or its lock has expired, and only if the status is still one that
   * may start. Returns the claimed task or null if someone else won.
   */
  claim(id: string, holder: string, now: number, ttlMs: number): Task | null {
    const info = this.db
      .prepare(
        `UPDATE tasks
            SET locked_by = @holder,
                lock_expires_at = @expiresAt,
                status = 'in_progress',
                started_at = COALESCE(started_at, @now),
                version = version + 1,
                updated_at = @now
          WHERE id = @id
            AND status IN ('backlog','assigned','blocked')
            AND (locked_by IS NULL OR lock_expires_at IS NULL OR lock_expires_at < @now)`,
      )
      .run({ id, holder, now, expiresAt: now + ttlMs });

    return info.changes > 0 ? this.byId(id) : null;
  }

  /** Extends a held lock. Returns false if the lock was lost or stolen. */
  renewLock(id: string, holder: string, now: number, ttlMs: number): boolean {
    return (
      this.db
        .prepare(
          'UPDATE tasks SET lock_expires_at = ? WHERE id = ? AND locked_by = ?',
        )
        .run(now + ttlMs, id, holder).changes > 0
    );
  }

  releaseLock(id: string, holder: string): void {
    this.db
      .prepare('UPDATE tasks SET locked_by = NULL, lock_expires_at = NULL WHERE id = ? AND locked_by = ?')
      .run(id, holder);
  }

  /** Tasks whose lock expired while still in progress — recovered by the scheduler. */
  findStaleLocks(now: number, limit = 50): Task[] {
    return this.db
      .prepare<[number, number], TaskRow>(
        `SELECT * FROM tasks
          WHERE status = 'in_progress' AND lock_expires_at IS NOT NULL AND lock_expires_at < ?
          ORDER BY lock_expires_at LIMIT ?`,
      )
      .all(now, limit)
      .map(mapTask);
  }

  /**
   * Tasks that are assigned, unblocked (all dependencies satisfied) and not
   * currently locked — the scheduler's ready queue.
   */
  findRunnable(workspaceId: string, limit = 25): Task[] {
    const candidates = this.db
      .prepare<[string, number], TaskRow>(
        `SELECT * FROM tasks
          WHERE workspace_id = ?
            AND status IN ('assigned','blocked')
            AND assignee IS NOT NULL
            AND (locked_by IS NULL OR lock_expires_at IS NULL OR lock_expires_at < ?)
          ORDER BY
            CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            created_at`,
      )
      .all(workspaceId, Date.now())
      .map(mapTask);

    const ready: Task[] = [];
    for (const task of candidates) {
      if (ready.length >= limit) break;
      if (this.dependenciesSatisfied(task)) ready.push(task);
    }
    return ready;
  }

  dependenciesSatisfied(task: Task): boolean {
    if (task.dependsOn.length === 0) return true;
    const deps = this.byIds(task.dependsOn);
    if (deps.length !== task.dependsOn.length) return false;
    return deps.every((d) => d.status === 'completed');
  }

  /** Dependencies that are not yet satisfied, for a human-readable block reason. */
  unmetDependencies(task: Task): Task[] {
    if (task.dependsOn.length === 0) return [];
    return this.byIds(task.dependsOn).filter((d) => d.status !== 'completed');
  }

  countByStatus(workspaceId: string): Record<TaskStatus, number> {
    const rows = this.db
      .prepare<[string], { status: TaskStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM tasks WHERE workspace_id = ? GROUP BY status',
      )
      .all(workspaceId);
    const out = {} as Record<TaskStatus, number>;
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  /** True when every task under an objective has reached a terminal state. */
  objectiveSettled(objectiveId: string): boolean {
    const rows = this.db
      .prepare<[string], { status: TaskStatus }>('SELECT status FROM tasks WHERE objective_id = ?')
      .all(objectiveId);
    return rows.every((r) => TERMINAL_TASK_STATUSES.includes(r.status));
  }

  /** Recovers locks left behind by a crashed process. */
  clearAllLocks(): number {
    return this.db
      .prepare('UPDATE tasks SET locked_by = NULL, lock_expires_at = NULL WHERE locked_by IS NOT NULL')
      .run().changes;
  }
}
