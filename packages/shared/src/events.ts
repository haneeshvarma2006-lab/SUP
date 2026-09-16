/**
 * The central event catalogue.
 *
 * Every meaningful state change in a workspace is published as one of these.
 * Events are the only thing the realtime layer ships to clients, and they are
 * persisted in an append-only log per workspace with a monotonic `seq`, so a
 * client that misses frames can replay deterministically from its last seq.
 */

import type {
  ActorRef,
  Agent,
  AgentRun,
  AgentStatus,
  ApprovalRequest,
  DelegationEdge,
  MemoryRecord,
  Message,
  PresenceEntry,
  RunStep,
  Task,
  Workspace,
  WorkspaceFile,
} from './entities.js';

export const EVENT_TYPES = [
  'USER_JOINED',
  'USER_LEFT',
  'USER_PRESENCE_UPDATED',
  'WORKSPACE_UPDATED',
  'AGENT_CREATED',
  'AGENT_UPDATED',
  'AGENT_DELETED',
  'AGENT_STATUS_CHANGED',
  'AGENT_STARTED',
  'AGENT_THINKING',
  'AGENT_STEP',
  'AGENT_FINISHED',
  'AGENT_ERROR',
  'AGENT_PAUSED',
  'AGENT_RESUMED',
  'AGENT_CANCELLED',
  'AGENT_MESSAGE',
  'AGENT_QUESTION',
  'TASK_CREATED',
  'TASK_ASSIGNED',
  'TASK_DELEGATED',
  'TASK_UPDATED',
  'TASK_STARTED',
  'TASK_BLOCKED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_CANCELLED',
  'TASK_REVIEW_REQUESTED',
  'PLAN_CREATED',
  'MESSAGE_CREATED',
  'USER_FEEDBACK',
  'MEMORY_CREATED',
  'MEMORY_UPDATED',
  'MEMORY_DELETED',
  'FILE_CREATED',
  'FILE_UPDATED',
  'FILE_DELETED',
  'TOOL_CALLED',
  'TOOL_RESULT',
  'TOOL_DENIED',
  'APPROVAL_REQUESTED',
  'APPROVAL_RESOLVED',
  'OBJECTIVE_STARTED',
  'OBJECTIVE_COMPLETED',
  'SYSTEM_NOTICE',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Payload shape for each event type. */
export interface EventPayloads {
  USER_JOINED: { user: PresenceEntry };
  USER_LEFT: { userId: string };
  USER_PRESENCE_UPDATED: { user: PresenceEntry };
  WORKSPACE_UPDATED: { workspace: Workspace };

  AGENT_CREATED: { agent: Agent };
  AGENT_UPDATED: { agent: Agent };
  AGENT_DELETED: { agentId: string };
  AGENT_STATUS_CHANGED: {
    agentId: string;
    status: AgentStatus;
    previousStatus: AgentStatus;
    detail: string;
    taskId: string | null;
    runId: string | null;
  };
  AGENT_STARTED: { agentId: string; runId: string; taskId: string | null; objectiveId: string };
  AGENT_THINKING: { agentId: string; runId: string; detail: string };
  AGENT_STEP: { agentId: string; runId: string; step: RunStep };
  AGENT_FINISHED: { agentId: string; run: AgentRun };
  AGENT_ERROR: { agentId: string; runId: string | null; message: string; retryable: boolean };
  AGENT_PAUSED: { agentId: string; by: ActorRef };
  AGENT_RESUMED: { agentId: string; by: ActorRef };
  AGENT_CANCELLED: { agentId: string; runId: string | null; by: ActorRef; reason: string };
  AGENT_MESSAGE: { message: Message; edge: DelegationEdge | null };
  AGENT_QUESTION: { message: Message; agentId: string; taskId: string | null };

  TASK_CREATED: { task: Task };
  TASK_ASSIGNED: { task: Task; assignee: ActorRef; by: ActorRef };
  TASK_DELEGATED: { task: Task; edge: DelegationEdge };
  TASK_UPDATED: { task: Task; changed: string[] };
  TASK_STARTED: { task: Task; runId: string };
  TASK_BLOCKED: { task: Task; reason: string };
  TASK_COMPLETED: { task: Task };
  TASK_FAILED: { task: Task; error: string };
  TASK_CANCELLED: { task: Task; by: ActorRef; reason: string };
  TASK_REVIEW_REQUESTED: { task: Task; reviewerId: string; edge: DelegationEdge };

  PLAN_CREATED: {
    objectiveId: string;
    rootTaskId: string;
    summary: string;
    tasks: Task[];
  };

  MESSAGE_CREATED: { message: Message };
  USER_FEEDBACK: {
    message: Message;
    verdict: FeedbackVerdict;
    targetAgentId: string | null;
    taskId: string | null;
    memoryId: string | null;
  };

  MEMORY_CREATED: { record: MemoryRecord };
  MEMORY_UPDATED: { record: MemoryRecord };
  MEMORY_DELETED: { memoryId: string };

  FILE_CREATED: { file: WorkspaceFile };
  FILE_UPDATED: { file: WorkspaceFile };
  FILE_DELETED: { fileId: string; path: string };

  TOOL_CALLED: {
    agentId: string;
    runId: string;
    toolName: string;
    callId: string;
    input: unknown;
  };
  TOOL_RESULT: {
    agentId: string;
    runId: string;
    toolName: string;
    callId: string;
    ok: boolean;
    summary: string;
    durationMs: number;
  };
  TOOL_DENIED: {
    agentId: string;
    runId: string | null;
    toolName: string;
    reason: string;
  };

  APPROVAL_REQUESTED: { approval: ApprovalRequest };
  APPROVAL_RESOLVED: { approval: ApprovalRequest };

  OBJECTIVE_STARTED: { objectiveId: string; title: string; requestedBy: ActorRef };
  OBJECTIVE_COMPLETED: {
    objectiveId: string;
    title: string;
    summary: string;
    rootTaskId: string;
    artifactIds: string[];
  };

  SYSTEM_NOTICE: { level: 'info' | 'warn' | 'error'; message: string; detail?: string };
}

export type FeedbackVerdict = 'approve' | 'reject' | 'correct' | 'comment';

/** A persisted, ordered workspace event. */
export interface WorkspaceEvent<T extends EventType = EventType> {
  id: string;
  /** Monotonic per workspace, assigned inside the write transaction. */
  seq: number;
  workspaceId: string;
  type: T;
  actor: ActorRef;
  payload: EventPayloads[T];
  /** Correlates all events produced by one agent run. */
  runId: string | null;
  taskId: string | null;
  /** Correlates everything serving one top-level objective. */
  objectiveId: string | null;
  createdAt: number;
}

/** Input accepted by the event bus before seq/id/timestamp are assigned. */
export interface EventDraft<T extends EventType = EventType> {
  type: T;
  actor: ActorRef;
  payload: EventPayloads[T];
  runId?: string | null;
  taskId?: string | null;
  objectiveId?: string | null;
}

/** Event types the activity feed renders by default (the rest are noise). */
export const ACTIVITY_FEED_EVENTS: readonly EventType[] = [
  'USER_JOINED',
  'USER_LEFT',
  'AGENT_CREATED',
  'AGENT_STARTED',
  'AGENT_FINISHED',
  'AGENT_ERROR',
  'AGENT_CANCELLED',
  'AGENT_PAUSED',
  'AGENT_RESUMED',
  'AGENT_MESSAGE',
  'AGENT_QUESTION',
  'TASK_CREATED',
  'TASK_ASSIGNED',
  'TASK_DELEGATED',
  'TASK_STARTED',
  'TASK_BLOCKED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'TASK_CANCELLED',
  'TASK_REVIEW_REQUESTED',
  'PLAN_CREATED',
  'USER_FEEDBACK',
  'MEMORY_CREATED',
  'FILE_CREATED',
  'FILE_UPDATED',
  'TOOL_CALLED',
  'TOOL_DENIED',
  'APPROVAL_REQUESTED',
  'APPROVAL_RESOLVED',
  'OBJECTIVE_STARTED',
  'OBJECTIVE_COMPLETED',
  'SYSTEM_NOTICE',
];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}
