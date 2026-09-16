import type { DbHandle } from '../index.js';
import { MembershipRepo, SessionRepo, UserRepo, WorkspaceRepo } from './users.js';
import { AgentRepo, RunRepo } from './agents.js';
import { TaskRepo } from './tasks.js';
import { MessageRepo } from './messages.js';
import { EventRepo } from './events.js';
import { MemoryRepo } from './memory.js';
import { ApprovalRepo, DelegationRepo, FileRepo, ToolAuditRepo } from './files.js';

export * from './users.js';
export * from './agents.js';
export * from './tasks.js';
export * from './messages.js';
export * from './events.js';
export * from './memory.js';
export * from './files.js';

/** All repositories, constructed once and shared by every service. */
export interface Repositories {
  users: UserRepo;
  sessions: SessionRepo;
  workspaces: WorkspaceRepo;
  memberships: MembershipRepo;
  agents: AgentRepo;
  runs: RunRepo;
  tasks: TaskRepo;
  messages: MessageRepo;
  events: EventRepo;
  memories: MemoryRepo;
  files: FileRepo;
  approvals: ApprovalRepo;
  delegations: DelegationRepo;
  toolAudit: ToolAuditRepo;
}

export function createRepositories(handle: DbHandle): Repositories {
  return {
    users: new UserRepo(handle),
    sessions: new SessionRepo(handle),
    workspaces: new WorkspaceRepo(handle),
    memberships: new MembershipRepo(handle),
    agents: new AgentRepo(handle),
    runs: new RunRepo(handle),
    tasks: new TaskRepo(handle),
    messages: new MessageRepo(handle),
    events: new EventRepo(handle),
    memories: new MemoryRepo(handle),
    files: new FileRepo(handle),
    approvals: new ApprovalRepo(handle),
    delegations: new DelegationRepo(handle),
    toolAudit: new ToolAuditRepo(handle),
  };
}
