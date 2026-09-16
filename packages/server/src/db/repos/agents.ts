import type { Agent, AgentRun, AgentStats, AgentStatus, RunStatus, RunStep, RunUsage } from '@sup/shared';
import { EMPTY_AGENT_STATS, EMPTY_RUN_USAGE } from '@sup/shared';
import { fromBool, fromJson, toBool, toJson, type Db, type DbHandle } from '../index.js';

interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  tagline: string;
  avatar_color: string;
  avatar_emoji: string;
  system_instructions: string;
  capabilities: string;
  model: string;
  temperature: number;
  status: AgentStatus;
  status_detail: string;
  current_task_id: string | null;
  current_run_id: string | null;
  max_concurrency: number;
  enabled: number;
  paused: number;
  is_orchestrator: number;
  stats: string;
  created_at: number;
  updated_at: number;
}

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
    tagline: row.tagline,
    avatarColor: row.avatar_color,
    avatarEmoji: row.avatar_emoji,
    systemInstructions: row.system_instructions,
    capabilities: fromJson<string[]>(row.capabilities, []),
    model: row.model,
    temperature: row.temperature,
    status: row.status,
    statusDetail: row.status_detail,
    currentTaskId: row.current_task_id,
    currentRunId: row.current_run_id,
    maxConcurrency: row.max_concurrency,
    enabled: toBool(row.enabled),
    paused: toBool(row.paused),
    isOrchestrator: toBool(row.is_orchestrator),
    stats: { ...EMPTY_AGENT_STATS, ...fromJson<Partial<AgentStats>>(row.stats, {}) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(agent: Agent): Agent {
    this.db
      .prepare(
        `INSERT INTO agents (
           id, workspace_id, name, role, tagline, avatar_color, avatar_emoji,
           system_instructions, capabilities, model, temperature, status, status_detail,
           current_task_id, current_run_id, max_concurrency, enabled, paused,
           is_orchestrator, stats, created_at, updated_at
         ) VALUES (
           @id, @workspaceId, @name, @role, @tagline, @avatarColor, @avatarEmoji,
           @systemInstructions, @capabilities, @model, @temperature, @status, @statusDetail,
           @currentTaskId, @currentRunId, @maxConcurrency, @enabled, @paused,
           @isOrchestrator, @stats, @createdAt, @updatedAt
         )`,
      )
      .run({
        ...agent,
        capabilities: toJson(agent.capabilities),
        stats: toJson(agent.stats),
        enabled: fromBool(agent.enabled),
        paused: fromBool(agent.paused),
        isOrchestrator: fromBool(agent.isOrchestrator),
      });
    return agent;
  }

  byId(id: string): Agent | null {
    const row = this.db.prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? mapAgent(row) : null;
  }

  listForWorkspace(workspaceId: string): Agent[] {
    return this.db
      .prepare<[string], AgentRow>(
        'SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_orchestrator DESC, created_at',
      )
      .all(workspaceId)
      .map(mapAgent);
  }

  orchestratorFor(workspaceId: string): Agent | null {
    const row = this.db
      .prepare<[string], AgentRow>(
        'SELECT * FROM agents WHERE workspace_id = ? AND is_orchestrator = 1',
      )
      .get(workspaceId);
    return row ? mapAgent(row) : null;
  }

  byNameInWorkspace(workspaceId: string, name: string): Agent | null {
    const row = this.db
      .prepare<[string, string], AgentRow>(
        'SELECT * FROM agents WHERE workspace_id = ? AND lower(name) = lower(?)',
      )
      .get(workspaceId, name);
    return row ? mapAgent(row) : null;
  }

  update(id: string, patch: Partial<Agent>): Agent | null {
    const current = this.byId(id);
    if (!current) return null;
    const next: Agent = { ...current, ...patch, id: current.id, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE agents SET
           name = @name, role = @role, tagline = @tagline, avatar_color = @avatarColor,
           avatar_emoji = @avatarEmoji, system_instructions = @systemInstructions,
           capabilities = @capabilities, model = @model, temperature = @temperature,
           status = @status, status_detail = @statusDetail, current_task_id = @currentTaskId,
           current_run_id = @currentRunId, max_concurrency = @maxConcurrency,
           enabled = @enabled, paused = @paused, is_orchestrator = @isOrchestrator,
           stats = @stats, updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...next,
        capabilities: toJson(next.capabilities),
        stats: toJson(next.stats),
        enabled: fromBool(next.enabled),
        paused: fromBool(next.paused),
        isOrchestrator: fromBool(next.isOrchestrator),
      });
    return next;
  }

  /**
   * Status writes go through their own statement so a status transition never
   * clobbers a concurrent edit to the agent's configuration.
   */
  setStatus(
    id: string,
    status: AgentStatus,
    detail: string,
    taskId: string | null,
    runId: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE agents SET status = ?, status_detail = ?, current_task_id = ?, current_run_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, detail, taskId, runId, Date.now(), id);
  }

  bumpStat(id: string, key: keyof AgentStats, by = 1): void {
    const agent = this.byId(id);
    if (!agent) return;
    const stats = { ...agent.stats, [key]: (agent.stats[key] ?? 0) + by };
    this.db
      .prepare('UPDATE agents SET stats = ?, updated_at = ? WHERE id = ?')
      .run(toJson(stats), Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  /** Reset transient state after a process restart — nothing is running yet. */
  resetTransientState(): number {
    return this.db
      .prepare(
        `UPDATE agents SET status = 'idle', status_detail = '', current_task_id = NULL, current_run_id = NULL
         WHERE status NOT IN ('idle', 'paused')`,
      )
      .run().changes;
  }
}

// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  task_id: string | null;
  status: RunStatus;
  depth: number;
  objective_id: string;
  attempt: number;
  idempotency_key: string;
  started_at: number;
  ended_at: number | null;
  error: string | null;
  result: string | null;
  usage: string;
}

interface StepRow {
  id: string;
  run_id: string;
  idx: number;
  kind: RunStep['kind'];
  summary: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  ok: number;
  duration_ms: number;
  created_at: number;
}

function mapStep(row: StepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    index: row.idx,
    kind: row.kind,
    summary: row.summary,
    toolName: row.tool_name,
    toolInput: fromJson<unknown>(row.tool_input, null),
    toolOutput: fromJson<unknown>(row.tool_output, null),
    ok: toBool(row.ok),
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

export class RunRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  private mapRun(row: RunRow, steps: RunStep[]): AgentRun {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      taskId: row.task_id,
      status: row.status,
      depth: row.depth,
      objectiveId: row.objective_id,
      attempt: row.attempt,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      error: row.error,
      result: row.result,
      usage: { ...EMPTY_RUN_USAGE, ...fromJson<Partial<RunUsage>>(row.usage, {}) },
      steps,
    };
  }

  /**
   * Inserts a run, or returns null when an identical run already exists.
   * The unique index on `idempotency_key` is what actually prevents a task
   * being executed twice by racing schedulers — the check is in the engine,
   * not in application code that could interleave.
   */
  insertIfAbsent(run: AgentRun, idempotencyKey: string): AgentRun | null {
    const info = this.db
      .prepare(
        `INSERT INTO agent_runs (
           id, workspace_id, agent_id, task_id, status, depth, objective_id, attempt,
           idempotency_key, started_at, ended_at, error, result, usage
         ) VALUES (
           @id, @workspaceId, @agentId, @taskId, @status, @depth, @objectiveId, @attempt,
           @idempotencyKey, @startedAt, @endedAt, @error, @result, @usage
         ) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run({
        ...run,
        idempotencyKey,
        usage: toJson(run.usage),
      });
    return info.changes > 0 ? run : null;
  }

  byId(id: string, withSteps = true): AgentRun | null {
    const row = this.db.prepare<[string], RunRow>('SELECT * FROM agent_runs WHERE id = ?').get(id);
    if (!row) return null;
    return this.mapRun(row, withSteps ? this.stepsFor(id) : []);
  }

  stepsFor(runId: string): RunStep[] {
    return this.db
      .prepare<[string], StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx')
      .all(runId)
      .map(mapStep);
  }

  listForAgent(agentId: string, limit = 25): AgentRun[] {
    return this.db
      .prepare<[string, number], RunRow>(
        'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?',
      )
      .all(agentId, limit)
      .map((row) => this.mapRun(row, []));
  }

  listForTask(taskId: string): AgentRun[] {
    return this.db
      .prepare<[string], RunRow>('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at')
      .all(taskId)
      .map((row) => this.mapRun(row, this.stepsFor(row.id)));
  }

  listActive(workspaceId: string): AgentRun[] {
    return this.db
      .prepare<[string], RunRow>(
        `SELECT * FROM agent_runs
         WHERE workspace_id = ? AND status IN ('queued','running','awaiting_approval','awaiting_human')
         ORDER BY started_at`,
      )
      .all(workspaceId)
      .map((row) => this.mapRun(row, []));
  }

  listForObjective(objectiveId: string): AgentRun[] {
    return this.db
      .prepare<[string], RunRow>(
        'SELECT * FROM agent_runs WHERE objective_id = ? ORDER BY started_at',
      )
      .all(objectiveId)
      .map((row) => this.mapRun(row, []));
  }

  setStatus(id: string, status: RunStatus): void {
    this.db.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run(status, id);
  }

  finish(
    id: string,
    status: RunStatus,
    patch: { result?: string | null; error?: string | null; usage: RunUsage },
  ): void {
    this.db
      .prepare(
        'UPDATE agent_runs SET status = ?, ended_at = ?, result = ?, error = ?, usage = ? WHERE id = ?',
      )
      .run(status, Date.now(), patch.result ?? null, patch.error ?? null, toJson(patch.usage), id);
  }

  appendStep(step: RunStep): RunStep {
    this.db
      .prepare(
        `INSERT INTO run_steps (id, run_id, idx, kind, summary, tool_name, tool_input, tool_output, ok, duration_ms, created_at)
         VALUES (@id, @runId, @index, @kind, @summary, @toolName, @toolInput, @toolOutput, @ok, @durationMs, @createdAt)`,
      )
      .run({
        ...step,
        toolInput: toJson(step.toolInput),
        toolOutput: toJson(step.toolOutput),
        ok: fromBool(step.ok),
      });
    return step;
  }

  /** Marks runs left mid-flight by a crashed process so they are not shown live. */
  failOrphaned(reason: string): number {
    return this.db
      .prepare(
        `UPDATE agent_runs SET status = 'failed', ended_at = ?, error = ?
         WHERE status IN ('queued','running')`,
      )
      .run(Date.now(), reason).changes;
  }
}
