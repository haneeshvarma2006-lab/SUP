import type { User, Membership, Workspace, WorkspaceRole, WorkspaceSettings } from '@sup/shared';
import { DEFAULT_WORKSPACE_SETTINGS } from '@sup/shared';
import { fromJson, toJson, type Db, type DbHandle } from '../index.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  avatar_color: string;
  password_hash: string;
  password_salt: string;
  created_at: number;
}

export interface StoredUser extends User {
  passwordHash: string;
  passwordSalt: string;
}

function mapUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
  };
}

export function publicUser(user: StoredUser | User): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    createdAt: user.createdAt,
  };
}

export class UserRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(user: StoredUser): StoredUser {
    this.db
      .prepare(
        `INSERT INTO users (id, email, display_name, avatar_color, password_hash, password_salt, created_at)
         VALUES (@id, @email, @displayName, @avatarColor, @passwordHash, @passwordSalt, @createdAt)`,
      )
      .run(user);
    return user;
  }

  byId(id: string): StoredUser | null {
    const row = this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(id);
    return row ? mapUser(row) : null;
  }

  byEmail(email: string): StoredUser | null {
    const row = this.db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase());
    return row ? mapUser(row) : null;
  }

  byIds(ids: string[]): StoredUser[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare<string[], UserRow>(`SELECT * FROM users WHERE id IN (${placeholders})`)
      .all(...ids)
      .map(mapUser);
  }

  updateProfile(id: string, displayName: string): void {
    this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
  }
}

// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string | null;
}

export class SessionRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(session: SessionRecord): SessionRecord {
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
         VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt, @lastSeenAt, @userAgent)`,
      )
      .run(session);
    return session;
  }

  byTokenHash(tokenHash: string): SessionRecord | null {
    const row = this.db
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE token_hash = ?')
      .get(tokenHash);
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent,
    };
  }

  touch(id: string, at: number): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  revoke(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  revokeAllForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  purgeExpired(now: number): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes;
  }
}

// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_id: string;
  settings: string;
  event_seq: number;
  created_at: number;
  updated_at: number;
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...fromJson<Partial<WorkspaceSettings>>(row.settings, {}) },
  };
}

export class WorkspaceRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(workspace: Workspace): Workspace {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, slug, name, description, owner_id, settings, event_seq, created_at, updated_at)
         VALUES (@id, @slug, @name, @description, @ownerId, @settings, 0, @createdAt, @updatedAt)`,
      )
      .run({ ...workspace, settings: toJson(workspace.settings) });
    return workspace;
  }

  byId(id: string): Workspace | null {
    const row = this.db.prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?').get(id);
    return row ? mapWorkspace(row) : null;
  }

  bySlug(slug: string): Workspace | null {
    const row = this.db
      .prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE slug = ?')
      .get(slug);
    return row ? mapWorkspace(row) : null;
  }

  listForUser(userId: string): Array<Workspace & { role: WorkspaceRole }> {
    return this.db
      .prepare<[string], WorkspaceRow & { role: WorkspaceRole }>(
        `SELECT w.*, m.role AS role
         FROM workspaces w
         JOIN memberships m ON m.workspace_id = w.id
         WHERE m.user_id = ?
         ORDER BY w.created_at DESC`,
      )
      .all(userId)
      .map((row) => ({ ...mapWorkspace(row), role: row.role }));
  }

  listAll(): Workspace[] {
    return this.db
      .prepare<[], WorkspaceRow>('SELECT * FROM workspaces ORDER BY created_at')
      .all()
      .map(mapWorkspace);
  }

  update(id: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'settings'>>): Workspace | null {
    const current = this.byId(id);
    if (!current) return null;
    const next: Workspace = {
      ...current,
      ...patch,
      settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        'UPDATE workspaces SET name = ?, description = ?, settings = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.name, next.description, toJson(next.settings), next.updatedAt, id);
    return next;
  }

  /** Slug generator that resolves collisions by suffixing a counter. */
  uniqueSlug(base: string): string {
    let candidate = base;
    let n = 1;
    while (this.bySlug(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }
}

// ---------------------------------------------------------------------------

interface MembershipRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: number;
}

export class MembershipRepo {
  constructor(private readonly handle: DbHandle) {}

  private get db(): Db {
    return this.handle.db;
  }

  insert(membership: Membership): Membership {
    this.db
      .prepare(
        `INSERT INTO memberships (id, workspace_id, user_id, role, created_at)
         VALUES (@id, @workspaceId, @userId, @role, @createdAt)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(membership);
    return membership;
  }

  find(workspaceId: string, userId: string): Membership | null {
    const row = this.db
      .prepare<[string, string], MembershipRow>(
        'SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?',
      )
      .get(workspaceId, userId);
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
    };
  }

  listForWorkspace(workspaceId: string): Membership[] {
    return this.db
      .prepare<[string], MembershipRow>(
        'SELECT * FROM memberships WHERE workspace_id = ? ORDER BY created_at',
      )
      .all(workspaceId)
      .map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        role: row.role,
        createdAt: row.created_at,
      }));
  }

  setRole(workspaceId: string, userId: string, role: WorkspaceRole): void {
    this.db
      .prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?')
      .run(role, workspaceId, userId);
  }

  remove(workspaceId: string, userId: string): void {
    this.db
      .prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?')
      .run(workspaceId, userId);
  }
}
