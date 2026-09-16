import type { ActorRef, EventType, WorkspaceEvent } from '@sup/shared';
import { fromJson, toJson, type Db, type DbHandle } from '../index.js';

interface EventRow {
  id: string;
  workspace_id: string;
  seq: number;
  type: EventType;
  actor: string;
  payload: string;
  run_id: string | null;
  task_id: string | null;
  objective_id: string | null;
  created_at: number;
}

function mapEvent(row: EventRow): WorkspaceEvent {
  return {
    id: row.id,
    seq: row.seq,
    workspaceId: row.workspace_id,
    type: row.type,
    actor: fromJson<ActorRef>(row.actor, { type: 'system', id: 'system' }),
    payload: fromJson<never>(row.payload, {} as never),
    runId: row.run_id,
    taskId: row.task_id,
    objectiveId: row.objective_id,
    createdAt: row.created_at,
  };
}

export class EventRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  /**
   * Allocates the next sequence number and writes the event.
   *
   * MUST be called inside a transaction: the UPDATE..RETURNING on the workspace
   * row is what serialises sequence allocation, and if the INSERT that follows
   * is not in the same transaction a crash could burn a seq and leave a
   * permanent hole in the replay log.
   */
  appendInTransaction(
    workspaceId: string,
    event: Omit<WorkspaceEvent, 'seq'>,
  ): WorkspaceEvent {
    const row = this.db
      .prepare<[string], { event_seq: number }>(
        'UPDATE workspaces SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq',
      )
      .get(workspaceId);

    if (!row) throw new Error(`Cannot append event: workspace ${workspaceId} not found`);
    const seq = row.event_seq;

    this.db
      .prepare(
        `INSERT INTO events (id, workspace_id, seq, type, actor, payload, run_id, task_id, objective_id, created_at)
         VALUES (@id, @workspaceId, @seq, @type, @actor, @payload, @runId, @taskId, @objectiveId, @createdAt)`,
      )
      .run({
        ...event,
        seq,
        actor: toJson(event.actor),
        payload: toJson(event.payload),
      });

    return { ...event, seq } as WorkspaceEvent;
  }

  currentSeq(workspaceId: string): number {
    const row = this.db
      .prepare<[string], { event_seq: number }>('SELECT event_seq FROM workspaces WHERE id = ?')
      .get(workspaceId);
    return row?.event_seq ?? 0;
  }

  /** Ascending replay window, used to answer a client `resume`. */
  range(workspaceId: string, fromSeqExclusive: number, limit = 500): WorkspaceEvent[] {
    return this.db
      .prepare<[string, number, number], EventRow>(
        'SELECT * FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      )
      .all(workspaceId, fromSeqExclusive, limit)
      .map(mapEvent);
  }

  /** Most recent events, oldest-first, for the activity feed on cold load. */
  recent(workspaceId: string, limit = 300): WorkspaceEvent[] {
    return this.db
      .prepare<[string, number], EventRow>(
        'SELECT * FROM events WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?',
      )
      .all(workspaceId, limit)
      .map(mapEvent)
      .reverse();
  }

  byType(workspaceId: string, types: EventType[], limit = 100): WorkspaceEvent[] {
    if (types.length === 0) return [];
    const placeholders = types.map(() => '?').join(',');
    return this.db
      .prepare<unknown[], EventRow>(
        `SELECT * FROM events WHERE workspace_id = ? AND type IN (${placeholders})
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(workspaceId, ...types, limit)
      .map(mapEvent)
      .reverse();
  }

  forObjective(objectiveId: string, limit = 500): WorkspaceEvent[] {
    return this.db
      .prepare<[string, number], EventRow>(
        'SELECT * FROM events WHERE objective_id = ? ORDER BY seq ASC LIMIT ?',
      )
      .all(objectiveId, limit)
      .map(mapEvent);
  }

  /** Oldest retained seq — below this a client must resync rather than replay. */
  oldestSeq(workspaceId: string): number {
    const row = this.db
      .prepare<[string], { seq: number | null }>(
        'SELECT MIN(seq) AS seq FROM events WHERE workspace_id = ?',
      )
      .get(workspaceId);
    return row?.seq ?? 0;
  }

  /** Trims the log to the retention window, keeping the newest `keep` events. */
  prune(workspaceId: string, keep: number): number {
    return this.db
      .prepare(
        `DELETE FROM events WHERE workspace_id = ? AND seq <= (
           SELECT COALESCE(MAX(seq), 0) - ? FROM events WHERE workspace_id = ?
         )`,
      )
      .run(workspaceId, keep, workspaceId).changes;
  }
}
