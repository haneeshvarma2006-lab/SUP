/**
 * Core domain entities shared between the server, the realtime protocol and the UI.
 *
 * These are plain data shapes. Behaviour lives in the server services; the UI
 * treats them as read-only projections of authoritative server state.
 */

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** Everything that can act in a workspace is one of these. */
export type ActorType = 'user' | 'agent' | 'system';

export interface ActorRef {
  type: ActorType;
  id: string;
  /** Denormalised for display; never trusted for authorization. */
  name?: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  /** Hex colour used for the generated avatar. */
  avatarColor: string;
  createdAt: number;
}

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Membership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: number;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  settings: WorkspaceSettings;
}

export interface WorkspaceSettings {
  /** Hard ceiling on agents executing at the same time in this workspace. */
  maxConcurrentAgentRuns: number;
  /** Maximum depth of agent -> agent delegation before the chain is refused. */
  maxDelegationDepth: number;
  /** Total delegations allowed for one top-level objective. */
  maxDelegationsPerObjective: number;
  /** Tool calls a single agent run may make before it is forced to conclude. */
  maxStepsPerRun: number;
  /** When true, tools flagged `requiresApproval` block on a human decision. */
  requireApprovalForDangerousTools: boolean;
  defaultModel: string;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  maxConcurrentAgentRuns: 4,
  maxDelegationDepth: 4,
  maxDelegationsPerObjective: 24,
  maxStepsPerRun: 12,
  requireApprovalForDangerousTools: true,
  defaultModel: 'claude-sonnet-5',
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Agent lifecycle states. Each one is written by the runtime at a real
 * transition point — there are no timer-driven or cosmetic states.
 */
export const AGENT_STATUSES = [
  'idle',
  'thinking',
  'working',
  'waiting',
  'asking',
  'delegating',
  'reviewing',
  'completed',
  'error',
  'paused',
  'cancelled',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Statuses that mean the runtime currently holds this agent. */
export const ACTIVE_AGENT_STATUSES: readonly AgentStatus[] = [
  'thinking',
  'working',
  'waiting',
  'asking',
  'delegating',
  'reviewing',
];

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  /** Free-form role label. New roles need no code change. */
  role: string;
  /** Short description shown in the participants rail. */
  tagline: string;
  avatarColor: string;
  avatarEmoji: string;
  systemInstructions: string;
  /** Tool ids this agent is permitted to call. Enforced server-side. */
  capabilities: string[];
  model: string;
  temperature: number;
  status: AgentStatus;
  /** Human-readable summary of what the agent is doing right now. */
  statusDetail: string;
  currentTaskId: string | null;
  currentRunId: string | null;
  /** How many runs this agent may execute at once. */
  maxConcurrency: number;
  /** Disabled agents are visible but never scheduled. */
  enabled: boolean;
  /** True while a human has explicitly paused the agent. */
  paused: boolean;
  /** Set when the agent is the workspace coordinator. Exactly one per workspace. */
  isOrchestrator: boolean;
  createdAt: number;
  updatedAt: number;
  stats: AgentStats;
}

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  delegationsMade: number;
  toolCalls: number;
  feedbackPositive: number;
  feedbackNegative: number;
}

export const EMPTY_AGENT_STATS: AgentStats = {
  tasksCompleted: 0,
  tasksFailed: 0,
  delegationsMade: 0,
  toolCalls: 0,
  feedbackPositive: 0,
  feedbackNegative: 0,
};

/** A reusable blueprint a user can instantiate into a workspace agent. */
export interface AgentTemplate {
  key: string;
  name: string;
  role: string;
  tagline: string;
  avatarEmoji: string;
  avatarColor: string;
  systemInstructions: string;
  capabilities: string[];
  isOrchestrator?: boolean;
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Agent runs (one execution of an agent against a task)
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface AgentRun {
  id: string;
  workspaceId: string;
  agentId: string;
  taskId: string | null;
  status: RunStatus;
  /** Depth in the delegation chain; 0 for runs started by a human. */
  depth: number;
  /** Root objective this run ultimately serves — used for global budgets. */
  objectiveId: string;
  attempt: number;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  /** Final text the agent produced, if any. */
  result: string | null;
  usage: RunUsage;
  steps: RunStep[];
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  steps: number;
  modelCalls: number;
  provider: string;
  model: string;
}

export const EMPTY_RUN_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  steps: 0,
  modelCalls: 0,
  provider: '',
  model: '',
};

export type RunStepKind = 'reasoning' | 'tool_call' | 'tool_result' | 'message' | 'error';

export interface RunStep {
  id: string;
  runId: string;
  index: number;
  kind: RunStepKind;
  /** For reasoning/message: the text. For tool steps: a human summary. */
  summary: string;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  ok: boolean;
  durationMs: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'backlog',
  'assigned',
  'in_progress',
  'blocked',
  'awaiting_review',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses after which a task no longer consumes scheduler attention. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: ActorRef;
  assignee: ActorRef | null;
  /** Parent task when this was produced by decomposition. */
  parentTaskId: string | null;
  /** Root objective id — equals own id for top-level tasks. */
  objectiveId: string;
  /** Task ids that must reach a terminal success state before this can start. */
  dependsOn: string[];
  /** Depth in the decomposition tree. */
  depth: number;
  result: string | null;
  /** Free-form structured output an agent attached to the task. */
  resultData: unknown;
  error: string | null;
  /** Ids of artifacts produced while working this task. */
  artifactIds: string[];
  /** Optimistic-concurrency version; every mutation bumps it. */
  version: number;
  /** Agent/user holding the execution lock, if any. */
  lockedBy: string | null;
  lockExpiresAt: number | null;
  /** Set when a human must approve the result before the task closes. */
  requiresHumanApproval: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageKind =
  | 'chat'
  | 'agent_to_agent'
  | 'system'
  | 'result'
  | 'question'
  | 'feedback';

export interface Message {
  id: string;
  workspaceId: string;
  /** `main`, `task:<taskId>` or `dm:<a>:<b>` (ids sorted). */
  channel: string;
  author: ActorRef;
  /** When set, the message was addressed to a specific participant. */
  recipient: ActorRef | null;
  kind: MessageKind;
  body: string;
  /** Actor refs extracted from @mentions in the body. */
  mentions: ActorRef[];
  taskId: string | null;
  runId: string | null;
  /** Thread parent. */
  parentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  editedAt: number | null;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Memory scopes. `short_term` is conversation/task working context, the rest
 * are durable. Nothing here implies the underlying model is being retrained —
 * memory is retrieved and injected into prompts at run time.
 */
export const MEMORY_SCOPES = ['short_term', 'project', 'agent', 'episodic'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = [
  'fact',
  'preference',
  'decision',
  'feedback',
  'episode',
  'artifact',
  'constraint',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryRecord {
  id: string;
  workspaceId: string;
  scope: MemoryScope;
  kind: MemoryKind;
  /** Set for `agent`-scoped memory. */
  agentId: string | null;
  /** Set when the memory is tied to a specific task. */
  taskId: string | null;
  title: string;
  content: string;
  tags: string[];
  /** 0..1 — drives retrieval ranking and pruning order. */
  importance: number;
  /** Pinned memories are always eligible for retrieval and never auto-pruned. */
  pinned: boolean;
  createdBy: ActorRef;
  /** Where it came from, e.g. `feedback`, `run:<id>`, `manual`. */
  source: string;
  /** Number of times this memory has been retrieved into a prompt. */
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  score: number;
  /** Component scores, for the memory inspector. */
  breakdown: {
    semantic: number;
    keyword: number;
    importance: number;
    recency: number;
  };
}

// ---------------------------------------------------------------------------
// Files / artifacts
// ---------------------------------------------------------------------------

export interface WorkspaceFile {
  id: string;
  workspaceId: string;
  /** Virtual path inside the workspace, e.g. `reports/competitors.md`. */
  path: string;
  mimeType: string;
  size: number;
  /** Text content. Binary artifacts are out of scope for this storage tier. */
  content: string;
  version: number;
  createdBy: ActorRef;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Approvals (human-in-the-loop gate for sensitive actions)
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  /** Agent asking for permission. */
  requestedBy: ActorRef;
  runId: string | null;
  taskId: string | null;
  /** e.g. `tool:code_exec`. */
  action: string;
  reason: string;
  payload: unknown;
  status: ApprovalStatus;
  resolvedBy: ActorRef | null;
  resolutionNote: string;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export interface PresenceEntry {
  userId: string;
  displayName: string;
  avatarColor: string;
  connections: number;
  lastSeenAt: number;
  /** Optional coarse activity hint, e.g. `viewing:tasks`. */
  focus: string | null;
}

// ---------------------------------------------------------------------------
// Delegation graph (for the agent-communication visualisation)
// ---------------------------------------------------------------------------

export interface DelegationEdge {
  id: string;
  workspaceId: string;
  objectiveId: string;
  fromAgentId: string;
  toAgentId: string;
  taskId: string;
  /** `delegate`, `review`, `ask`, `result`. */
  relation: 'delegate' | 'review' | 'ask' | 'result';
  note: string;
  depth: number;
  createdAt: number;
}
