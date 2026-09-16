/**
 * Role-based permissions, shared so the UI can grey out actions it knows the
 * server will refuse. The server is always the enforcement point; this module
 * is the single source of truth both sides import.
 */

import type { WorkspaceRole } from './entities.js';

export const PERMISSIONS = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'workspace:invite',
  'member:manage',
  'message:send',
  'agent:read',
  'agent:create',
  'agent:update',
  'agent:delete',
  'agent:control', // pause / resume / cancel
  'task:read',
  'task:create',
  'task:assign',
  'task:update',
  'task:cancel',
  'memory:read',
  'memory:write',
  'memory:delete',
  'file:read',
  'file:write',
  'file:delete',
  'approval:resolve',
  'feedback:give',
  'objective:start',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'workspace:read',
  'agent:read',
  'task:read',
  'memory:read',
  'file:read',
];

const MEMBER: Permission[] = [
  ...VIEWER,
  'message:send',
  'agent:create',
  'agent:update',
  'agent:control',
  'task:create',
  'task:assign',
  'task:update',
  'task:cancel',
  'memory:write',
  'memory:delete',
  'file:write',
  'approval:resolve',
  'feedback:give',
  'objective:start',
];

const ADMIN: Permission[] = [
  ...MEMBER,
  'workspace:update',
  'workspace:invite',
  'member:manage',
  'agent:delete',
  'file:delete',
];

const OWNER: Permission[] = [...ADMIN, 'workspace:delete'];

export const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly Permission[]> = {
  viewer: VIEWER,
  member: MEMBER,
  admin: ADMIN,
  owner: OWNER,
};

export function roleHasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

// ---------------------------------------------------------------------------
// Tool risk tiers
// ---------------------------------------------------------------------------

/**
 * `safe`     — read-only, no side effects outside the workspace.
 * `guarded`  — mutates workspace state; allowed but always audited.
 * `dangerous`— touches code execution or the outside world; gated on approval
 *              when the workspace requires it.
 */
export type ToolRisk = 'safe' | 'guarded' | 'dangerous';

export const TOOL_RISK_LABEL: Record<ToolRisk, string> = {
  safe: 'Read-only',
  guarded: 'Modifies workspace',
  dangerous: 'Requires approval',
};
