import type { ActorRef, ApprovalRequest, ApprovalStatus, DelegationEdge, WorkspaceFile } from '@sup/shared';
import { fromJson, toJson, type Db, type DbHandle } from '../index.js';

interface FileRow {
  id: string;
  workspace_id: string;
  path: string;
  mime_type: string;
  size: number;
  content: string;
  version: number;
  created_by: string;
  task_id: string | null;
  created_at: number;
  updated_at: number;
}

function mapFile(row: FileRow): WorkspaceFile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    mimeType: row.mime_type,
    size: row.size,
    content: row.content,
    version: row.version,
    createdBy: fromJson<ActorRef>(row.created_by, { type: 'system', id: 'system' }),
    taskId: row.task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FileRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  /** Writes a file, creating it or bumping the version of an existing path. */
  put(file: WorkspaceFile): { file: WorkspaceFile; created: boolean } {
    const existing = this.byPath(file.workspaceId, file.path);
    if (existing) {
      const next: WorkspaceFile = {
        ...existing,
        content: file.content,
        mimeType: file.mimeType,
        size: Buffer.byteLength(file.content, 'utf8'),
        version: existing.version + 1,
        taskId: file.taskId ?? existing.taskId,
        updatedAt: Date.now(),
      };
      this.db
        .prepare(
          `UPDATE files SET content = ?, mime_type = ?, size = ?, version = ?, task_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(next.content, next.mimeType, next.size, next.version, next.taskId, next.updatedAt, next.id);
      return { file: next, created: false };
    }

    const created: WorkspaceFile = { ...file, size: Buffer.byteLength(file.content, 'utf8') };
    this.db
      .prepare(
        `INSERT INTO files (id, workspace_id, path, mime_type, size, content, version, created_by, task_id, created_at, updated_at)
         VALUES (@id, @workspaceId, @path, @mimeType, @size, @content, @version, @createdBy, @taskId, @createdAt, @updatedAt)`,
      )
      .run({ ...created, createdBy: toJson(created.createdBy) });
    return { file: created, created: true };
  }

  byId(id: string): WorkspaceFile | null {
    const row = this.db.prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?').get(id);
    return row ? mapFile(row) : null;
  }

  byPath(workspaceId: string, path: string): WorkspaceFile | null {
    const row = this.db
      .prepare<[string, string], FileRow>('SELECT * FROM files WHERE workspace_id = ? AND path = ?')
      .get(workspaceId, path);
    return row ? mapFile(row) : null;
  }

  listForWorkspace(workspaceId: string, includeContent = false): WorkspaceFile[] {
    const cols = includeContent ? '*' : "id, workspace_id, path, mime_type, size, '' AS content, version, created_by, task_id, created_at, updated_at";
    return this.db
      .prepare<[string], FileRow>(`SELECT ${cols} FROM files WHERE workspace_id = ? ORDER BY path`)
      .all(workspaceId)
      .map(mapFile);
  }

  delete(id: string): WorkspaceFile | null {
    const file = this.byId(id);
    if (!file) return null;
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
    return file;
  }
}

// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  workspace_id: string;
  requested_by: string;
  run_id: string | null;
  task_id: string | null;
  action: string;
  reason: string;
  payload: string;
  status: ApprovalStatus;
  resolved_by: string | null;
  resolution_note: string;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}

function mapApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestedBy: fromJson<ActorRef>(row.requested_by, { type: 'system', id: 'system' }),
    runId: row.run_id,
    taskId: row.task_id,
    action: row.action,
    reason: row.reason,
    payload: fromJson<unknown>(row.payload, null),
    status: row.status,
    resolvedBy: fromJson<ActorRef | null>(row.resolved_by, null),
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}

export class ApprovalRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(approval: ApprovalRequest): ApprovalRequest {
    this.db
      .prepare(
        `INSERT INTO approvals (id, workspace_id, requested_by, run_id, task_id, action, reason,
           payload, status, resolved_by, resolution_note, created_at, expires_at, resolved_at)
         VALUES (@id, @workspaceId, @requestedBy, @runId, @taskId, @action, @reason,
           @payload, @status, @resolvedBy, @resolutionNote, @createdAt, @expiresAt, @resolvedAt)`,
      )
      .run({
        ...approval,
        requestedBy: toJson(approval.requestedBy),
        payload: toJson(approval.payload),
        resolvedBy: approval.resolvedBy ? toJson(approval.resolvedBy) : null,
      });
    return approval;
  }

  byId(id: string): ApprovalRequest | null {
    const row = this.db.prepare<[string], ApprovalRow>('SELECT * FROM approvals WHERE id = ?').get(id);
    return row ? mapApproval(row) : null;
  }

  listPending(workspaceId: string): ApprovalRequest[] {
    return this.db
      .prepare<[string], ApprovalRow>(
        "SELECT * FROM approvals WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at",
      )
      .all(workspaceId)
      .map(mapApproval);
  }

  listRecent(workspaceId: string, limit = 50): ApprovalRequest[] {
    return this.db
      .prepare<[string, number], ApprovalRow>(
        'SELECT * FROM approvals WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(workspaceId, limit)
      .map(mapApproval);
  }

  /**
   * Resolves a pending approval. The `status = 'pending'` guard makes the
   * transition single-shot: two reviewers clicking at once cannot both win.
   */
  resolve(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: ActorRef | null,
    note: string,
  ): ApprovalRequest | null {
    const changed = this.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_by = ?, resolution_note = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, resolvedBy ? toJson(resolvedBy) : null, note, Date.now(), id).changes;
    return changed > 0 ? this.byId(id) : null;
  }

  expireOverdue(now: number): ApprovalRequest[] {
    const overdue = this.db
      .prepare<[number], ApprovalRow>(
        "SELECT * FROM approvals WHERE status = 'pending' AND expires_at < ?",
      )
      .all(now)
      .map(mapApproval);
    for (const approval of overdue) {
      this.resolve(approval.id, 'expired', null, 'Timed out waiting for a human decision');
    }
    return overdue;
  }
}

// ---------------------------------------------------------------------------

interface DelegationRow {
  id: string;
  workspace_id: string;
  objective_id: string;
  from_agent_id: string;
  to_agent_id: string;
  task_id: string;
  relation: DelegationEdge['relation'];
  note: string;
  depth: number;
  created_at: number;
}

function mapDelegation(row: DelegationRow): DelegationEdge {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    objectiveId: row.objective_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    taskId: row.task_id,
    relation: row.relation,
    note: row.note,
    depth: row.depth,
    createdAt: row.created_at,
  };
}

export class DelegationRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(edge: DelegationEdge): DelegationEdge {
    this.db
      .prepare(
        `INSERT INTO delegations (id, workspace_id, objective_id, from_agent_id, to_agent_id, task_id, relation, note, depth, created_at)
         VALUES (@id, @workspaceId, @objectiveId, @fromAgentId, @toAgentId, @taskId, @relation, @note, @depth, @createdAt)`,
      )
      .run(edge);
    return edge;
  }

  listForObjective(objectiveId: string): DelegationEdge[] {
    return this.db
      .prepare<[string], DelegationRow>(
        'SELECT * FROM delegations WHERE objective_id = ? ORDER BY created_at',
      )
      .all(objectiveId)
      .map(mapDelegation);
  }

  listForWorkspace(workspaceId: string, limit = 300): DelegationEdge[] {
    return this.db
      .prepare<[string, number], DelegationRow>(
        'SELECT * FROM delegations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(workspaceId, limit)
      .map(mapDelegation)
      .reverse();
  }

  /** Delegations issued under one objective — the budget counter. */
  countForObjective(objectiveId: string): number {
    const row = this.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM delegations WHERE objective_id = ? AND relation = 'delegate'",
      )
      .get(objectiveId);
    return row?.n ?? 0;
  }

  /** Directed edges under an objective, for cycle detection. */
  edgesForObjective(objectiveId: string): Array<{ from: string; to: string }> {
    return this.db
      .prepare<[string], { from_agent_id: string; to_agent_id: string }>(
        "SELECT from_agent_id, to_agent_id FROM delegations WHERE objective_id = ? AND relation IN ('delegate','review','ask')",
      )
      .all(objectiveId)
      .map((r) => ({ from: r.from_agent_id, to: r.to_agent_id }));
  }
}

// ---------------------------------------------------------------------------

export interface ToolAuditEntry {
  id: string;
  workspaceId: string;
  runId: string | null;
  agentId: string;
  toolName: string;
  input: unknown;
  outcome: 'ok' | 'error' | 'denied' | 'pending_approval';
  error: string | null;
  durationMs: number;
  createdAt: number;
}

export class ToolAuditRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(entry: ToolAuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO tool_audit (id, workspace_id, run_id, agent_id, tool_name, input, outcome, error, duration_ms, created_at)
         VALUES (@id, @workspaceId, @runId, @agentId, @toolName, @input, @outcome, @error, @durationMs, @createdAt)`,
      )
      .run({ ...entry, input: toJson(entry.input) });
  }

  listForAgent(agentId: string, limit = 50): ToolAuditEntry[] {
    return this.db
      .prepare<[string, number], Record<string, never>>(
        'SELECT * FROM tool_audit WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(agentId, limit)
      .map((row: Record<string, unknown>) => ({
        id: row.id as string,
        workspaceId: row.workspace_id as string,
        runId: row.run_id as string | null,
        agentId: row.agent_id as string,
        toolName: row.tool_name as string,
        input: fromJson<unknown>(row.input as string, null),
        outcome: row.outcome as ToolAuditEntry['outcome'],
        error: row.error as string | null,
        durationMs: row.duration_ms as number,
        createdAt: row.created_at as number,
      }));
  }

  /** Calls made by an agent since a timestamp — the tool rate limiter's input. */
  countSince(agentId: string, since: number): number {
    const row = this.db
      .prepare<[string, number], { n: number }>(
        'SELECT COUNT(*) AS n FROM tool_audit WHERE agent_id = ? AND created_at >= ?',
      )
      .get(agentId, since);
    return row?.n ?? 0;
  }
}
