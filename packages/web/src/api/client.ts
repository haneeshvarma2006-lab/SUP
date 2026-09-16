import type {
  Agent,
  AgentRun,
  AgentTemplate,
  ApprovalRequest,
  DelegationEdge,
  FeedbackVerdict,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  Message,
  Task,
  ToolDescriptor,
  User,
  Workspace,
  WorkspaceFile,
  WorkspaceRole,
  WorkspaceSnapshot,
} from '@sup/shared';

const TOKEN_KEY = 'sup.token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let token: string | null = readStoredToken();

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private windows and blocked site data both throw here. The app still
    // works for the session; it just will not survive a reload.
    return null;
  }
}

export function getToken(): string | null {
  return token;
}

export function setToken(next: string | null): void {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Non-fatal, as above.
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: signal ?? null,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details: unknown } })?.error;
    if (response.status === 401) setToken(null);
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `Request failed (${response.status})`,
      error?.details ?? null,
    );
  }

  return payload as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
const del = <T>(path: string) => request<T>('DELETE', path);

export interface AuthResult {
  user: User;
  token: string;
  expiresAt: number;
}

export interface WorkspaceSummary extends Workspace {
  role: WorkspaceRole;
}

export interface HealthReport {
  status: string;
  uptimeSeconds: number;
  ai: { provider: string; displayName: string; isLanguageModel: boolean; note?: string };
  embeddings: { provider: string; semantic: boolean; dimensions: number };
  search: { provider: string; enabled: boolean };
  realtime: { connections: number };
  scheduler: { global: number; queued: number; inFlight: number };
}

export interface AgentDetail {
  agent: Agent;
  runs: AgentRun[];
  tasks: Task[];
  memories: MemoryRecord[];
  recentTools: Array<{
    id: string;
    toolName: string;
    outcome: string;
    durationMs: number;
    createdAt: number;
    error: string | null;
  }>;
  capabilities: ToolDescriptor[];
}

/** Typed wrapper over the HTTP API. One place that knows the route shapes. */
export const api = {
  // -- auth ------------------------------------------------------------------
  register: (input: { email: string; password: string; displayName: string }) =>
    post<AuthResult>('/api/auth/register', input),
  login: (input: { email: string; password: string }) => post<AuthResult>('/api/auth/login', input),
  logout: () => post<void>('/api/auth/logout'),
  me: () => get<{ user: User; workspaces: WorkspaceSummary[] }>('/api/auth/me'),

  // -- workspaces ------------------------------------------------------------
  listWorkspaces: () => get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
  createWorkspace: (input: { name: string; description?: string; roster?: string[] }) =>
    post<{ workspace: Workspace; agents: Agent[] }>('/api/workspaces', input),
  snapshot: (workspaceId: string) =>
    get<{ snapshot: WorkspaceSnapshot }>(`/api/workspaces/${workspaceId}`),
  workspaceStats: (workspaceId: string) =>
    get<Record<string, unknown>>(`/api/workspaces/${workspaceId}/stats`),
  inviteMember: (workspaceId: string, input: { email: string; role: WorkspaceRole }) =>
    post<unknown>(`/api/workspaces/${workspaceId}/members`, input),

  // -- agents ----------------------------------------------------------------
  agentTemplates: () => get<{ templates: AgentTemplate[] }>('/api/agent-templates'),
  tools: () => get<{ tools: ToolDescriptor[] }>('/api/tools'),
  createAgent: (workspaceId: string, input: Record<string, unknown>) =>
    post<{ agent: Agent }>(`/api/workspaces/${workspaceId}/agents`, input),
  agentDetail: (agentId: string, signal?: AbortSignal) =>
    get<AgentDetail>(`/api/agents/${agentId}`, signal),
  updateAgent: (agentId: string, input: Record<string, unknown>) =>
    patch<{ agent: Agent }>(`/api/agents/${agentId}`, input),
  deleteAgent: (agentId: string) => del<void>(`/api/agents/${agentId}`),
  pauseAgent: (agentId: string) => post<{ agent: Agent }>(`/api/agents/${agentId}/pause`),
  resumeAgent: (agentId: string) => post<{ agent: Agent }>(`/api/agents/${agentId}/resume`),
  stopAgent: (agentId: string, reason?: string) =>
    post<{ cancelledRuns: number }>(`/api/agents/${agentId}/stop`, { reason }),
  mentionAgent: (agentId: string, instruction: string) =>
    post<{ started: boolean }>(`/api/agents/${agentId}/mention`, { instruction }),
  agentRun: (agentId: string, runId: string) =>
    get<{ run: AgentRun }>(`/api/agents/${agentId}/runs/${runId}`),

  // -- tasks and objectives --------------------------------------------------
  createTask: (workspaceId: string, input: Record<string, unknown>) =>
    post<{ task: Task }>(`/api/workspaces/${workspaceId}/tasks`, input),
  taskDetail: (taskId: string) =>
    get<{
      task: Task;
      children: Task[];
      runs: AgentRun[];
      messages: Message[];
      artifacts: WorkspaceFile[];
    }>(`/api/tasks/${taskId}`),
  assignTask: (taskId: string, input: { agentId?: string; userId?: string }) =>
    post<{ task: Task }>(`/api/tasks/${taskId}/assign`, input),
  cancelTask: (taskId: string, reason?: string) =>
    post<{ cancelled: string[] }>(`/api/tasks/${taskId}/cancel`, { reason }),
  approveTask: (taskId: string, approved: boolean, note?: string) =>
    post<{ task: Task }>(`/api/tasks/${taskId}/approve`, { approved, note }),
  startObjective: (workspaceId: string, input: { title: string; description?: string }) =>
    post<{ objectiveId: string; task: Task }>(`/api/workspaces/${workspaceId}/objectives`, input),
  objectiveDetail: (workspaceId: string, objectiveId: string) =>
    get<{ root: Task; tasks: Task[]; delegations: DelegationEdge[]; runs: AgentRun[] }>(
      `/api/workspaces/${workspaceId}/objectives/${objectiveId}`,
    ),
  cancelObjective: (workspaceId: string, objectiveId: string) =>
    post<{ cancelledRuns: number }>(
      `/api/workspaces/${workspaceId}/objectives/${objectiveId}/cancel`,
    ),

  // -- collaboration ---------------------------------------------------------
  sendMessage: (workspaceId: string, input: { body: string; channel?: string; taskId?: string }) =>
    post<{ message: Message }>(`/api/workspaces/${workspaceId}/messages`, input),
  giveFeedback: (
    workspaceId: string,
    input: { verdict: FeedbackVerdict; comment: string; agentId?: string; taskId?: string },
  ) => post<{ message: Message; memory: MemoryRecord | null }>(
    `/api/workspaces/${workspaceId}/feedback`,
    input,
  ),

  searchMemory: (
    workspaceId: string,
    params: { q?: string; scope?: MemoryScope; kind?: MemoryKind; limit?: number },
  ) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.scope) search.set('scope', params.scope);
    if (params.kind) search.set('kind', params.kind);
    if (params.limit) search.set('limit', String(params.limit));
    return get<{ hits: MemorySearchHit[] }>(
      `/api/workspaces/${workspaceId}/memory?${search.toString()}`,
    );
  },
  createMemory: (workspaceId: string, input: Record<string, unknown>) =>
    post<{ record: MemoryRecord }>(`/api/workspaces/${workspaceId}/memory`, input),
  updateMemory: (memoryId: string, input: Record<string, unknown>) =>
    patch<{ record: MemoryRecord }>(`/api/memory/${memoryId}`, input),
  deleteMemory: (memoryId: string) => del<void>(`/api/memory/${memoryId}`),

  listFiles: (workspaceId: string) =>
    get<{ files: WorkspaceFile[] }>(`/api/workspaces/${workspaceId}/files`),
  readFile: (fileId: string) => get<{ file: WorkspaceFile }>(`/api/files/${fileId}`),

  listApprovals: (workspaceId: string) =>
    get<{ approvals: ApprovalRequest[] }>(`/api/workspaces/${workspaceId}/approvals`),
  resolveApproval: (approvalId: string, approved: boolean, note?: string) =>
    post<{ approval: ApprovalRequest }>(`/api/approvals/${approvalId}`, { approved, note }),

  health: () => get<HealthReport>('/api/health'),
};
