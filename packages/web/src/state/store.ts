import {
  type Agent,
  type AgentRun,
  type ApprovalRequest,
  type DelegationEdge,
  type MemoryRecord,
  type Message,
  type PresenceEntry,
  type Task,
  type ToolDescriptor,
  type User,
  type Workspace,
  type WorkspaceEvent,
  type WorkspaceFile,
  type WorkspaceRole,
  type WorkspaceSnapshot,
} from '@sup/shared';
import type { ConnectionState } from '../api/realtime.js';

export interface WorkspaceState {
  workspace: Workspace;
  seq: number;
  viewer: { user: User; role: WorkspaceRole };
  members: Array<{ user: User; role: WorkspaceRole }>;
  presence: PresenceEntry[];
  agents: Agent[];
  tasks: Task[];
  messages: Message[];
  events: WorkspaceEvent[];
  memories: MemoryRecord[];
  files: WorkspaceFile[];
  approvals: ApprovalRequest[];
  delegations: DelegationEdge[];
  activeRuns: AgentRun[];
  tools: ToolDescriptor[];
  /** Tracks which agents are mid-step so the UI can pulse them. */
  liveSteps: Record<string, { summary: string; at: number }>;
  /**
   * Every human this client has seen, accumulated and never pruned.
   *
   * `members` is a snapshot and `presence` only holds people who are online
   * right now, so neither can name someone who joined after this client loaded
   * and has since closed their tab. Without this their messages would render as
   * a raw user id.
   */
  seenUsers: Record<string, { displayName: string; avatarColor: string }>;
}

export interface AppState {
  connection: ConnectionState;
  workspace: WorkspaceState | null;
  banner: { kind: 'error' | 'info'; message: string } | null;
}

const MAX_MESSAGES = 400;
const MAX_EVENTS = 600;

type Listener = () => void;

/**
 * Client-side projection of workspace state.
 *
 * The snapshot establishes a baseline; every subsequent change arrives as an
 * event and is folded in here. That means there is exactly one code path that
 * mutates the UI's model of the world, and it is the same path for a change
 * this user made and a change someone else made — so local actions and remote
 * ones cannot drift apart.
 */
export class Store {
  private state: AppState = { connection: 'closed', workspace: null, banner: null };
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.state;

  private set(next: Partial<AppState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  // -- lifecycle -------------------------------------------------------------

  setConnection(connection: ConnectionState): void {
    this.set({ connection });
  }

  setBanner(banner: AppState['banner']): void {
    this.set({ banner });
  }

  clearWorkspace(): void {
    this.set({ workspace: null });
  }

  applySnapshot(snapshot: WorkspaceSnapshot): void {
    this.set({
      workspace: {
        workspace: snapshot.workspace,
        seq: snapshot.seq,
        viewer: snapshot.viewer,
        members: snapshot.members,
        presence: snapshot.presence,
        agents: snapshot.agents,
        tasks: snapshot.tasks,
        messages: snapshot.messages,
        events: snapshot.events,
        memories: snapshot.memories,
        files: snapshot.files,
        approvals: snapshot.approvals,
        delegations: snapshot.delegations,
        activeRuns: snapshot.activeRuns,
        tools: snapshot.tools,
        liveSteps: {},
        seenUsers: Object.fromEntries(
          [...snapshot.members.map((m) => m.user), ...snapshot.presence.map((p) => ({
            id: p.userId,
            displayName: p.displayName,
            avatarColor: p.avatarColor,
          }))].map((u) => [u.id, { displayName: u.displayName, avatarColor: u.avatarColor }]),
        ),
      },
    });
  }

  applyEvents(events: WorkspaceEvent[]): void {
    if (!this.state.workspace || events.length === 0) return;
    let next = this.state.workspace;
    for (const event of events) next = reduce(next, event);
    this.set({ workspace: next });
  }

  applyEvent(event: WorkspaceEvent): void {
    this.applyEvents([event]);
  }
}

// ---------------------------------------------------------------------------
// The reducer: one event in, new workspace state out.
// ---------------------------------------------------------------------------

function reduce(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  const next: WorkspaceState = {
    ...state,
    seq: Math.max(state.seq, event.seq),
    events: [...state.events, event].slice(-MAX_EVENTS),
  };

  const p = event.payload as Record<string, unknown>;

  switch (event.type) {
    // -- presence ------------------------------------------------------------
    case 'USER_JOINED':
    case 'USER_PRESENCE_UPDATED': {
      const entry = p.user as PresenceEntry;
      return {
        ...next,
        presence: upsertBy(next.presence, entry, (u) => u.userId),
        seenUsers: {
          ...next.seenUsers,
          [entry.userId]: { displayName: entry.displayName, avatarColor: entry.avatarColor },
        },
      };
    }
    case 'USER_LEFT': {
      const userId = p.userId as string;
      return { ...next, presence: next.presence.filter((u) => u.userId !== userId) };
    }

    case 'WORKSPACE_UPDATED':
      return { ...next, workspace: p.workspace as Workspace };

    // -- agents --------------------------------------------------------------
    case 'AGENT_CREATED':
    case 'AGENT_UPDATED': {
      const agent = p.agent as Agent;
      return { ...next, agents: upsertBy(next.agents, agent, (a) => a.id) };
    }
    case 'AGENT_DELETED': {
      const agentId = p.agentId as string;
      return { ...next, agents: next.agents.filter((a) => a.id !== agentId) };
    }
    case 'AGENT_STATUS_CHANGED': {
      const change = p as unknown as {
        agentId: string;
        status: Agent['status'];
        detail: string;
        taskId: string | null;
        runId: string | null;
      };
      return {
        ...next,
        agents: next.agents.map((a) =>
          a.id === change.agentId
            ? {
                ...a,
                status: change.status,
                statusDetail: change.detail,
                currentTaskId: change.taskId,
                currentRunId: change.runId,
              }
            : a,
        ),
      };
    }
    case 'AGENT_PAUSED':
      return setAgentFlag(next, p.agentId as string, { paused: true });
    case 'AGENT_RESUMED':
      return setAgentFlag(next, p.agentId as string, { paused: false });

    case 'AGENT_STEP': {
      const step = p as unknown as { agentId: string; step: { summary: string } };
      return {
        ...next,
        liveSteps: {
          ...next.liveSteps,
          [step.agentId]: { summary: step.step.summary, at: event.createdAt },
        },
      };
    }

    case 'AGENT_STARTED': {
      const started = p as unknown as { runId: string; agentId: string; taskId: string | null };
      return {
        ...next,
        activeRuns: upsertBy(
          next.activeRuns,
          {
            id: started.runId,
            agentId: started.agentId,
            taskId: started.taskId,
            status: 'running',
          } as AgentRun,
          (r) => r.id,
        ),
      };
    }

    case 'AGENT_FINISHED': {
      const finished = p.run as AgentRun;
      const { [finished.agentId]: _dropped, ...liveSteps } = next.liveSteps;
      return {
        ...next,
        activeRuns: next.activeRuns.filter((r) => r.id !== finished.id),
        liveSteps,
      };
    }

    // -- tasks ---------------------------------------------------------------
    case 'TASK_CREATED':
    case 'TASK_ASSIGNED':
    case 'TASK_DELEGATED':
    case 'TASK_UPDATED':
    case 'TASK_STARTED':
    case 'TASK_BLOCKED':
    case 'TASK_COMPLETED':
    case 'TASK_FAILED':
    case 'TASK_CANCELLED':
    case 'TASK_REVIEW_REQUESTED': {
      const task = p.task as Task;
      const edge = p.edge as DelegationEdge | undefined;
      return {
        ...next,
        tasks: upsertBy(next.tasks, task, (t) => t.id),
        delegations: edge?.id ? upsertBy(next.delegations, edge, (d) => d.id) : next.delegations,
      };
    }

    case 'PLAN_CREATED': {
      const tasks = (p.tasks as Task[]) ?? [];
      let merged = next.tasks;
      for (const task of tasks) merged = upsertBy(merged, task, (t) => t.id);
      return { ...next, tasks: merged };
    }

    // -- messages ------------------------------------------------------------
    case 'MESSAGE_CREATED':
    case 'AGENT_QUESTION': {
      const message = p.message as Message;
      return {
        ...next,
        messages: upsertBy(next.messages, message, (m) => m.id).slice(-MAX_MESSAGES),
      };
    }
    case 'AGENT_MESSAGE': {
      const message = p.message as Message;
      const edge = p.edge as DelegationEdge | null;
      return {
        ...next,
        messages: upsertBy(next.messages, message, (m) => m.id).slice(-MAX_MESSAGES),
        delegations: edge ? upsertBy(next.delegations, edge, (d) => d.id) : next.delegations,
      };
    }
    case 'USER_FEEDBACK': {
      const message = p.message as Message;
      return {
        ...next,
        messages: upsertBy(next.messages, message, (m) => m.id).slice(-MAX_MESSAGES),
      };
    }

    // -- memory --------------------------------------------------------------
    case 'MEMORY_CREATED':
    case 'MEMORY_UPDATED': {
      const record = p.record as MemoryRecord;
      return { ...next, memories: upsertBy(next.memories, record, (m) => m.id) };
    }
    case 'MEMORY_DELETED': {
      const memoryId = p.memoryId as string;
      return { ...next, memories: next.memories.filter((m) => m.id !== memoryId) };
    }

    // -- files ---------------------------------------------------------------
    case 'FILE_CREATED':
    case 'FILE_UPDATED': {
      const file = p.file as WorkspaceFile;
      return { ...next, files: upsertBy(next.files, file, (f) => f.id) };
    }
    case 'FILE_DELETED': {
      const fileId = p.fileId as string;
      return { ...next, files: next.files.filter((f) => f.id !== fileId) };
    }

    // -- approvals -----------------------------------------------------------
    case 'APPROVAL_REQUESTED': {
      const approval = p.approval as ApprovalRequest;
      return { ...next, approvals: upsertBy(next.approvals, approval, (a) => a.id) };
    }
    case 'APPROVAL_RESOLVED': {
      const approval = p.approval as ApprovalRequest;
      // Resolved requests leave the pending queue but stay in the event feed.
      return { ...next, approvals: next.approvals.filter((a) => a.id !== approval.id) };
    }

    default:
      return next;
  }
}

function setAgentFlag(state: WorkspaceState, agentId: string, patch: Partial<Agent>): WorkspaceState {
  return {
    ...state,
    agents: state.agents.map((a) => (a.id === agentId ? { ...a, ...patch } : a)),
  };
}

/** Replaces an item with the same key, or appends it. Preserves order. */
function upsertBy<T>(list: T[], item: T, key: (item: T) => string): T[] {
  const id = key(item);
  const index = list.findIndex((existing) => key(existing) === id);
  if (index < 0) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}

export const store = new Store();
