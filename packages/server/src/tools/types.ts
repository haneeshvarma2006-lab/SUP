import type {
  ActorRef,
  Agent,
  AgentRun,
  DelegationEdge,
  Task,
  ToolDescriptor,
  ToolParameterSchema,
  Workspace,
} from '@sup/shared';
import type { EventBus } from '../events/eventBus.js';
import type { MemoryService } from '../memory/memoryService.js';
import type { Repositories } from '../db/repos/index.js';
import type { Logger } from '../util/logger.js';
import type { AppConfig } from '../config/index.js';

/** Result of a tool invocation. */
export interface ToolResult {
  ok: boolean;
  /**
   * What goes back to the model. Structured tools return JSON so the model (and
   * the heuristic policy) can parse rather than scrape.
   */
  content: string;
  /** One line for the activity feed and run timeline. */
  summary: string;
  /** Optional structured payload for the UI. */
  data?: unknown;
}

export function ok(summary: string, content: unknown, data?: unknown): ToolResult {
  return {
    ok: true,
    summary,
    content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    data,
  };
}

export function fail(summary: string, detail?: string): ToolResult {
  return {
    ok: false,
    summary,
    content: JSON.stringify({ error: summary, detail: detail ?? null }),
  };
}

/**
 * Everything a tool is allowed to touch.
 *
 * Tools never reach for globals — anything they need arrives here, which is
 * what makes them unit-testable and keeps the permission boundary meaningful.
 */
export interface ToolContext {
  workspace: Workspace;
  agent: Agent;
  run: AgentRun;
  task: Task | null;
  actor: ActorRef;
  objectiveId: string;
  /** Delegation depth of the current run. */
  depth: number;
  signal: AbortSignal;

  config: AppConfig;
  repos: Repositories;
  events: EventBus;
  memory: MemoryService;
  logger: Logger;

  /** Services injected late to avoid a circular import with the runtime. */
  services: ToolServices;

  /** Lets a tool that is about to block hand its scheduler slot back. */
  blocking: BlockingControl;
}

export interface BlockingControl {
  /**
   * Runs `fn` with this run's concurrency slot released, reacquiring it before
   * returning.
   *
   * Without this, an orchestrator waiting on a delegated child would hold a
   * slot the child needs, and a deep enough delegation chain would deadlock the
   * scheduler against its own descendants.
   */
  whileBlocked<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Operations tools need that live in higher layers. Declared as an interface so
 * the tool modules do not import the runtime (and the runtime can import them).
 */
export interface ToolServices {
  /** Creates a task and returns it. */
  createTask(input: {
    workspaceId: string;
    title: string;
    description: string;
    createdBy: ActorRef;
    assignee?: ActorRef | null;
    parentTaskId?: string | null;
    objectiveId?: string;
    dependsOn?: string[];
    depth?: number;
    priority?: Task['priority'];
    requiresHumanApproval?: boolean;
  }): Task;

  assignTask(input: {
    taskId: string;
    assignee: ActorRef;
    by: ActorRef;
  }): Task;

  updateTask(input: {
    taskId: string;
    by: ActorRef;
    patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'result' | 'error'>>;
  }): Task;

  /**
   * Delegates a task to another agent and waits for it to finish.
   *
   * The caller's concurrency slot is released while it blocks, so a chain of
   * delegations cannot deadlock the scheduler against its own children.
   */
  delegateAndWait(input: {
    ctx: ToolContext;
    toAgentId: string;
    title: string;
    description: string;
    dependsOn: string[];
    relation: 'delegate' | 'review' | 'ask';
    priority?: Task['priority'];
  }): Promise<{ taskId: string; ok: boolean; result: string; error: string | null }>;

  /** Posts a message into the workspace, applying the agent message rate limit. */
  postAgentMessage(input: {
    ctx: ToolContext;
    channel: string;
    body: string;
    recipient?: ActorRef | null;
    kind?: 'agent_to_agent' | 'chat' | 'result' | 'question' | 'system';
    /**
     * Records a new edge in the delegation graph for this message. Omit when
     * the caller already recorded one — otherwise the edge is counted twice and
     * the objective's delegation budget drains at double rate.
     */
    relation?: 'delegate' | 'review' | 'ask' | 'result';
    toAgentId?: string | null;
    /** Attach an edge the caller already recorded, without creating another. */
    existingEdge?: DelegationEdge | null;
  }): { ok: boolean; reason?: string };

  /** Asks a human a question and waits for a reply, or times out. */
  askHuman(input: {
    ctx: ToolContext;
    question: string;
    timeoutMs: number;
  }): Promise<{ answered: boolean; answer: string }>;

  /** Requests human approval for a sensitive action and waits for the verdict. */
  requestApproval(input: {
    ctx: ToolContext;
    action: string;
    reason: string;
    payload: unknown;
  }): Promise<{ approved: boolean; note: string }>;

  /** Writes a workspace file, enforcing path and size rules. */
  writeFile(input: {
    ctx: ToolContext;
    path: string;
    content: string;
    mimeType?: string;
  }): { fileId: string; path: string; version: number };

  /** Runs a web search through the configured provider. */
  webSearch(input: {
    query: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<{ results: Array<{ title: string; url: string; snippet: string }>; provider: string }>;

  /** Executes code in the sandbox. */
  executeCode(input: {
    language: string;
    source: string;
    stdin?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}

export interface Tool {
  descriptor: ToolDescriptor;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Terse helper for declaring a tool's JSON schema. */
export function schema(
  properties: ToolParameterSchema['properties'],
  required: string[] = [],
): ToolParameterSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

// -- input coercion ---------------------------------------------------------
// Models produce loosely-typed arguments. These readers normalise rather than
// throwing, so one sloppy argument does not abort an otherwise valid call.

export function readString(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function readNumber(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function readBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function readStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    // Models sometimes send a comma-joined string where an array was specified.
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
