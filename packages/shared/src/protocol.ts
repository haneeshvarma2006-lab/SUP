/**
 * Realtime wire protocol.
 *
 * Transport: a single WebSocket per browser tab, multiplexed over workspaces.
 * Delivery model: the server sends a `snapshot` (authoritative state + the seq
 * it was taken at), then a stream of `event` frames. Each frame carries the
 * workspace-monotonic `seq`. If a client observes a gap it sends `resume` with
 * the last seq it processed and the server replays the missing range from the
 * durable event log. That makes the stream gap-free and ordered without
 * requiring the transport itself to be reliable across reconnects.
 */

import type {
  Agent,
  AgentRun,
  ApprovalRequest,
  DelegationEdge,
  MemoryRecord,
  Message,
  PresenceEntry,
  Task,
  User,
  Workspace,
  WorkspaceFile,
  WorkspaceRole,
} from './entities.js';
import type { WorkspaceEvent } from './events.js';
import type { ToolDescriptor } from './tools.js';

/** Everything a client needs to render a workspace from cold. */
export interface WorkspaceSnapshot {
  workspace: Workspace;
  /** The seq this snapshot is consistent as of. */
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
  serverTime: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { t: 'hello'; token: string }
  | { t: 'subscribe'; workspaceId: string; sinceSeq?: number }
  | { t: 'unsubscribe'; workspaceId: string }
  | { t: 'resume'; workspaceId: string; fromSeq: number }
  | { t: 'presence'; workspaceId: string; focus: string | null }
  | { t: 'ping'; ts: number };

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type ServerFrame =
  | { t: 'ready'; userId: string; serverTime: number; protocolVersion: number }
  | { t: 'snapshot'; workspaceId: string; snapshot: WorkspaceSnapshot }
  | { t: 'event'; workspaceId: string; event: WorkspaceEvent }
  /** Replay batch answering a `resume`, ordered ascending by seq. */
  | { t: 'replay'; workspaceId: string; events: WorkspaceEvent[]; upToSeq: number }
  /**
   * The requested seq is older than the retained log — the client must take a
   * fresh snapshot rather than trying to patch forward.
   */
  | { t: 'resync_required'; workspaceId: string; reason: string }
  | { t: 'error'; code: string; message: string; workspaceId?: string }
  | { t: 'pong'; ts: number; serverTime: number };

export const PROTOCOL_VERSION = 1;

/** Frames the server will accept before the client has authenticated. */
export const PREAUTH_FRAMES: ReadonlySet<ClientFrame['t']> = new Set(['hello', 'ping']);
